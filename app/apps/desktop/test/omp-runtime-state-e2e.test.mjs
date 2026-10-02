/**
 * M5/T20-B1 end-to-end: the production mode/policy channel on the *real*
 * fixed patched OMP runtime, driven through the product's `wireOmpSessions`
 * composition, the product's host-tool adapter and capability loader, the
 * product gate, and a local fake provider. No paid or remote model is called.
 *
 * The scenario walks one persistent native session through
 * Agent → Plan → Goal → Agent → Plan, changing the host session row (mode,
 * effective permission resolved from `inherit` + the app default), the plugin
 * catalog (add/remove/re-add), a declared plan-safe action list, and user MCP
 * visibility between prompts. For every prompt it asserts, against the
 * provider's actual request:
 *
 *   - the tool table is strictly equal (order included, no extra/duplicate/
 *     stale entries) to the test's independent PI-contract expectation;
 *   - the system prompt is a single message whose native prefix is untouched,
 *     carrying the capability block (when present) and exactly one production
 *     `composeModeSystemPrompt(mode, "")` block, with no PI default base;
 *   - the witness extension's per-attempt log shows the first clamp/restore
 *     costs one policy retry (2 attempts) and stable prompts cost one.
 *
 * A final phase drives a `write` approval through the real gate and observes
 * the effective permission mode on the raw dialog descriptor (resolved
 * `inherit` → app default), and a `task` subagent probe proves a delegate
 * session receives zero desktop mode/skill/memory injection.
 */
import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { preparePatchedTree } = await import("../../../scripts/omp-patch.mjs");
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const {
  OmpRuntimeSupervisor,
  ensureSessionStateDir,
  findGateExtension,
} = await import("../../../packages/omp-runtime/src/index.ts");
const { wireOmpSessions } = await import("../electron/main/runtime/omp-session-wiring.ts");
const { createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts");
const { createOmpDesktopCapabilities } = await import("../electron/main/runtime/omp-desktop-capabilities.ts");
const { composeModeSystemPrompt } = await import("../../../packages/agent-runtime/src/mode-prompts.ts");
const { parseApprovalDescriptor } = await import("../../../packages/omp-runtime/src/session/approval-protocol.ts");
const {
  MEMORY_MARKER,
  SKILL_CATALOG_MARKER,
  assertModePromptShape,
  occurrences,
  requestSystemText,
} = await import("./helpers/mode-prompt-assertions.mjs");

const GATE = findGateExtension(here);
const WITNESS = join(here, "fixtures", "omp-runtime-state-witness.ts");
const MUTATOR = join(here, "fixtures", "omp-state-mutator.ts");
const BUN = join(homedir(), ".bun", "bin", "bun");

/** The PI contract's native allowlist, stated independently of the product. */
const CONTRACT_NATIVE_TOOLS = ["read", "grep", "glob", "bash", "ask", "new_context"];

/**
 * The pinned runtime's own Agent-mode top-level presentation for this
 * configuration, stated independently of any provider table the test reads
 * (the review's F4 counterexample: these must stay top-level across every
 * Agent prompt; the deferred builtins below must not be promoted into it by
 * the Plan/Goal clamp and its restore).
 */
const NATIVE_TOP_LEVEL = [
  "read",
  "bash",
  "edit",
  "ask",
  "eval",
  "glob",
  "grep",
  "task",
  "wait",
  "todo",
  "web_search",
  "write",
];

/** Builtins the default presentation keeps under `xd://` (enabled, not top-level). */
const DEFERRED_NATIVE = ["ast_edit", "debug", "lsp"];

/**
 * The Agent table a *fresh* runtime must expose for one catalog: the native
 * top-level set, then plugin tools in catalog order, then user MCP tools, then
 * the Skill host tool appended by the bridge.
 */
function agentBaseline(pluginNames, { mcp = ["mcp_alpha_lookup"], skill = true } = {}) {
  return [...NATIVE_TOP_LEVEL, ...pluginNames, ...mcp, ...(skill ? ["Skill"] : [])];
}

const scratch = [];
function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 60_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function envelopeTimeline(envelopes) {
  return envelopes
    .map((entry) => {
      const event = entry.event;
      const id = event.toolCallId ? ` ${event.toolCallId}` : "";
      return `${event.type}${id}`;
    })
    .join(" > ");
}

/** The names the provider actually received for one request. */
function requestToolNames(request) {
  return (request.body?.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string");
}

/** The first user message's text: the fake provider's own routing identity. */
function firstUserText(request) {
  const messages = request.body?.messages ?? [];
  const firstUser = messages.find((message) => message && typeof message === "object" && message.role === "user");
  return typeof firstUser?.content === "string" ? firstUser.content : JSON.stringify(firstUser?.content ?? "");
}

/** Strict sequence equality: missing, extra, reordered or duplicated entries all fail. */
function assertStrictSequence(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}: the provider tool table must strictly equal the expected sequence`);
}

/** The independent PI-contract expectation for one live selection. */
function contractExpected(liveNames, safePluginNames) {
  const allowed = new Set([...CONTRACT_NATIVE_TOOLS, ...safePluginNames]);
  return liveNames.filter((name) => allowed.has(name));
}

const SESSION = "session-b1";
/** The probe session whose state file is corrupted between write and gate read. */
const REFUSAL_SESSION = "session-b1-refusal";
const PROJECT_PROVIDER = "m1fake";
const PROJECT_MODEL = "local-model";

test(
  "M5/T20-B1 end-to-end: production mode/policy state and contract catalog on the patched runtime",
  { timeout: 900_000 },
  async (t) => {
    assert.ok(GATE, "the shipped tool gate must be present");
    assert.ok(existsSync(BUN), "Bun must be installed for the patched runtime");

    // --- The real fixed patched runtime -------------------------------------
    const prepared = await preparePatchedTree({ prepareBuild: true, keep: true });
    t.after(() => prepared.cleanup());
    for (const capability of [
      "rpc-host-tool-concurrency",
      "rpc-host-tool-sole-batch-policy",
      "agent-tool-result-terminate",
      "rpc-host-tool-result-terminate",
    ]) {
      assert.ok(
        prepared.manifest.capabilities.includes(capability),
        `the patched tree must carry the ${capability} capability`,
      );
    }
    const LAUNCHER = join(prepared.tree, "packages", "coding-agent", "scripts", "omp");
    assert.ok(existsSync(LAUNCHER), "the patched launcher must exist");

    // --- Scratch state -------------------------------------------------------
    const project = makeScratch("omp-b1-project-");
    const dataRoot = makeScratch("omp-b1-data-");
    const witnessLog = join(dataRoot, "witness.jsonl");
    const guardedPath = join(project, "guarded.txt");
    writeFileSync(guardedPath, "original\n");
    const sessionDir = ensureSessionStateDir(dataRoot);

    const provider = await FakeProvider.start({ model: PROJECT_MODEL });
    t.after(() => provider.close?.());

    // --- Production-shaped seams --------------------------------------------
    const pluginState = {
      tools: [],
      skills: [],
      userMcpTools: [],
    };
    const plugins = {
      getTools: () => pluginState.tools,
      getSkills: () => pluginState.skills,
      listLoaded: () => [],
      loadSkillBody: (id) => {
        throw new Error(`no body for ${id}`);
      },
    };
    const userMcp = {
      calls: [],
      toolsForProject: async () => pluginState.userMcpTools,
      callTool: async (name) => {
        userMcp.calls.push(name);
        return "mcp result";
      },
    };

    const hostSessions = new Map([
      [
        SESSION,
        {
          id: SESSION,
          mode: "agent",
          permissionMode: "inherit",
          providerId: PROJECT_PROVIDER,
          modelId: PROJECT_MODEL,
          projectPath: project,
          engineRef: null,
        },
      ],
      [
        REFUSAL_SESSION,
        {
          id: REFUSAL_SESSION,
          mode: "agent",
          permissionMode: "inherit",
          providerId: PROJECT_PROVIDER,
          modelId: PROJECT_MODEL,
          projectPath: project,
          engineRef: null,
        },
      ],
    ]);
    const hostSettings = { defaultPermissionMode: "accept-edits" };
    let projectMemory;
    const hostCalls = [];
    const fakeHost = {
      isAvailable: () => true,
      async call(method, params = {}) {
        hostCalls.push({ method, params });
        switch (method) {
          case "session.get":
            return { session: hostSessions.get(params.id) ?? null };
          case "settings.get":
            return { ...hostSettings };
          case "session.bindEngine": {
            const session = hostSessions.get(params.id);
            if (session) {
              session.engineRef = {
                nativeSessionId: params.nativeSessionId,
                nativeSessionPath: params.nativeSessionPath,
                adapterVersion: params.adapterVersion,
                runtimeVersion: params.runtimeVersion,
              };
            }
            return { ok: true };
          }
          case "session.configure": {
            const session = hostSessions.get(params.id);
            if (!session) throw Object.assign(new Error("NOT_FOUND: session"), { errorCode: "NOT_FOUND" });
            for (const key of ["mode", "providerId", "modelId", "thinkingLevel", "permissionMode"]) {
              if (params[key] !== undefined && params[key] !== null) session[key] = params[key];
            }
            return { session: { ...session } };
          }
          case "skills.active":
            return { skills: [] };
          case "project.group.context":
            return { context: projectMemory ? { memory: { content: projectMemory } } : null };
          case "project.memory.get":
            return { memory: { content: projectMemory ?? "" } };
          default:
            throw new Error(`unexpected host call: ${method}`);
        }
      },
    };

    const envelopes = [];
    const turnEnds = [];
    const supervisors = [];

    /**
     * One runtime factory seam for a bridge. `trusted` is the exact
     * `--trusted-extension` order (the handler order the runtime runs), so the
     * refusal probe can load its state mutator BEFORE the shipped gate.
     */
    function runtimeFactory({ dataRoot: root, stderrName, trusted, witness, extraEnv = {}, collect }) {
      return {
        launcher: LAUNCHER,
        launcherError: null,
        createSupervisor: ({ sessionDir: dir, modelSelector }) => {
          const stderrLog = join(root, stderrName);
          const supervisor = new OmpRuntimeSupervisor({
            dataRoot: root,
            launcherPath: LAUNCHER,
            expectedRuntimeVersion: "18.3.0",
            sessionDir: dir,
            args: [
              ...(modelSelector ? ["--model", modelSelector] : []),
              ...trusted.flatMap((extension) => ["--trusted-extension", extension]),
            ],
            extraEnv: { OMP_T20_B1_WITNESS: witness, PI_NO_TITLE: "1", ...extraEnv },
            spawnImpl: (options) => {
              const child = spawn(options.command, options.args, {
                cwd: options.cwd,
                env: options.env,
                stdio: ["pipe", "pipe", "pipe"],
                detached: true,
              });
              child.stderr.pipe(createWriteStream(stderrLog, { flags: "a" }));
              return child;
            },
            prepareRun: async (paths) => {
              writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: PROJECT_MODEL });
            },
            readyTimeoutMs: 60_000,
          });
          supervisor.setWorkingDirectory(project);
          collect.push(supervisor);
          return supervisor;
        },
      };
    }

    const engineRuntime = { gateExtension: GATE, ompRuntime: runtimeFactory({
      dataRoot,
      stderrName: "runtime-stderr.log",
      trusted: [GATE, WITNESS],
      witness: witnessLog,
      collect: supervisors,
    }) };

    const hostTools = createOmpHostToolAdapter({
      plugins,
      userMcp,
      pluginActiveInProject: () => true,
      loadBuiltinSkillBody: () => null,
      loadUserSkillBody: async () => null,
      activeUserSkills: async () => [],
    });
    const capabilities = createOmpDesktopCapabilities({
      host: () => fakeHost,
      plugins,
      pluginActiveInProject: () => true,
      activeUserSkills: async () => [],
    });

    const { bridge } = wireOmpSessions({
      dataRoot,
      host: () => fakeHost,
      engineRuntime,
      isPackaged: false,
      appPath: here,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      onTurnEnd: (info) => turnEnds.push(info),
      hostTools,
      capabilities,
    });
    t.after(() => bridge.dispose("b1 e2e finished").catch(() => undefined));

    // --- The refusal probe: a second session whose state is corrupted between
    // the bridge's atomic write and the gate's read (M5/T20-B1 F1/F2). --------
    const refusalDataRoot = makeScratch("omp-b1-refusal-data-");
    const refusalWitnessLog = join(refusalDataRoot, "witness.jsonl");
    const mutatorControl = join(refusalDataRoot, "mutator-control.json");
    const mutatorLog = join(refusalDataRoot, "mutator.jsonl");
    const refusalEnvelopes = [];
    const refusalTurnEnds = [];
    const refusalSupervisors = [];
    writeFileSync(mutatorControl, JSON.stringify({ action: "none" }));
    const refusalEngineRuntime = {
      gateExtension: GATE,
      ompRuntime: runtimeFactory({
        dataRoot: refusalDataRoot,
        stderrName: "runtime-stderr.log",
        trusted: [MUTATOR, GATE, WITNESS],
        witness: refusalWitnessLog,
        extraEnv: { OMP_T20_B1_MUTATOR: mutatorControl, OMP_T20_B1_MUTATOR_LOG: mutatorLog },
        collect: refusalSupervisors,
      }),
    };
    const refusalBridge = wireOmpSessions({
      dataRoot: refusalDataRoot,
      host: () => fakeHost,
      engineRuntime: refusalEngineRuntime,
      isPackaged: false,
      appPath: here,
      emitAgentEvent: (envelope) => refusalEnvelopes.push(envelope),
      onTurnEnd: (info) => refusalTurnEnds.push(info),
      hostTools,
      capabilities,
    }).bridge;
    t.after(() => refusalBridge.dispose("b1 refusal probe finished").catch(() => undefined));
    // Registered last on purpose: `t.after` hooks run in registration order,
    // so every supervisor is reclaimed before its scratch root is removed (a
    // live runtime recreates its `omp-sessions` directory otherwise).
    t.after(() => {
      for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    // --- Catalog fixtures ----------------------------------------------------
    const pluginTool = ({ fullName, name, risk, planSafeActions }) => ({
      fullName,
      pluginId: "demo",
      name,
      description: `${name} tool`,
      schema: { type: "object", properties: {} },
      risk,
      planSafeActions,
      execute: async () => "plugin result",
    });
    const INSPECT = pluginTool({ fullName: "plugin_demo_inspect", name: "inspect", risk: "low", planSafeActions: ["inspect"] });
    const PLAIN = pluginTool({ fullName: "plugin_demo_plain", name: "plain", risk: "medium", planSafeActions: [] });
    /** The same plugin tool with a declared plan-safe action list. */
    const PLAIN_SAFE = { ...PLAIN, planSafeActions: ["plain"] };
    const RUN = pluginTool({ fullName: "plugin_demo_run", name: "run", risk: "high", planSafeActions: ["run"] });
    const MCP_TOOL = {
      fullName: "mcp_alpha_lookup",
      serverId: "alpha",
      toolName: "lookup",
      description: "Lookup tool",
      schema: { type: "object", properties: {} },
    };
    const MCP_BETA = {
      fullName: "mcp_beta_echo",
      serverId: "beta",
      toolName: "echo",
      description: "Echo tool",
      schema: { type: "object", properties: {} },
    };
    pluginState.tools = [INSPECT, PLAIN];
    pluginState.userMcpTools = [MCP_TOOL];
    pluginState.skills = [
      { id: "demo.hello/release-notes", pluginId: "demo.hello", name: "Release notes", description: "Draft release notes." },
    ];
    projectMemory = "Use the staging database.";

    const witnessEntries = () => {
      if (!existsSync(witnessLog)) return [];
      return readFileSync(witnessLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };

    const turnIds = [];
    const promptAndWait = async (label, content, script, expectText) => {
      provider.script(script);
      const before = envelopes.length;
      const session = hostSessions.get(SESSION);
      const ref = session.engineRef;
      const started = await bridge.prompt({
        sessionId: SESSION,
        content,
        projectPath: project,
        providerId: PROJECT_PROVIDER,
        modelId: PROJECT_MODEL,
        thinkingLevel: null,
        nativeSessionId: ref?.nativeSessionId ?? null,
        nativeSessionPath: ref?.nativeSessionPath ?? null,
        adapterVersion: ref?.adapterVersion ?? null,
        runtimeVersion: ref?.runtimeVersion ?? null,
      });
      assert.equal(started.accepted, true, `${label}: the prompt must be accepted`);
      turnIds.push(started.turnId);
      const done = await waitFor(() => {
        const slice = envelopes.slice(before);
        return (
          slice.some(
            (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes(expectText),
          ) && slice.some((entry) => entry.event.type === "agent_end")
        );
      });
      assert.equal(done, true, `${label}: turn did not settle; timeline:\n${envelopeTimeline(envelopes)}`);
      return { request: provider.requests[provider.requests.length - 1], envelopes: envelopes.slice(before), turnId: started.turnId };
    };


    // --- Phase 1: Agent (catalog with plugin + MCP + Skill) ------------------
    pluginState.tools = [INSPECT, PLAIN];
    const p1 = await promptAndWait(
      "agent-1",
      "describe the workspace state",
      [{ text: "state described", finish: "stop" }],
      "state described",
    );
    // A fresh runtime exposes its own default presentation: the native
    // top-level set, then the desktop catalog (plugins, user MCP) and the
    // Skill tool appended by the bridge. This is the independent baseline
    // every later Agent prompt (including post-rebuild ones) must match.
    const S0 = requestToolNames(p1.request);
    assertStrictSequence(S0, agentBaseline(["plugin_demo_inspect", "plugin_demo_plain"]), "agent-1 (fresh Agent baseline)");
    assertModePromptShape({ label: "agent-1", systemText: requestSystemText(p1.request), mode: "agent", capabilityExpected: true });
    const p1Witness = witnessEntries().filter((entry) => entry.prompt === "describe the workspace state");
    assert.equal(p1Witness.length, 1, "an unchanged Agent prompt must start in one attempt");
    // The live enabled selection also contains the builtins the default
    // presentation keeps under `xd://`. They must stay deferred: the Plan/Goal
    // clamp must never promote them into the Agent top-level table.
    const E0 = p1Witness[0].activeTools;
    assert.ok(
      S0.every((name) => E0.includes(name)),
      `the provider table must be a subset of the active selection; active=${JSON.stringify(E0)}`,
    );
    for (const deferred of DEFERRED_NATIVE) {
      assert.ok(E0.includes(deferred), `the default Agent presentation must keep ${deferred} enabled`);
      assert.ok(!S0.includes(deferred), `${deferred} must stay deferred (xd://), never Agent top-level`);
    }
    const stateFile = () => join(supervisors[0].runRoot(), "desktop-state.json");
    const state1 = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(state1.mode, "agent");
    assert.equal(state1.permissionMode, "accept-edits", "inherit must resolve to the app default");
    assert.equal(state1.modeBlock, composeModeSystemPrompt("agent", ""));
    assert.deepEqual(
      state1.hostTools.map((tool) => [tool.name, tool.risk, tool.planSafeActions, tool.origin]),
      [
        ["plugin_demo_inspect", "low", ["inspect"], "plugin"],
        ["plugin_demo_plain", "medium", [], "plugin"],
        ["mcp_alpha_lookup", "low", [], "user-mcp"],
      ],
      "the policy table must mirror the registered catalog",
    );

    // --- Phase 2: Plan (contract clamp) --------------------------------------
    assert.equal((await bridge.configure(SESSION, { mode: "plan" })).ok, true);
    const planScript = [{ text: "plan drafted", finish: "stop" }];
    const p2 = await promptAndWait("plan-1", "draft a plan for the change", planScript, "plan drafted");
    const expectedP2 = contractExpected(E0, ["plugin_demo_inspect"]);
    assertStrictSequence(requestToolNames(p2.request), expectedP2, "plan-1");
    assert.ok(expectedP2.includes("plugin_demo_inspect"), "the declared safe plugin must stay contract-visible");
    assert.ok(!expectedP2.includes("plugin_demo_plain"), "an undeclared plugin must be hidden in Plan");
    assert.ok(!expectedP2.includes("mcp_alpha_lookup"), "user MCP must be hidden in Plan");
    assert.ok(!expectedP2.includes("Skill"), "the Skill tool must be hidden in Plan");
    assert.ok(!expectedP2.includes("ast_edit"), "a deferred builtin must not become contract-visible");
    assertModePromptShape({ label: "plan-1", systemText: requestSystemText(p2.request), mode: "plan", capabilityExpected: true });
    const p2Witness = witnessEntries().filter((entry) => entry.prompt === "draft a plan for the change");
    assert.equal(p2Witness.length, 2, "entering Plan must clamp in one policy retry");
    for (const hidden of ["write", "edit", "eval", "mcp_alpha_lookup", "Skill", "plugin_demo_plain"]) {
      assert.ok(
        !p2Witness[1].activeTools.includes(hidden),
        `${hidden} must be removed from the live selection in Plan; active=${JSON.stringify(p2Witness[1].activeTools)}`,
      );
    }
    for (const kept of ["read", "glob", "grep", "bash", "ask", "plugin_demo_inspect"]) {
      assert.ok(p2Witness[1].activeTools.includes(kept), `${kept} must stay contract-visible`);
    }

    // --- Phase 3: Goal with a real catalog change (add run, remove plain) ----
    assert.equal((await bridge.configure(SESSION, { mode: "goal" })).ok, true);
    pluginState.tools = [INSPECT, RUN];
    const p3 = await promptAndWait(
      "goal-1",
      "negotiate the goal contract",
      [{ text: "goal negotiated", finish: "stop" }],
      "goal negotiated",
    );
    const expectedP3 = [...expectedP2, "plugin_demo_run"];
    assertStrictSequence(requestToolNames(p3.request), expectedP3, "goal-1");
    assert.ok(!expectedP3.includes("plugin_demo_plain"), "a removed plugin tool must not linger");
    assertModePromptShape({ label: "goal-1", systemText: requestSystemText(p3.request), mode: "goal", capabilityExpected: true });
    const p3Witness = witnessEntries().filter((entry) => entry.prompt === "negotiate the goal contract");
    assert.ok(
      p3Witness.length >= 1 && p3Witness.length <= 2,
      `a real catalog/mode change must converge within one policy retry; attempts=${p3Witness.length}`,
    );
    assert.ok(
      p3Witness.at(-1).activeTools.includes("plugin_demo_run"),
      "the new safe plugin must join the clamp",
    );

    // --- Phase 4: back to Agent. The contract mode is left by rebuilding the
    // runtime process: the pinned runtime exposes no presentation-restore API
    // to extensions, so the replacement process re-applies its own default
    // Agent presentation over the same persisted native session. ------------
    assert.equal((await bridge.configure(SESSION, { mode: "agent" })).ok, true);
    hostSettings.defaultPermissionMode = "auto";
    const nativeIdentityBefore4 = hostSessions.get(SESSION).engineRef?.nativeSessionId ?? null;
    const p4 = await promptAndWait(
      "agent-2",
      "apply the change now",
      [{ text: "change applied", finish: "stop" }],
      "change applied",
    );
    const expectedP4 = agentBaseline(["plugin_demo_inspect", "plugin_demo_run"]);
    assertStrictSequence(requestToolNames(p4.request), expectedP4, "agent-2 (post-rebuild Agent baseline)");
    assertModePromptShape({ label: "agent-2", systemText: requestSystemText(p4.request), mode: "agent", capabilityExpected: true });
    for (const deferred of DEFERRED_NATIVE) {
      assert.ok(
        !requestToolNames(p4.request).includes(deferred),
        `${deferred} must stay deferred after leaving the contract mode`,
      );
    }
    // The rebuild keeps the persisted identity and the full history, and
    // replays nothing: every earlier user prompt appears exactly once, and the
    // new prompt was not sent twice.
    assert.equal(
      hostSessions.get(SESSION).engineRef?.nativeSessionId,
      nativeIdentityBefore4,
      "the rebuild must keep the same persisted native session identity",
    );
    const history4 = (p4.request.body?.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
    for (const earlier of ["describe the workspace state", "draft a plan for the change", "negotiate the goal contract"]) {
      assert.equal(
        history4.filter((text) => text.includes(earlier)).length,
        1,
        `the rebuilt runtime must carry ${JSON.stringify(earlier)} exactly once`,
      );
    }
    assert.equal(
      history4.filter((text) => text.includes("apply the change now")).length,
      1,
      "the rebuilt runtime must not replay the new prompt",
    );
    const p4Witness = witnessEntries().filter((entry) => entry.prompt === "apply the change now");
    assert.equal(p4Witness.length, 1, "the rebuilt runtime must start the Agent prompt in one attempt");
    const state4 = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(state4.permissionMode, "auto", "the changed app default must resolve on the next prompt");
    assert.equal(state4.mode, "agent");
    const E4 = p4Witness[0].activeTools;
    for (const deferred of DEFERRED_NATIVE) {
      assert.ok(E4.includes(deferred), `the rebuilt Agent process must keep ${deferred} enabled but deferred`);
      assert.ok(!expectedP4.includes(deferred), `${deferred} must not be promoted into the rebuilt Agent table`);
    }

    // --- Phase 4b: a user-MCP catalog change on the next Agent prompt --------
    pluginState.tools = [INSPECT, RUN];
    pluginState.userMcpTools = [MCP_BETA];
    const p4b = await promptAndWait(
      "agent-2b",
      "check the beta tool",
      [{ text: "beta checked", finish: "stop" }],
      "beta checked",
    );
    const expectedP4b = [...NATIVE_TOP_LEVEL, "plugin_demo_inspect", "plugin_demo_run", "Skill", "mcp_beta_echo"];
    assertStrictSequence(requestToolNames(p4b.request), expectedP4b, "agent-2b (user MCP replaced)");
    assert.ok(!requestToolNames(p4b.request).includes("mcp_alpha_lookup"), "a removed user MCP tool must not linger");
    assert.equal(
      witnessEntries().filter((entry) => entry.prompt === "check the beta tool").length,
      1,
      "a catalog-only Agent change must start in one attempt",
    );

    // --- Phase 4c: the previous MCP server is re-added (remove/re-add) -------
    pluginState.userMcpTools = [MCP_BETA, MCP_TOOL];
    const p4c = await promptAndWait(
      "agent-2c",
      "check both MCP servers",
      [{ text: "both checked", finish: "stop" }],
      "both checked",
    );
    const expectedP4c = [
      ...NATIVE_TOP_LEVEL,
      "plugin_demo_inspect",
      "plugin_demo_run",
      "Skill",
      "mcp_beta_echo",
      "mcp_alpha_lookup",
    ];
    assertStrictSequence(requestToolNames(p4c.request), expectedP4c, "agent-2c (MCP re-added)");
    const E4c = witnessEntries().filter((entry) => entry.prompt === "check both MCP servers")[0].activeTools;

    // --- Phase 5: Plan again. A NEW plugin registered during Plan with a
    // declared plan-safe action list is contract-visible; flipping the list to
    // empty hides it again — and neither operation may cost it in Agent. -----
    assert.equal((await bridge.configure(SESSION, { mode: "plan" })).ok, true);
    pluginState.tools = [INSPECT, PLAIN_SAFE, RUN];
    const p5 = await promptAndWait(
      "plan-2",
      "reconsider the plan",
      [{ text: "plan reconsidered", finish: "stop" }],
      "plan reconsidered",
    );
    const expectedP5 = contractExpected([...E4c, "plugin_demo_plain"], [
      "plugin_demo_inspect",
      "plugin_demo_plain",
      "plugin_demo_run",
    ]);
    assertStrictSequence(requestToolNames(p5.request), expectedP5, "plan-2");
    assert.ok(expectedP5.includes("plugin_demo_plain"), "a plan-safe plugin registered during Plan must be visible");
    assert.ok(!expectedP5.includes("mcp_beta_echo"), "user MCP must stay hidden in Plan");
    assertModePromptShape({ label: "plan-2", systemText: requestSystemText(p5.request), mode: "plan", capabilityExpected: true });
    const p5Witness = witnessEntries().filter((entry) => entry.prompt === "reconsider the plan");
    assert.ok(
      p5Witness.length >= 1 && p5Witness.length <= 2,
      `entering Plan with a catalog change must converge within one retry; attempts=${p5Witness.length}`,
    );

    pluginState.tools = [INSPECT, PLAIN, RUN];
    const p5b = await promptAndWait(
      "plan-3",
      "tighten the plan contract",
      [{ text: "plan tightened", finish: "stop" }],
      "plan tightened",
    );
    const expectedP5b = expectedP5.filter((name) => name !== "plugin_demo_plain");
    assertStrictSequence(requestToolNames(p5b.request), expectedP5b, "plan-3 (safeActions removed)");
    assert.ok(!expectedP5b.includes("plugin_demo_plain"), "an empty plan-safe list must hide the plugin again in Plan");

    // --- Phase 6: back to Agent. The runtime is rebuilt once more — the
    // plan-safe plugin registered during Plan must be present with the
    // unchanged catalog (the review's F3 counterexample), and the deferred
    // builtins must be back under xd:// (F4). The approval descriptor must
    // carry the effective permission mode. -----------------------------------
    assert.equal((await bridge.configure(SESSION, { mode: "agent" })).ok, true);
    const expectedP6 = agentBaseline(
      ["plugin_demo_inspect", "plugin_demo_plain", "plugin_demo_run"],
      { mcp: ["mcp_beta_echo", "mcp_alpha_lookup"] },
    );
    // Warm-up turn: the rebuild happens on this prompt, so the raw-frame
    // observer below attaches to the replacement process.
    const p6a = await promptAndWait(
      "agent-3a",
      "warm up the rebuilt agent",
      [{ text: "warmed up", finish: "stop" }],
      "warmed up",
    );
    assertStrictSequence(requestToolNames(p6a.request), expectedP6, "agent-3a (post-rebuild Agent baseline)");
    assert.equal(
      witnessEntries().filter((entry) => entry.prompt === "warm up the rebuilt agent").length,
      1,
      "the rebuilt Agent process must start the prompt in one attempt",
    );
    const dialogs = [];
    const runtimeHandle = supervisors[0].currentRuntime();
    assert.ok(runtimeHandle, "the replacement runtime must be live");
    runtimeHandle.onFrame((frame) => {
      if (frame && frame.type === "extension_ui_request") dialogs.push(frame);
    });
    const writeCall = { id: "call_write_1", name: "write", args: { path: guardedPath, content: "written by b1\n" } };
    provider.script([
      { text: "writing the guarded file", finish: "tool_calls", toolCalls: [writeCall] },
      { text: "write finished", finish: "stop" },
    ]);
    const phase6Start = envelopes.length;
    const requestsBeforePhase6 = provider.requests.length;
    const phase6Ref = hostSessions.get(SESSION).engineRef;
    const phase6Prompt = await bridge.prompt({
      sessionId: SESSION,
      content: "write the guarded file",
      projectPath: project,
      providerId: PROJECT_PROVIDER,
      modelId: PROJECT_MODEL,
      thinkingLevel: null,
      nativeSessionId: phase6Ref?.nativeSessionId ?? null,
      nativeSessionPath: phase6Ref?.nativeSessionPath ?? null,
      adapterVersion: phase6Ref?.adapterVersion ?? null,
      runtimeVersion: phase6Ref?.runtimeVersion ?? null,
    });
    assert.equal(phase6Prompt.accepted, true, "agent-3: the prompt must be accepted");
    const approvalSeen = await waitFor(() =>
      envelopes.slice(phase6Start).some((entry) => entry.event.type === "tool_permission_request"),
    );
    assert.equal(approvalSeen, true, `agent-3: the approval must reach the desktop; timeline:\n${envelopeTimeline(envelopes)}`);
    const permissionEvent = envelopes
      .slice(phase6Start)
      .find((entry) => entry.event.type === "tool_permission_request");
    assert.equal(permissionEvent.event.request.toolName, "write");
    assert.equal(readFileSync(guardedPath, "utf8"), "original\n", "a pending approval must not execute the write");
    const approvalFrame = dialogs.find(
      (frame) => frame.method === "select" && JSON.stringify(frame).includes("omp-desktop-approval"),
    );
    assert.ok(approvalFrame, "the real gate must raise the approval dialog");
    const descriptor = parseApprovalDescriptor(approvalFrame.optionDetails?.[0]?.description);
    assert.equal(descriptor?.permissionMode, "auto", "the gate must consume the resolved effective permission mode");
    assert.equal(descriptor?.toolName, "write");
    // The rebuilt Agent table must be the fresh baseline with the unchanged
    // catalog: nothing duplicated, nothing stale, the plan-added plugin
    // present, and the deferred builtins not promoted.
    const p6Requests = provider.requests.slice(requestsBeforePhase6);
    assert.equal(p6Requests.length >= 1, true, "agent-3: the provider request must be captured");
    assertStrictSequence(requestToolNames(p6Requests[0]), expectedP6, "agent-3 (approval prompt)");
    assertModePromptShape({ label: "agent-3", systemText: requestSystemText(p6Requests[0]), mode: "agent", capabilityExpected: true });
    // Answer through the product's resolution path.
    assert.equal(bridge.resolvePermission(permissionEvent.event.request.requestId, "allow-once").ok, true);
    const executed = await waitFor(() => readFileSync(guardedPath, "utf8") === "written by b1\n");
    assert.equal(executed, true, "an allowed write must execute exactly once after approval");
    const settled = await waitFor(() =>
      envelopes.slice(phase6Start).some((entry) => {
        return (
          entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("write finished")
        );
      }) && envelopes.slice(phase6Start).some((entry) => entry.event.type === "agent_end"),
    );
    assert.equal(settled, true, `agent-3: the turn must settle; timeline:\n${envelopeTimeline(envelopes)}`);

    // --- Phase 7: a subagent session receives zero desktop injection ---------
    pluginState.tools = [INSPECT, PLAIN, RUN];
    const subagentMarker = "report ALPHA-7";
    provider.routeBySession({
      parent: [
        {
          text: "delegating",
          finish: "tool_calls",
          toolCalls: [
            {
              id: "call_task_1",
              name: "task",
              args: { context: "b1 subagent probe", tasks: [{ task: `${subagentMarker} and report`, agent: "task", name: "Scout1" }] },
            },
          ],
        },
        { text: "delegation finished", finish: "stop" },
      ],
      subagents: [{ marker: subagentMarker, turns: [{ text: "ALPHA-7 reported", finish: "stop" }] }],
    });
    const beforeSubagent = envelopes.length;
    const requestsBeforeSubagent = provider.requests.length;
    const ref = hostSessions.get(SESSION).engineRef;
    const subPrompt = await bridge.prompt({
      sessionId: SESSION,
      content: "delegate a quick reconnaissance",
      projectPath: project,
      providerId: PROJECT_PROVIDER,
      modelId: PROJECT_MODEL,
      thinkingLevel: null,
      nativeSessionId: ref?.nativeSessionId ?? null,
      nativeSessionPath: ref?.nativeSessionPath ?? null,
      adapterVersion: ref?.adapterVersion ?? null,
      runtimeVersion: ref?.runtimeVersion ?? null,
    });
    assert.equal(subPrompt.accepted, true);
    const subDone = await waitFor(() => {
      const slice = envelopes.slice(beforeSubagent);
      return (
        slice.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("delegation finished"),
        ) && slice.some((entry) => entry.event.type === "agent_end")
      );
    });
    assert.equal(subDone, true, `the delegated turn must settle; timeline:\n${envelopeTimeline(envelopes)}`);
    // A `task` spawn runs asynchronously: wait for the child's own provider
    // request and its own before_agent_start observation before asserting.
    const childSeen = await waitFor(
      () => provider.requests.some((request) => firstUserText(request).includes(subagentMarker)),
      60_000,
    );
    if (!childSeen) {
      const phase7 = provider.requests.slice(requestsBeforeSubagent).map((request) => ({
        firstUser: firstUserText(request).slice(0, 120),
        tools: requestToolNames(request).length,
      }));
      assert.fail(
        `the subagent provider request must be captured; phase7 requests=${JSON.stringify(phase7)} witness=${JSON.stringify(
          witnessEntries().filter((entry) => entry.sessionId !== state1.sessionId),
        )}`,
      );
    }
    const childRequests = provider.requests.filter((request) => firstUserText(request).includes(subagentMarker));
    const childWitnessed = await waitFor(
      () => witnessEntries().some((entry) => entry.sessionId !== state1.sessionId),
      30_000,
    );
    assert.equal(childWitnessed, true, "the witness must observe the delegate session's before_agent_start invocation");
    const parentRequests = provider.requests
      .slice(requestsBeforeSubagent)
      .filter((request) => !firstUserText(request).includes(subagentMarker));
    assert.equal(parentRequests.length >= 1, true, "the parent provider request must be captured");
    assertStrictSequence(
      requestToolNames(parentRequests[0]),
      expectedP6,
      "agent-4 (delegating prompt)",
    );
    for (const request of childRequests) {
      const systemText = requestSystemText(request);
      assert.equal(occurrences(systemText, composeModeSystemPrompt("agent", "")), 0, "a subagent must get no mode block");
      assert.equal(occurrences(systemText, composeModeSystemPrompt("plan", "")), 0, "a subagent must get no Plan block");
      assert.equal(
        occurrences(systemText, SKILL_CATALOG_MARKER),
        0,
        "a subagent must get no skill catalog",
      );
      assert.equal(
        occurrences(systemText, MEMORY_MARKER),
        0,
        "a subagent must get no project memory",
      );
    }
    const subagentWitness = witnessEntries().filter((entry) => entry.sessionId !== state1.sessionId);
    assert.ok(subagentWitness.length >= 1, "the delegate must fire under its own native session id");
    const parentWitness = witnessEntries().filter((entry) => entry.sessionId === state1.sessionId);
    assert.ok(parentWitness.length >= 1, "the parent session must be observed under its own native session id");
    assert.ok(
      parentWitness.every((entry) => entry.hasUI === true),
      "the rpc-ui parent session must report hasUI=true",
    );
    assert.ok(
      subagentWitness.every((entry) => entry.hasUI === false),
      "a delegate session must report hasUI=false (its extension runner runs without a UI context)",
    );
    assert.ok(
      !envelopes.slice(beforeSubagent).some((entry) => entry.event.type === "error"),
      "a delegate must never be refused by the mandatory state channel",
    );

    // --- Phase 8: an explicit restart still starts from the default baseline -
    const disposed = await bridge.disposeSession(SESSION, "b1 restart probe");
    assert.equal(disposed.ok, true, `the session runtime must be reclaimed cleanly: ${JSON.stringify(disposed.failures)}`);
    const restart = await promptAndWait(
      "agent-5",
      "confirm the restart baseline",
      [{ text: "restart confirmed", finish: "stop" }],
      "restart confirmed",
    );
    assertStrictSequence(requestToolNames(restart.request), expectedP6, "agent-5 (explicit restart baseline)");
    assertModePromptShape({ label: "agent-5", systemText: requestSystemText(restart.request), mode: "agent", capabilityExpected: true });
    const restartWitness = witnessEntries().filter((entry) => entry.prompt === "confirm the restart baseline");
    assert.equal(
      restartWitness.length,
      1,
      `a fresh runtime must start from the unclamped baseline in one attempt; attempts=${restartWitness.length}`,
    );

    // --- Phase 9: F1/F2 counterexamples. The refusal probe session has its
    // `desktop-state.required` marker set (its bridge carries a session
    // policy), so every state the gate cannot read as owned-and-valid must
    // refuse the turn: zero provider requests, exactly one observable terminal
    // error carrying the refused turn id, exactly one turn end, the runner
    // back to idle, and the session promptable again once the state is
    // repaired. ---------------------------------------------------------------
    const refusalTimeline = () => envelopeTimeline(refusalEnvelopes);
    const postRequests = () => provider.requests.filter((request) => request.method === "POST");
    const refusalRequest = async (content) => {
      const ref = hostSessions.get(REFUSAL_SESSION).engineRef;
      const started = await refusalBridge.prompt({
        sessionId: REFUSAL_SESSION,
        content,
        projectPath: project,
        providerId: PROJECT_PROVIDER,
        modelId: PROJECT_MODEL,
        thinkingLevel: null,
        nativeSessionId: ref?.nativeSessionId ?? null,
        nativeSessionPath: ref?.nativeSessionPath ?? null,
        adapterVersion: ref?.adapterVersion ?? null,
        runtimeVersion: ref?.runtimeVersion ?? null,
      });
      return started;
    };
    const mutatorEntries = () => {
      if (!existsSync(mutatorLog)) return [];
      return readFileSync(mutatorLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    const expectRefusal = async (label, action) => {
      writeFileSync(mutatorControl, JSON.stringify({ action }));
      provider.script([{ text: `${label} must never be answered`, finish: "stop" }]);
      const requestsBefore = postRequests().length;
      const envelopeBefore = refusalEnvelopes.length;
      const endsBefore = refusalTurnEnds.length;
      const started = await refusalRequest(label);
      assert.equal(
        started.accepted,
        true,
        `${label}: the prompt command is accepted; the refusal is delivered as the terminal error`,
      );
      const closed = await waitFor(
        () =>
          !refusalBridge.status(REFUSAL_SESSION).isRunning &&
          refusalEnvelopes.slice(envelopeBefore).some((entry) => entry.event.type === "error"),
      );
      assert.equal(closed, true, `${label}: the refused turn must reach a terminal state; timeline:\n${refusalTimeline()}`);
      const slice = refusalEnvelopes.slice(envelopeBefore);
      const errors = slice.filter((entry) => entry.event.type === "error");
      assert.equal(errors.length, 1, `${label}: exactly one terminal error`);
      assert.equal(
        errors[0].event.error.code,
        "OMP_RUNTIME_STATE_REFUSED",
        `${label}: the refusal must be observable as its own error code`,
      );
      assert.equal(errors[0].turnId, started.turnId, `${label}: the error must carry the refused turn id`);
      for (const forbidden of ["agent_start", "agent_end", "message_start", "tool_start"]) {
        assert.ok(!slice.some((entry) => entry.event.type === forbidden), `${label}: a refused turn must emit no ${forbidden}`);
      }
      const ends = refusalTurnEnds.slice(endsBefore).filter((info) => info.turnId === started.turnId);
      assert.deepEqual(
        ends,
        [{ sessionId: REFUSAL_SESSION, turnId: started.turnId, reason: "error" }],
        `${label}: exactly one turn end for the refused turn`,
      );
      assert.equal(refusalBridge.status(REFUSAL_SESSION).state, "idle", `${label}: the runner must return to idle`);
      assert.equal(postRequests().length, requestsBefore, `${label}: zero provider requests`);
      const applied = mutatorEntries().at(-1);
      assert.equal(applied?.action, action, `${label}: the mutator must have applied ${action}`);
      assert.equal(applied?.outcome, action === "delete" ? "deleted" : action, `${label}: mutator outcome`);
      assert.equal(applied?.hasUI, true, `${label}: the mutating context is the interactive parent`);
    };
    const expectNormalTurn = async (label, action) => {
      writeFileSync(mutatorControl, JSON.stringify({ action }));
      provider.script([{ text: `${label} answered`, finish: "stop" }]);
      const requestsBefore = postRequests().length;
      const envelopeBefore = refusalEnvelopes.length;
      const endsBefore = refusalTurnEnds.length;
      const started = await refusalRequest(label);
      assert.equal(started.accepted, true, `${label}: the prompt must be accepted`);
      const done = await waitFor(() => {
        const slice = refusalEnvelopes.slice(envelopeBefore);
        return (
          slice.some(
            (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes(`${label} answered`),
          ) && slice.some((entry) => entry.event.type === "agent_end")
        );
      });
      assert.equal(done, true, `${label}: the turn must settle; timeline:\n${refusalTimeline()}`);
      const slice = refusalEnvelopes.slice(envelopeBefore);
      assert.ok(!slice.some((entry) => entry.event.type === "error"), `${label}: a readable state must not produce an error`);
      assert.equal(postRequests().length, requestsBefore + 1, `${label}: the repaired state must reach the provider once`);
      const ends = refusalTurnEnds.slice(endsBefore).filter((info) => info.turnId === started.turnId);
      assert.deepEqual(
        ends,
        [{ sessionId: REFUSAL_SESSION, turnId: started.turnId, reason: "completed" }],
        `${label}: exactly one completed turn end`,
      );
      assert.equal(
        mutatorEntries().at(-1)?.outcome,
        action === "none" ? "none" : action,
        `${label}: the mutator outcome`,
      );
    };

    // The very FIRST prompt of the probe session is the deleted-state
    // counterexample: the bridge wrote the state, the mutator removed it, the
    // gate must refuse rather than run an unclamped Agent turn.
    await expectRefusal("refusal-first-delete", "delete");
    await expectNormalTurn("refusal-recover-1", "none");
    await expectRefusal("refusal-malformed", "malformed");
    await expectRefusal("refusal-oversize", "oversize");
    await expectNormalTurn("refusal-recover-2", "none");
    await expectRefusal("refusal-unknown-schema", "unknown-schema");
    await expectRefusal("refusal-identity-missing", "identity-missing");
    // F2: a parseable state whose owner is correct but whose mode is invalid —
    // the old gate aborted with no terminal signal and stranded the turn.
    await expectRefusal("refusal-owned-invalid", "owned-invalid");
    await expectNormalTurn("refusal-recover-3", "none");
    // Negative control: a forged refusal naming another native session, with
    // the state left valid, must not close the awaiting turn.
    await expectNormalTurn("refusal-foreign-notify", "foreign-notify");

    // No prompt ever needed the third start attempt (which would raise
    // `AgentStartPolicyChangedError`), and no turn id was ever reused across
    // the runtime rebuilds. The refusal witness log is checked the same way.
    const attemptsByPrompt = new Map();
    for (const entry of witnessEntries()) {
      if (typeof entry.prompt === "string" && entry.prompt.length > 0) {
        attemptsByPrompt.set(entry.prompt, (attemptsByPrompt.get(entry.prompt) ?? 0) + 1);
      }
    }
    for (const [prompt, attempts] of attemptsByPrompt) {
      assert.ok(attempts <= 2, `prompt ${JSON.stringify(prompt)} needed ${attempts} attempts`);
    }
    assert.equal(new Set(turnIds).size, turnIds.length, `live turn ids must never be reused: ${JSON.stringify(turnIds)}`);
  },
);
