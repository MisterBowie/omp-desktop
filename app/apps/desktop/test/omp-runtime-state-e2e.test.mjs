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
const BUN = join(homedir(), ".bun", "bin", "bun");

/** The PI contract's native allowlist, stated independently of the product. */
const CONTRACT_NATIVE_TOOLS = ["read", "grep", "glob", "bash", "ask", "new_context"];

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
    const supervisors = [];
    const engineRuntime = {
      gateExtension: GATE,
      ompRuntime: {
        launcher: LAUNCHER,
        launcherError: null,
        createSupervisor: ({ sessionDir: dir, modelSelector }) => {
          const stderrLog = join(dataRoot, "runtime-stderr.log");
          const supervisor = new OmpRuntimeSupervisor({
            dataRoot,
            launcherPath: LAUNCHER,
            expectedRuntimeVersion: "18.3.0",
            sessionDir: dir,
            args: [
              ...(modelSelector ? ["--model", modelSelector] : []),
              "--trusted-extension",
              GATE,
              "--trusted-extension",
              WITNESS,
            ],
            extraEnv: { OMP_T20_B1_WITNESS: witnessLog, PI_NO_TITLE: "1" },
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
          supervisors.push(supervisor);
          return supervisor;
        },
      },
    };

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
      hostTools,
      capabilities,
    });
    t.after(() => bridge.dispose("b1 e2e finished").catch(() => undefined));

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
    const RUN = pluginTool({ fullName: "plugin_demo_run", name: "run", risk: "high", planSafeActions: ["run"] });
    const MCP_TOOL = {
      fullName: "mcp_alpha_lookup",
      serverId: "alpha",
      toolName: "lookup",
      description: "Lookup tool",
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
      const done = await waitFor(() => {
        const slice = envelopes.slice(before);
        return (
          slice.some(
            (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes(expectText),
          ) && slice.some((entry) => entry.event.type === "agent_end")
        );
      });
      assert.equal(done, true, `${label}: turn did not settle; timeline:\n${envelopeTimeline(envelopes)}`);
      return { request: provider.requests[provider.requests.length - 1], envelopes: envelopes.slice(before) };
    };


    // --- Phase 1: Agent (catalog with plugin + MCP + Skill) ------------------
    pluginState.tools = [INSPECT, PLAIN];
    const p1 = await promptAndWait(
      "agent-1",
      "describe the workspace state",
      [{ text: "state described", finish: "stop" }],
      "state described",
    );
    const S0 = requestToolNames(p1.request);
    assert.ok(S0.includes("plugin_demo_inspect"), `the safe plugin tool must be active in Agent mode; got ${JSON.stringify(S0)}`);
    assert.ok(S0.includes("plugin_demo_plain"), "the undeclared plugin tool must be active in Agent mode");
    assert.ok(S0.includes("mcp_alpha_lookup"), "user MCP tools must be active in Agent mode");
    assert.ok(S0.includes("Skill"), "a non-empty skill catalog must register the Skill host tool");
    assertModePromptShape({ label: "agent-1", systemText: requestSystemText(p1.request), mode: "agent", capabilityExpected: true });
    const p1Witness = witnessEntries().filter((entry) => entry.prompt === "describe the workspace state");
    assert.equal(p1Witness.length, 1, "an unchanged Agent prompt must start in one attempt");
    // The live enabled selection (includes tools OMP demotes to xd:// discovery
    // in the default presentation). The gate's clamp/restore uses the only
    // selection API the extension surface offers (`setActiveTools` →
    // `setActiveToolsByName`), which pins every restored name top-level — the
    // same effect OMP's own interactive Plan mode has on `xd://` mounts
    // (`interactive-mode.ts` saves and restores the enabled list the same
    // way). E0 is the rule's input, so Agent-mode expectations below are
    // derived from it plus the catalog operations, never from the provider
    // table itself.
    const E0 = p1Witness[0].activeTools;
    assert.ok(
      S0.every((name) => E0.includes(name)),
      `the provider table must be a subset of the active selection; active=${JSON.stringify(E0)}`,
    );
    const stateFile = join(supervisors[0].runRoot(), "desktop-state.json");
    const state1 = JSON.parse(readFileSync(stateFile, "utf8"));
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
    const expectedP2 = contractExpected(S0, ["plugin_demo_inspect"]);
    assertStrictSequence(requestToolNames(p2.request), expectedP2, "plan-1");
    assert.ok(expectedP2.includes("plugin_demo_inspect"), "the declared safe plugin must stay contract-visible");
    assert.ok(!expectedP2.includes("plugin_demo_plain"), "an undeclared plugin must be hidden in Plan");
    assert.ok(!expectedP2.includes("mcp_alpha_lookup"), "user MCP must be hidden in Plan");
    assert.ok(!expectedP2.includes("Skill"), "the Skill tool must be hidden in Plan");
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

    // --- Phase 4: back to Agent; the clamp is restored, permission switches --
    assert.equal((await bridge.configure(SESSION, { mode: "agent" })).ok, true);
    hostSettings.defaultPermissionMode = "auto";
    const p4 = await promptAndWait(
      "agent-2",
      "apply the change now",
      [{ text: "change applied", finish: "stop" }],
      "change applied",
    );
    const expectedP4 = [...E0.filter((name) => name !== "plugin_demo_plain"), "plugin_demo_run"];
    assertStrictSequence(requestToolNames(p4.request), expectedP4, "agent-2");
    assert.ok(expectedP4.includes("mcp_alpha_lookup"), "Agent mode must restore user MCP visibility");
    assert.ok(expectedP4.includes("Skill"), "Agent mode must restore the Skill tool");
    assertModePromptShape({ label: "agent-2", systemText: requestSystemText(p4.request), mode: "agent", capabilityExpected: true });
    const p4Witness = witnessEntries().filter((entry) => entry.prompt === "apply the change now");
    assert.equal(p4Witness.length, 2, "leaving the contract clamp must cost one policy retry");
    for (const restored of ["write", "edit", "mcp_alpha_lookup", "Skill"]) {
      assert.ok(
        p4Witness[1].activeTools.includes(restored),
        `${restored} must be restored to the live selection in Agent; active=${JSON.stringify(p4Witness[1].activeTools)}`,
      );
    }
    const state4 = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state4.permissionMode, "auto", "the changed app default must resolve on the next prompt");
    assert.equal(state4.mode, "agent");

    // --- Phase 5: Plan again; re-added plugin is clamped out -----------------
    assert.equal((await bridge.configure(SESSION, { mode: "plan" })).ok, true);
    pluginState.tools = [INSPECT, PLAIN, RUN];
    const p5 = await promptAndWait(
      "plan-2",
      "reconsider the plan",
      [{ text: "plan reconsidered", finish: "stop" }],
      "plan reconsidered",
    );
    const expectedP5 = contractExpected(expectedP4, ["plugin_demo_inspect", "plugin_demo_run"]);
    assertStrictSequence(requestToolNames(p5.request), expectedP5, "plan-2");
    assert.ok(!expectedP5.includes("plugin_demo_plain"), "a re-added undeclared plugin must be hidden in Plan");
    assertModePromptShape({ label: "plan-2", systemText: requestSystemText(p5.request), mode: "plan", capabilityExpected: true });

    // --- Phase 6: approval descriptor carries the effective permission mode --
    assert.equal((await bridge.configure(SESSION, { mode: "agent" })).ok, true);
    const dialogs = [];
    const runtimeHandle = supervisors[0].currentRuntime();
    assert.ok(runtimeHandle, "the runtime must be live");
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
    // The clamps in between must leave no trace: the restored Agent table is
    // the pre-clamp selection, nothing duplicated, nothing stale. One runtime
    // rule shapes the order and is stated here independently: a `set_host_tools`
    // refresh re-seats the previously active RPC host tools after the non-RPC
    // names (previous active non-RPC, then preserved RPC in their previous
    // order, then newly activated RPC). The re-added undeclared plugin is the
    // newly activated one; every desktop host tool is an RPC host tool.
    const RPC_HOST_TOOLS = [
      "plugin_demo_inspect",
      "plugin_demo_plain",
      "plugin_demo_run",
      "mcp_alpha_lookup",
      "Skill",
    ];
    const expectedP6 = [
      ...E0.filter((name) => name !== "plugin_demo_plain" && !RPC_HOST_TOOLS.includes(name)),
      "plugin_demo_inspect",
      "mcp_alpha_lookup",
      "Skill",
      "plugin_demo_run",
      "plugin_demo_plain",
    ];
    const p6Requests = provider.requests.slice(requestsBeforePhase6);
    assert.equal(p6Requests.length >= 1, true, "agent-3: the provider request must be captured");
    assertStrictSequence(requestToolNames(p6Requests[0]), expectedP6, "agent-3");
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

    // --- Phase 8: a runtime restart resets the clamp baseline ----------------
    const disposed = await bridge.disposeSession(SESSION, "b1 restart probe");
    assert.equal(disposed.ok, true, `the session runtime must be reclaimed cleanly: ${JSON.stringify(disposed.failures)}`);
    const restart = await promptAndWait(
      "agent-5",
      "confirm the restart baseline",
      [{ text: "restart confirmed", finish: "stop" }],
      "restart confirmed",
    );
    // A fresh runtime starts from the default presentation: previously
    // xd-discoverable builtins are demoted again, and the host tools appear in
    // catalog order (plugins, then user MCP) with the Skill tool appended.
    const expectedRestart = [
      ...S0.filter((name) => name !== "mcp_alpha_lookup" && name !== "Skill"),
      "plugin_demo_run",
      "mcp_alpha_lookup",
      "Skill",
    ];
    assertStrictSequence(requestToolNames(restart.request), expectedRestart, "agent-5 (post-restart)");
    assertModePromptShape({ label: "agent-5", systemText: requestSystemText(restart.request), mode: "agent", capabilityExpected: true });
    const restartWitness = witnessEntries().filter((entry) => entry.prompt === "confirm the restart baseline");
    assert.equal(
      restartWitness.length,
      1,
      `a fresh runtime must start from the unclamped baseline in one attempt; attempts=${restartWitness.length}`,
    );

    // Every prompt converged within the runtime's single policy retry: no
    // prompt may need the third attempt (which would raise
    // `AgentStartPolicyChangedError` and fail the turn anyway).
    const attemptsByPrompt = new Map();
    for (const entry of witnessEntries()) {
      if (typeof entry.prompt === "string" && entry.prompt.length > 0) {
        attemptsByPrompt.set(entry.prompt, (attemptsByPrompt.get(entry.prompt) ?? 0) + 1);
      }
    }
    for (const [prompt, attempts] of attemptsByPrompt) {
      assert.ok(attempts <= 2, `prompt ${JSON.stringify(prompt)} needed ${attempts} attempts`);
    }
  },
);
