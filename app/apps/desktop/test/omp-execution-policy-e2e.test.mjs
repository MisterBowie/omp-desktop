/**
 * M5/T20-C end-to-end: the execution-time permission decision on the *real*
 * fixed patched OMP runtime, driven through the product's `wireOmpSessions`
 * composition, the product's host-tool adapter and gate, and a local fake
 * provider. No paid or remote model is called.
 *
 * Every scenario asserts both the decision the production gate reached (card
 * risk/mode/reason, or the absence of a card) and the observable side effect
 * count: a blocked call must leave the filesystem untouched, an allowed call
 * exactly once. Where a contract-forbidden native tool is hidden by the B1
 * catalog clamp, the attempt is exercised anyway and reported at the catalog
 * layer it actually reached (the gate-layer hard deny is proven by the
 * unit/compiled-gate tests, never claimed here).
 *
 * Layer labels used below:
 *   - "gate card" — a `tool_permission_request` envelope produced by the real
 *     gate running in the runtime process;
 *   - "gate block/no-ui" — a blocked tool result the provider actually
 *     received, containing the gate's reason;
 *   - "catalog layer" — the pinned runtime refused to resolve a hidden tool;
 *     the gate never saw the call (no gate refusal is claimed for these).
 */
import assert from "node:assert/strict";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const { composeModeSystemPrompt } = await import("../../../packages/agent-runtime/src/mode-prompts.ts");
const { parseApprovalDescriptor } = await import("../../../packages/omp-runtime/src/session/approval-protocol.ts");
const { requestSystemText } = await import("./helpers/mode-prompt-assertions.mjs");
const { shellQuote } = await import("./helpers/omp-e2e-process.mjs");

const GATE = findGateExtension(here);
const WITNESS = join(here, "fixtures", "omp-runtime-state-witness.ts");
const BUN = join(homedir(), ".bun", "bin", "bun");

const SESSION = "session-c";
const PROJECT_PROVIDER = "m1fake";
const PROJECT_MODEL = "local-model";

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
  return envelopes.map((entry) => entry.event.type).join(" > ");
}

/** The first user message's text: the fake provider's own routing identity. */
function firstUserText(request) {
  const messages = request.body?.messages ?? [];
  const firstUser = messages.find((message) => message && typeof message === "object" && message.role === "user");
  return typeof firstUser?.content === "string" ? firstUser.content : JSON.stringify(firstUser?.content ?? "");
}

/** Everything the provider received in one request, as one searchable string. */
function requestText(request) {
  return JSON.stringify(request?.body ?? {});
}

test(
  "M5/T20-C end-to-end: PI execution-time permissions on the patched runtime",
  { timeout: 900_000 },
  async (t) => {
    assert.ok(GATE, "the shipped tool gate must be present");
    assert.ok(existsSync(BUN), "Bun must be installed for the patched runtime");

    const prepared = await preparePatchedTree({ prepareBuild: true, keep: true });
    t.after(() => prepared.cleanup());
    const LAUNCHER = join(prepared.tree, "packages", "coding-agent", "scripts", "omp");
    assert.ok(existsSync(LAUNCHER), "the patched launcher must exist");

    const project = makeScratch("omp-c-project-");
    const outsideDir = makeScratch("omp-c-outside-");
    const dataRoot = makeScratch("omp-c-data-");
    const witnessLog = join(dataRoot, "witness.jsonl");
    const outsideSecret = join(outsideDir, "secret.txt");
    writeFileSync(outsideSecret, "OUTSIDE-SECRET-C\n");
    const marker = (name) => join(project, name);
    const sessionDir = ensureSessionStateDir(dataRoot);

    const provider = await FakeProvider.start({ model: PROJECT_MODEL });
    t.after(() => provider.close?.());

    // --- Production-shaped seams -------------------------------------------
    const executed = [];
    const mcpCalls = [];
    const pluginState = {
      tools: [
        {
          fullName: "plugin_demo_echo",
          pluginId: "demo",
          name: "echo",
          description: "Echo text",
          schema: { type: "object", properties: { text: { type: "string" } } },
          risk: "medium",
          planSafeActions: [],
          execute: async (args, ctx) => {
            executed.push({ name: "plugin_demo_echo", mode: ctx?.mode, args });
            return "plugin echo result";
          },
        },
        {
          fullName: "plugin_demo_inspect",
          pluginId: "demo",
          name: "inspect",
          description: "Inspect with a plan-safe action",
          schema: { type: "object", properties: { action: { type: "string" } } },
          risk: "low",
          planSafeActions: ["inspect"],
          execute: async (args, ctx) => {
            executed.push({ name: "plugin_demo_inspect", mode: ctx?.mode, args });
            return "plugin inspect result";
          },
        },
      ],
      skills: [],
    };
    const plugins = {
      getTools: () => pluginState.tools,
      getSkills: () => pluginState.skills,
      loadSkillBody: () => {
        throw new Error("no skill bodies in this probe");
      },
    };
    const userMcp = {
      toolsForProject: async () => [
        {
          fullName: "mcp_alpha_lookup",
          serverId: "alpha",
          toolName: "lookup",
          description: "Lookup",
          schema: { type: "object" },
        },
      ],
      callTool: async (name) => {
        mcpCalls.push(name);
        return "mcp alpha result";
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
    const hostSettings = { defaultPermissionMode: "ask" };
    const fakeHost = {
      isAvailable: () => true,
      async call(method, params = {}) {
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
            return { context: null };
          case "project.memory.get":
            return { memory: { content: "" } };
          default:
            throw new Error(`unexpected host call: ${method}`);
        }
      },
    };

    const envelopes = [];
    const supervisors = [];
    const dialogs = [];

    const engineRuntime = {
      gateExtension: GATE,
      ompRuntime: {
        launcher: LAUNCHER,
        launcherError: null,
        createSupervisor: ({ sessionDir: dir, modelSelector }) => {
          const supervisor = new OmpRuntimeSupervisor({
            dataRoot,
            launcherPath: LAUNCHER,
            expectedRuntimeVersion: "18.3.0",
            sessionDir: dir,
            desktopStateRequired: true,
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
              child.stderr.pipe(createWriteStream(join(dataRoot, "runtime-stderr.log"), { flags: "a" }));
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
    });

    /**
     * Test-side interaction hook for turns with more than one card: the
     * production bridge stays untouched, and the scenario decides each card as
     * it is surfaced. Null when the scenario uses `promptAndWait`.
     */
    const interactions = { onEnvelope: null };

    const { bridge } = wireOmpSessions({
      dataRoot,
      host: () => fakeHost,
      engineRuntime,
      isPackaged: false,
      appPath: here,
      emitAgentEvent: (envelope) => {
        envelopes.push(envelope);
        interactions.onEnvelope?.(envelope);
      },
      hostTools,
    });
    t.after(() => bridge.dispose("t20c e2e finished").catch(() => undefined));
    t.after(() => {
      for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const promptAndWait = async (label, content, script, expectText, options = {}) => {
      provider.script(script);
      const sessionId = options.sessionId ?? SESSION;
      const before = envelopes.length;
      const sliceOf = () => envelopes.slice(before);
      const session = hostSessions.get(sessionId);
      const ref = session.engineRef;
      const started = await bridge.prompt({
        sessionId,
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
      let card = null;
      if (options.answer) {
        const seen = await waitFor(() =>
          sliceOf().some((entry) => entry.event.type === "tool_permission_request"),
        );
        assert.equal(seen, true, `${label}: the gate must raise an approval card`);
        card = sliceOf().find((entry) => entry.event.type === "tool_permission_request").event.request;
        const resolved = bridge.resolvePermission(card.requestId, options.answer);
        assert.equal(resolved.ok, true, `${label}: the card must resolve (${options.answer})`);
      }
      const done = await waitFor(() => {
        const slice = sliceOf();
        return (
          slice.some(
            (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes(expectText),
          ) && slice.some((entry) => entry.event.type === "agent_end")
        );
      });
      assert.equal(done, true, `${label}: turn did not settle; timeline ${envelopeTimeline(sliceOf())}`);
      return { request: provider.requests[provider.requests.length - 1], slice: sliceOf(), card };
    };

    const attachDialogs = () => {
      const handle = supervisors.at(-1)?.currentRuntime();
      assert.ok(handle, "the runtime handle must be live");
      handle.onFrame((frame) => {
        if (frame && frame.type === "extension_ui_request") dialogs.push(frame);
      });
    };

    // --- 1. Agent/ask: a medium plugin tool cards with the decision's risk ---
    const p1 = await promptAndWait(
      "agent-plugin-ask",
      "call the desktop echo tool",
      [
        { text: "calling", finish: "tool_calls", toolCalls: [{ id: "c_echo", name: "plugin_demo_echo", args: { text: "hi" } }] },
        { text: "echo finished", finish: "stop" },
      ],
      "echo finished",
      { answer: "deny" },
    );
    const card1 = p1.card;
    assert.equal(card1.toolName, "plugin_demo_echo");
    assert.equal(card1.risk, "medium", "the card must carry the declared risk, not a name guess");
    assert.match(card1.reason, /approval required \(medium risk, ask mode\)/);
    assert.equal(executed.length, 0, "a denied plugin tool must not execute");
    assert.match(requestText(p1.request), /denied by user/, "the model must see the denial");
    attachDialogs();

    // --- 2. Agent/ask: a Low user MCP tool executes without a card ----------
    const mcpBefore = mcpCalls.length;
    const p2 = await promptAndWait(
      "agent-mcp-low",
      "call the alpha lookup",
      [
        { text: "looking up", finish: "tool_calls", toolCalls: [{ id: "c_mcp", name: "mcp_alpha_lookup", args: {} }] },
        { text: "lookup finished", finish: "stop" },
      ],
      "lookup finished",
    );
    assert.equal(
      p2.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "a Low user MCP tool must not card in Agent",
    );
    assert.equal(mcpCalls.length, mcpBefore + 1, "the MCP tool must execute exactly once");
    assert.match(requestText(p2.request), /mcp alpha result/, "the MCP result must reach the model");

    // --- 3. Agent/ask: Bash cards, and the approved call writes once --------
    const bashMarker = marker("bash-allowed.txt");
    const p3 = await promptAndWait(
      "agent-bash-ask-allow",
      "run the marker command",
      [
        {
          text: "running",
          finish: "tool_calls",
          toolCalls: [{ id: "c_bash", name: "bash", args: { command: `printf allowed > ${bashMarker}` } }],
        },
        { text: "command finished", finish: "stop" },
      ],
      "command finished",
      { answer: "allow-once" },
    );
    const card3 = p3.card;
    assert.equal(card3.toolName, "bash");
    assert.equal(card3.risk, "high");
    assert.equal(readFileSync(bashMarker, "utf8"), "allowed", "the approved Bash call must run exactly once");
    const bashDescriptor = dialogs
      .filter((frame) => frame.method === "select" && JSON.stringify(frame).includes("omp-desktop-approval"))
      .map((frame) => parseApprovalDescriptor(frame.optionDetails?.[0]?.description))
      .find((descriptor) => descriptor?.toolName === "bash");
    assert.ok(bashDescriptor, "the real gate must produce a parseable approval descriptor");
    assert.equal(bashDescriptor.mode, "agent");
    assert.equal(bashDescriptor.permissionMode, "ask");

    // --- 4. Agent/ask: an external read path cards, and denying it reads nothing ---
    const p4 = await promptAndWait(
      "agent-external-ask",
      "read the outside file",
      [
        { text: "reading", finish: "tool_calls", toolCalls: [{ id: "c_read", name: "read", args: { path: outsideSecret } }] },
        { text: "read finished", finish: "stop" },
      ],
      "read finished",
      { answer: "deny" },
    );
    const card4 = p4.card;
    assert.match(card4.reason, /external path requires approval/, "the card must be the external-path decision");
    assert.doesNotMatch(requestText(p4.request), /OUTSIDE-SECRET-C/, "a denied external read must return no content");

    // --- 5. Agent/auto (resolved inherit): the same external read needs no card ---
    hostSettings.defaultPermissionMode = "auto";
    const p5 = await promptAndWait(
      "agent-external-auto",
      "read the outside file in auto",
      [
        { text: "reading", finish: "tool_calls", toolCalls: [{ id: "c_read2", name: "read", args: { path: outsideSecret } }] },
        { text: "auto read finished", finish: "stop" },
      ],
      "auto read finished",
    );
    assert.equal(
      p5.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "auto must allow the external read without a card",
    );
    assert.match(requestText(p5.request), /OUTSIDE-SECRET-C/, "the external read content must reach the model");

    // --- 6. A delegate (hasUI=false) follows the parent's policy ------------
    // The session row pins ask here: the app default is already `auto` from
    // step 5, and this scenario is specifically the no-interaction case.
    hostSessions.get(SESSION).permissionMode = "ask";
    const childAskMarker = marker("child-ask.txt");
    const childMarker = "CHILD-ASK-PROBE";
    provider.routeBySession({
      parent: [
        {
          text: "delegating",
          finish: "tool_calls",
          toolCalls: [{ id: "c_task1", name: "task", args: { context: "c probe", tasks: [{ task: `${childMarker} and report`, agent: "task", name: "ScoutC" }] } }],
        },
        { text: "ask delegation finished", finish: "stop" },
      ],
      subagents: [
        {
          marker: childMarker,
          turns: [
            {
              text: "child writing",
              finish: "tool_calls",
              toolCalls: [{ id: "c_child_write1", name: "write", args: { path: childAskMarker, content: "child\n" } }],
            },
            { text: "child ask done", finish: "stop" },
          ],
        },
      ],
    });
    {
      const before = envelopes.length;
      const ref = hostSessions.get(SESSION).engineRef;
      const started = await bridge.prompt({
        sessionId: SESSION,
        content: "delegate the ask probe",
        projectPath: project,
        providerId: PROJECT_PROVIDER,
        modelId: PROJECT_MODEL,
        thinkingLevel: null,
        nativeSessionId: ref?.nativeSessionId ?? null,
        nativeSessionPath: ref?.nativeSessionPath ?? null,
        adapterVersion: ref?.adapterVersion ?? null,
        runtimeVersion: ref?.runtimeVersion ?? null,
      });
      assert.equal(started.accepted, true);
      assert.equal(
        await waitFor(() => envelopes.slice(before).some((entry) => entry.event.type === "agent_end")),
        true,
        `the parent turn must settle; timeline ${envelopeTimeline(envelopes.slice(before))}`,
      );
      assert.equal(
        await waitFor(() => provider.requests.some((request) => firstUserText(request).includes(childMarker))),
        true,
        "the child request must be captured",
      );
      // The child's blocked call becomes a tool result in its next request;
      // wait for that turn, then inspect exactly what the child received.
      await waitFor(
        () => provider.requests.filter((request) => firstUserText(request).includes(childMarker)).length >= 2,
        30_000,
      );
      const childRequests = provider.requests.filter((request) => firstUserText(request).includes(childMarker));
      const childText = childRequests.map(requestText).join("\n--- child request ---\n");
      assert.equal(childRequests.length >= 2, true, `the child must reach a second turn; got ${childRequests.length}`);
      const childTail = childRequests
        .map((request, index) => {
          const messages = (request.body?.messages ?? []).slice(-4).map((message) => JSON.stringify(message).slice(0, 800));
          return `#${index}\n${messages.join("\n")}`;
        })
        .join("\n===\n");
      assert.match(childText, /no interactive UI/, `child tail:\n${childTail}`);
      assert.equal(existsSync(childAskMarker), false, "an ask-mode delegate write must not create the file");
    }

    // --- 7. Agent/auto: the delegate write is allowed without a card --------
    hostSessions.get(SESSION).permissionMode = "inherit";
    const childAutoMarker = marker("child-auto.txt");
    const childAutoMarkerText = "CHILD-AUTO-PROBE";
    provider.routeBySession({
      parent: [
        {
          text: "delegating again",
          finish: "tool_calls",
          toolCalls: [{ id: "c_task2", name: "task", args: { context: "c probe", tasks: [{ task: `${childAutoMarkerText} and report`, agent: "task", name: "ScoutD" }] } }],
        },
        { text: "auto delegation finished", finish: "stop" },
      ],
      subagents: [
        {
          marker: childAutoMarkerText,
          turns: [
            {
              text: "child writing",
              finish: "tool_calls",
              toolCalls: [{ id: "c_child_write2", name: "write", args: { path: childAutoMarker, content: "auto\n" } }],
            },
            { text: "child auto done", finish: "stop" },
          ],
        },
      ],
    });
    {
      const before = envelopes.length;
      const scenario7Start = Date.now();
      const ref = hostSessions.get(SESSION).engineRef;
      const started = await bridge.prompt({
        sessionId: SESSION,
        content: "delegate the auto probe",
        projectPath: project,
        providerId: PROJECT_PROVIDER,
        modelId: PROJECT_MODEL,
        thinkingLevel: null,
        nativeSessionId: ref?.nativeSessionId ?? null,
        nativeSessionPath: ref?.nativeSessionPath ?? null,
        adapterVersion: ref?.adapterVersion ?? null,
        runtimeVersion: ref?.runtimeVersion ?? null,
      });
      assert.equal(started.accepted, true);
      assert.equal(
        await waitFor(() => envelopes.slice(before).some((entry) => entry.event.type === "agent_end")),
        true,
        `the auto delegation turn must settle; timeline ${envelopeTimeline(envelopes.slice(before))}`,
      );
      assert.equal(
        await waitFor(() => readFileSync(childAutoMarker, "utf8") === "auto\n"),
        true,
        "an auto-mode delegate write must execute exactly once",
      );

      // Binding evidence (M5/T20-C second review repair): the ownership rule
      // reads the child session's *public* file/header facts. Record what the
      // real runtime exposed for this delegation — the child declares its
      // parent as the owning session's file, and its header was created after
      // the parent's first provider request, i.e. inside this admitted turn
      // (the fence is armed before that request, so the child cannot predate
      // the admission the freshness guard compares against).
      const parentFile = hostSessions.get(SESSION).engineRef?.nativeSessionPath;
      assert.equal(typeof parentFile === "string" && existsSync(parentFile), true, "the parent native session file must exist");
      const artifactsDir = parentFile.slice(0, -".jsonl".length);
      const childHeaders = readdirSync(artifactsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => {
          // The file opens with a fixed-size title slot; the session header is
          // the entry whose `type` is "session".
          const entries = readFileSync(join(artifactsDir, name), "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line));
          return { name, header: entries.find((entry) => entry.type === "session") };
        });
      assert.equal(childHeaders.length > 0, true, `the delegated child sessions must persist under ${artifactsDir}`);
      for (const { name, header } of childHeaders) {
        assert.ok(header, `child ${name} must contain a session header entry`);
        assert.equal(
          header.parentSession,
          parentFile,
          `child ${name} must declare the owning session file; header=${JSON.stringify(header)}`,
        );
        assert.equal(Number.isFinite(Date.parse(header.timestamp)), true, `child ${name} must carry a parseable creation timestamp`);
      }
      const parentRequest = provider.requests
        .filter((request) => request.at >= scenario7Start && !firstUserText(request).includes(childAutoMarkerText))
        .sort((left, right) => left.at - right.at)[0];
      assert.ok(parentRequest, "the parent request of the auto delegation must be recorded");
      // The child of *this* turn: created after the parent's first provider
      // request, which itself follows the fence that installed the admission.
      const createdThisTurn = childHeaders.filter(({ header }) => Date.parse(header.timestamp) >= scenario7Start);
      assert.equal(createdThisTurn.length > 0, true, "the delegation must create its own child session");
      for (const { name, header } of createdThisTurn) {
        assert.equal(
          Date.parse(header.timestamp) >= parentRequest.at,
          true,
          `child ${name} must be created inside the admitted turn (${header.timestamp} vs ${new Date(parentRequest.at).toISOString()})`,
        );
      }
    }

    // --- 8. Plan/auto: contract catalog + Bash auto + plugin ctx.mode --------
    assert.equal((await bridge.configure(SESSION, { mode: "plan" })).ok, true);
    const hiddenWriteMarker = marker("write-hidden.txt");
    const p8 = await promptAndWait(
      "plan-write-hidden",
      "attempt the write",
      [
        { text: "attempting", finish: "tool_calls", toolCalls: [{ id: "c_write_hidden", name: "write", args: { path: hiddenWriteMarker, content: "x" } }] },
        { text: "hidden attempt done", finish: "stop" },
      ],
      "hidden attempt done",
    );
    assert.equal(existsSync(hiddenWriteMarker), false, "a hidden contract-forbidden write must have no side effect");
    assert.match(
      requestText(p8.request),
      /Tool write not found/,
      "catalog layer: the model must see the hidden write's not-found error result",
    );
    assert.equal(
      p8.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "catalog layer: the hidden write never reached the gate, so no card is claimed",
    );

    const planBashMarker = marker("plan-bash-auto.txt");
    const p9 = await promptAndWait(
      "plan-bash-auto",
      "run the plan marker",
      [
        { text: "running", finish: "tool_calls", toolCalls: [{ id: "c_plan_bash", name: "bash", args: { command: `printf plan > ${planBashMarker}` } }] },
        { text: "plan command done", finish: "stop" },
      ],
      "plan command done",
    );
    assert.equal(
      p9.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "Plan + auto must allow the contract-allowed Bash without a card",
    );
    assert.equal(readFileSync(planBashMarker, "utf8"), "plan", "Plan + auto Bash must execute exactly once (no classifier)");

    const p10 = await promptAndWait(
      "plan-plugin-safe",
      "inspect under the plan contract",
      [
        { text: "inspecting", finish: "tool_calls", toolCalls: [{ id: "c_plan_inspect", name: "plugin_demo_inspect", args: { action: "inspect" } }] },
        { text: "inspect done", finish: "stop" },
      ],
      "inspect done",
    );
    assert.equal(
      p10.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "a declared low-risk plan-safe plugin must not card",
    );
    const inspectRun = executed.find((entry) => entry.name === "plugin_demo_inspect");
    assert.ok(inspectRun, "the plan-safe plugin tool must execute");
    assert.equal(inspectRun.mode, "plan", "the plugin execution context must carry the real Plan mode");
    assert.match(requestText(p10.request), /plugin inspect result/);

    const mcpBeforePlan = mcpCalls.length;
    const p11 = await promptAndWait(
      "plan-mcp-hidden",
      "attempt the mcp lookup",
      [
        { text: "attempting", finish: "tool_calls", toolCalls: [{ id: "c_plan_mcp", name: "mcp_alpha_lookup", args: {} }] },
        { text: "mcp attempt done", finish: "stop" },
      ],
      "mcp attempt done",
    );
    assert.equal(mcpCalls.length, mcpBeforePlan, "a contract-hidden MCP tool must not execute");
    assert.match(
      requestText(p11.request),
      /Tool mcp_alpha_lookup not found/,
      "catalog layer: the model sees the hidden MCP not-found error result",
    );
    assert.equal(
      p11.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "catalog layer: the hidden MCP call never reached the gate",
    );

    // --- 9. Plan/ask: Bash cards and a denial leaves no side effect ----------
    assert.equal((await bridge.configure(SESSION, { permissionMode: "ask" })).ok, true);
    const deniedMarker = marker("plan-bash-denied.txt");
    const p12 = await promptAndWait(
      "plan-bash-ask-deny",
      "run the denied marker",
      [
        { text: "running", finish: "tool_calls", toolCalls: [{ id: "c_plan_deny", name: "bash", args: { command: `printf denied > ${deniedMarker}` } }] },
        { text: "denied command done", finish: "stop" },
      ],
      "denied command done",
      { answer: "deny" },
    );
    const card12 = p12.card;
    assert.equal(card12.risk, "high");
    assert.equal(existsSync(deniedMarker), false, "a denied Plan Bash call must not execute");

    // --- 10. A real allow-session decision is remembered for the desktop ----
    //         session: across the next prompt and across the B1 runtime
    //         replacement (Plan → Agent), never for another session, and it
    //         drops when the session's grants are cleared explicitly.
    const OTHER_SESSION = "session-c-other";
    hostSessions.set(OTHER_SESSION, {
      id: OTHER_SESSION,
      mode: "agent",
      // Explicit ask: the app default was raised to auto earlier in the file,
      // and this control must card exactly like the granted session would
      // without its grant.
      permissionMode: "ask",
      providerId: PROJECT_PROVIDER,
      modelId: PROJECT_MODEL,
      projectPath: project,
      engineRef: null,
    });
    assert.equal((await bridge.configure(SESSION, { mode: "plan", permissionMode: "ask" })).ok, true);
    const grantMarker = marker("grant-marker.txt");
    const grantScript = (id) => [
      { text: "running", finish: "tool_calls", toolCalls: [{ id, name: "bash", args: { command: `printf "granted\\n" >> ${grantMarker}` } }] },
      { text: `grant ${id} finished`, finish: "stop" },
    ];

    const g1 = await promptAndWait("plan-grant-first", "run the command", grantScript("c_grant_1"), "grant c_grant_1 finished", {
      answer: "allow-session",
    });
    assert.equal(g1.card.toolName, "bash", "the first Plan/ask Bash must card");
    assert.deepEqual(bridge.listSessionGrants(SESSION), ["bash"], "the decision must be recorded as a session grant");
    assert.equal(readFileSync(grantMarker, "utf8"), "granted\n");

    const g2 = await promptAndWait("plan-grant-second", "run the command again", grantScript("c_grant_2"), "grant c_grant_2 finished");
    assert.equal(
      g2.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "the granted tool must not card again in the same session",
    );
    assert.equal(readFileSync(grantMarker, "utf8"), "granted\ngranted\n");

    // Plan → Agent rebuilds the runtime process (B1): the grant is desktop
    // main-process state and must survive the replacement.
    assert.equal((await bridge.configure(SESSION, { mode: "agent", permissionMode: "ask" })).ok, true);
    const g3 = await promptAndWait("agent-grant-after-rebuild", "run the command after the rebuild", grantScript("c_grant_3"), "grant c_grant_3 finished");
    assert.equal(
      g3.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "the grant must survive the same-session runtime replacement",
    );
    assert.equal(readFileSync(grantMarker, "utf8"), "granted\ngranted\ngranted\n");

    // Another desktop session shares no grant: its Bash cards.
    const otherMarker = marker("other-grant-marker.txt");
    const o1 = await promptAndWait(
      "other-session-cards",
      "run the command in the other session",
      [
        { text: "running", finish: "tool_calls", toolCalls: [{ id: "c_other_1", name: "bash", args: { command: `printf "other\\n" > ${otherMarker}` } }] },
        { text: "other session finished", finish: "stop" },
      ],
      "other session finished",
      { sessionId: OTHER_SESSION, answer: "deny" },
    );
    assert.equal(o1.card.toolName, "bash", "another session must not inherit the grant");
    assert.equal(existsSync(otherMarker), false, "the other session's denied call must not execute");
    assert.deepEqual(bridge.listSessionGrants(OTHER_SESSION), []);

    // The explicit clear path (the bridge counterpart of PI's
    // `permissions.clearSessionGrants`) drops the memory.
    bridge.clearSessionGrants(SESSION);
    assert.deepEqual(bridge.listSessionGrants(SESSION), []);
    const g4 = await promptAndWait(
      "after-explicit-clear",
      "run the command after the clear",
      grantScript("c_grant_4"),
      "grant c_grant_4 finished",
      { answer: "deny" },
    );
    assert.equal(g4.card.toolName, "bash", "a cleared grant must card again");
    assert.equal(readFileSync(grantMarker, "utf8"), "granted\ngranted\ngranted\n");

    // --- 11. A tool body rewriting the run-scoped state cannot relax the ----
    //         admitted turn, and the next prompt resolves the settings anew.
    assert.equal((await bridge.configure(SESSION, { mode: "plan", permissionMode: "ask" })).ok, true);
    const runTurnWithCards = async (label, content, script, decisions) => {
      provider.script(script);
      const before = envelopes.length;
      const requestsBefore = provider.requests.length;
      const sliceOf = () => envelopes.slice(before);
      const cards = [];
      interactions.onEnvelope = (envelope) => {
        if (envelope.event.type !== "tool_permission_request") return;
        const request = envelope.event.request;
        const decision = decisions[cards.length] ?? "deny";
        cards.push({ toolName: request.toolName, decision });
        queueMicrotask(() => bridge.resolvePermission(request.requestId, decision));
      };
      try {
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
        const done = await waitFor(
          () =>
            sliceOf().some((entry) => entry.event.type === "agent_end") &&
            sliceOf().some(
              (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes(label),
            ),
        );
        assert.equal(done, true, `${label}: turn did not settle; timeline ${envelopeTimeline(sliceOf())}`);
        return { cards, slice: sliceOf(), requests: provider.requests.slice(requestsBefore) };
      } finally {
        interactions.onEnvelope = null;
      }
    };

    const mutationTurn = async (mutate) => {
      const sentinel = marker(mutate ? "sentinel-mutated.txt" : "sentinel-control.txt");
      writeFileSync(sentinel, "untouched\n");
      const firstCommand = mutate
        ? `${shellQuote(process.execPath)} -e ${shellQuote(
            'const fs=require("node:fs");const p=process.env.OMP_DESKTOP_STATE;if(!p)throw new Error("missing owned state env");const s=JSON.parse(fs.readFileSync(p,"utf8"));if(s.mode!=="plan"||s.permissionMode!=="ask")throw new Error("unexpected initial policy");s.permissionMode="auto";fs.writeFileSync(p,JSON.stringify(s));console.log("MUTATION-OK");',
          )}`
        : `printf "control-first\\n"`;
      const outcome = await runTurnWithCards(
        mutate ? "mutation turn done" : "control turn done",
        mutate ? "run the mutating command" : "run the control command",
        [
          { text: "first", finish: "tool_calls", toolCalls: [{ id: `c_${mutate}_1`, name: "bash", args: { command: firstCommand } }] },
          { text: "second", finish: "tool_calls", toolCalls: [{ id: `c_${mutate}_2`, name: "bash", args: { command: `printf "unauthorized\\n" > ${sentinel}` } }] },
          { text: mutate ? "mutation turn done" : "control turn done", finish: "stop" },
        ],
        // The first real Bash is approved once; every later card is denied.
        ["allow-once", "deny"],
      );
      assert.equal(outcome.cards.length, 2, `${mutate ? "mutation" : "control"}: exactly the two Bash cards`);
      assert.equal(outcome.cards[0].decision, "allow-once");
      assert.equal(outcome.cards[1].decision, "deny", "the second Bash must ask again");
      assert.equal(readFileSync(sentinel, "utf8"), "untouched\n", "the denied second Bash must not run");
      const requestTextAll = outcome.requests.map(requestText).join("\n");
      assert.match(requestTextAll, /MUTATION-OK|control-first/, "the first Bash actually ran");
      assert.match(requestTextAll, /denied by user/, "the model must see the denial of the second call");

      // The next prompt rewrites the run-scoped state from the host row
      // (Plan/ask): the on-disk mutation is not a settings change.
      const next = await runTurnWithCards(
        "next prompt after mutation",
        "run once more",
        [
          { text: "next", finish: "tool_calls", toolCalls: [{ id: `c_${mutate}_3`, name: "bash", args: { command: `printf "next\\n" >> ${sentinel}` } }] },
          { text: "next prompt after mutation", finish: "stop" },
        ],
        ["deny"],
      );
      assert.equal(next.cards.length, 1, "the next prompt must resolve Plan/ask again and card");
      assert.equal(readFileSync(sentinel, "utf8"), "untouched\n");
      return outcome;
    };

    await mutationTurn(false);
    await mutationTurn(true);

    // --- 12. The review's canonical native write cases on the real body: ----
    //         Agent × ask deny/allow, auto and accept-edits, asserting both
    //         the card count and the file effect of the real `write` tool.
    const writeMarker = marker("write-modes.txt");
    const writeScript = (id, text) => [
      { text: "writing", finish: "tool_calls", toolCalls: [{ id, name: "write", args: { path: writeMarker, content: `${text}\n` } }] },
      { text: `write ${id} finished`, finish: "stop" },
    ];
    assert.equal((await bridge.configure(SESSION, { mode: "agent", permissionMode: "ask" })).ok, true);
    const wDeny = await promptAndWait("agent-write-ask-deny", "write once", writeScript("c_w_deny", "denied"), "write c_w_deny finished", {
      answer: "deny",
    });
    assert.equal(wDeny.card.risk, "high");
    assert.equal(existsSync(writeMarker), false, "a denied Agent/ask write must not run");

    const wAllow = await promptAndWait("agent-write-ask-allow", "write once", writeScript("c_w_allow", "allowed"), "write c_w_allow finished", {
      answer: "allow-once",
    });
    assert.equal(readFileSync(writeMarker, "utf8"), "allowed\n", "the approved write must run exactly once");

    assert.equal((await bridge.configure(SESSION, { permissionMode: "auto" })).ok, true);
    const wAuto = await promptAndWait("agent-write-auto", "write once in auto", writeScript("c_w_auto", "auto"), "write c_w_auto finished");
    assert.equal(
      wAuto.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "Agent/auto must allow the write without a card",
    );
    // `write` replaces the file: the auto call's content is the whole file.
    assert.equal(readFileSync(writeMarker, "utf8"), "auto\n");

    assert.equal((await bridge.configure(SESSION, { permissionMode: "accept-edits" })).ok, true);
    const wAccept = await promptAndWait(
      "agent-write-accept-edits",
      "write once under accept-edits",
      writeScript("c_w_accept", "accept"),
      "write c_w_accept finished",
    );
    assert.equal(
      wAccept.slice.some((entry) => entry.event.type === "tool_permission_request"),
      false,
      "accept-edits must auto-accept the write",
    );
    assert.equal(readFileSync(writeMarker, "utf8"), "accept\n");
  },
);
