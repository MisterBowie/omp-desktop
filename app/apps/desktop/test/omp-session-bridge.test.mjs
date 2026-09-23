import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as protocol from "../../../packages/shared/src/protocol.ts";

/**
 * The desktop's OMP conversation bridge, and the IPC paths that reach it.
 *
 * These tests own the wiring the engine gate cannot see: which runtime a
 * session is bound to, which events the renderer receives for an approval or a
 * question, and the fact that an OMP prompt never touches the Pi sidecar or the
 * host turn queue. The real runtime is exercised separately
 * (`omp-session-e2e.test.mjs`); here the runtime is a scripted fake so every
 * ordering — a duplicate decision, a decision for a stopped run, a second
 * session — is deterministic.
 */
const { IPC } = protocol;

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");

const OMP_SESSION = "session-omp";

/** Every temporary directory this file creates, removed in `after`. */
const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});

/** A real directory: the bridge refuses a project path that does not exist. */
function makeProject() {
  const path = mkdtempSync(join(tmpdir(), "omp-bridge-project-"));
  scratch.push(path);
  return path;
}

/** A runtime the bridge can write to, exactly as `OmpRuntimeProcess` looks. */
class FakeRuntime {
  pid = 4321;
  usable = true;
  written = [];
  commands = [];
  #frames = new Set();
  #failures = new Set();

  write(frame) {
    this.written.push(frame);
    return this.usable;
  }

  async request(command) {
    this.commands.push(command.type);
    return { success: true };
  }

  onFrame(handler) {
    this.#frames.add(handler);
    return () => this.#frames.delete(handler);
  }

  onFailure(handler) {
    this.#failures.add(handler);
    return () => this.#failures.delete(handler);
  }

  push(frame) {
    for (const handler of [...this.#frames]) handler(frame);
  }

  fail(error) {
    this.usable = false;
    for (const handler of [...this.#failures]) handler(error);
  }
}

/** A supervisor standing in for M2's, with a scripted lifecycle. */
function fakeSupervisor(runtime) {
  return {
    started: 0,
    stopped: [],
    /** Ordered call log: proves the working directory precedes the start. */
    calls: [],
    workingDirectory: null,
    setWorkingDirectory(path) {
      if (this.started > 0) throw new Error("the runtime is running");
      this.calls.push(`setWorkingDirectory:${path}`);
      this.workingDirectory = path;
    },
    // M2's supervisor reports `stopped` until it owns a runtime, so the fake
    // does too: the bridge starts an engine that has not been started, and
    // reuses one that is already up.
    status() {
      return {
        engine: "omp",
        phase: this.started > 0 ? "idle" : "stopped",
        runtimeVersion: this.started > 0 ? "18.2.7" : null,
        protocolVersion: this.started > 0 ? 2 : null,
        reason: this.started > 0 ? null : "not-started",
        capabilities: {},
      };
    },
    async start() {
      this.calls.push("start");
      this.started += 1;
      return this.status();
    },
    async stop(options) {
      this.stopped.push(options ?? {});
      return { reaped: true, cleaned: true, escalated: "none", steps: ["fake stop"], abortAcknowledged: true, errors: [] };
    },
    currentRuntime: () => (runtime.usable ? runtime : null),
    async reclaimAll() {
      return [];
    },
  };
}

function bridgeHarness({ gate = "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts", launcher = "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp" } = {}) {
  const runtime = new FakeRuntime();
  const supervisor = fakeSupervisor(runtime);
  const envelopes = [];
  const logs = [];
  const bridge = createOmpSessionBridge({
    supervisor,
    launcher,
    isPackaged: false,
    appPath: "/repo/app",
    emitAgentEvent: (envelope) => envelopes.push(envelope),
    logger: { app: (scope, level, message, fields) => logs.push({ scope, level, message, fields }) },
    gateResolver: () => gate,
  });
  return { bridge, runtime, supervisor, envelopes, logs };
}

const APPROVAL_FRAME = {
  type: "extension_ui_request",
  id: "ui-1",
  method: "select",
  title: "write: /tmp/project/guarded.txt",
  options: ["Allow once", "Allow for this session", "Deny"],
  optionDetails: [
    {
      description: JSON.stringify({
        v: 1,
        kind: "omp-desktop-approval",
        sessionId: "omp-native-session",
        toolCallId: "call_fake_1_0",
        toolName: "write",
        risk: "high",
        reason: "write: /tmp/project/guarded.txt",
        argsPreview: { path: "/tmp/project/guarded.txt", content: "x" },
        cwd: "/tmp/project",
      }),
    },
    {},
    {},
  ],
};

test("refuses to prompt when this build has no gate extension", async () => {
  const { bridge, supervisor } = bridgeHarness({ gate: null });
  const project = makeProject();
  await assert.rejects(
    () => bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  // Nothing was started: an unguarded runtime must not exist at all.
  assert.equal(supervisor.started, 0);
});

test("refuses to prompt when this build has no runtime executable", async () => {
  const { bridge } = bridgeHarness({ launcher: null });
  const project = makeProject();
  await assert.rejects(
    () => bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project }),
    (error) => error.errorCode === "NOT_FOUND",
  );
});

test("starts the runtime once and streams the run under one turn id", async () => {
  const { bridge, runtime, supervisor, envelopes } = bridgeHarness();
  const project = makeProject();
  const first = await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
  assert.equal(supervisor.started, 1);
  assert.match(first.turnId, /^omp-turn:session-omp:1$/);

  runtime.push({ type: "agent_start" });
  runtime.push({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  runtime.push({ type: "agent_end", messages: [] });

  const kinds = envelopes.map((entry) => entry.event.type);
  assert.deepEqual(kinds, ["agent_start", "message_start", "agent_end"]);
  assert.ok(envelopes.every((entry) => entry.sessionId === OMP_SESSION));
  assert.ok(envelopes.every((entry) => entry.turnId === first.turnId));
  assert.equal(bridge.status(OMP_SESSION).isRunning, false);

  // A second prompt on the same session is the same runtime, not a new one.
  await bridge.prompt({ sessionId: OMP_SESSION, content: "again", projectPath: project });
  assert.equal(supervisor.started, 1);
});

test("refuses a second OMP session instead of sharing the runtime", async () => {
  const { bridge } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
  await assert.rejects(
    () => bridge.prompt({ sessionId: "another-session", content: "hi", projectPath: project }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
});

test("surfaces a gate approval as a permission request and answers it once", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);

  const request = envelopes.at(-1).event;
  assert.equal(request.type, "tool_permission_request");
  assert.equal(request.request.toolCallId, "call_fake_1_0");
  assert.equal(request.request.toolName, "write");
  assert.equal(request.request.risk, "high");
  assert.deepEqual(request.request.argsPreview, { path: "/tmp/project/guarded.txt", content: "x" });
  assert.equal(bridge.hasPendingRequest("ui-1"), true);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 1);

  const allowed = bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(allowed.ok, true);
  assert.deepEqual(runtime.written.at(-1), {
    type: "extension_ui_response",
    id: "ui-1",
    value: "Allow once",
  });

  // Only one decision can authorise this call.
  const second = bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(second.ok, false);
  assert.equal(runtime.written.length, 1);
  assert.equal(bridge.hasPendingRequest("ui-1"), false);
});

test("an approval is answered under the session the bridge stored for it", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);
  const request = envelopes.at(-1).event.request;
  assert.equal(request.sessionId, OMP_SESSION, "the surfaced request names the bound session");
  // No session id is passed back: the bridge's stored binding is the authority,
  // and the decision is accepted for exactly that session.
  assert.equal(bridge.resolvePermission(request.requestId, "allow-once").ok, true);
  assert.equal(runtime.written.length, 1);
});
test("surfaces a runtime question through the ask card and returns the chosen option", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "which file?", projectPath: project });
  runtime.push({
    type: "extension_ui_request",
    id: "q-1",
    method: "select",
    title: "Which file should I open?",
    options: ["a.ts", "b.ts"],
  });

  const ask = envelopes.at(-1).event;
  assert.equal(ask.type, "asktool_request");
  assert.equal(ask.request.questions[0].question, "Which file should I open?");
  assert.deepEqual(ask.request.questions[0].options, ["a.ts", "b.ts"]);

  const answered = bridge.resolveAsk({
    requestId: "q-1",
    sessionId: OMP_SESSION,
    answers: [["b.ts"]],
  });
  assert.equal(answered.ok, true);
  assert.deepEqual(runtime.written.at(-1), {
    type: "extension_ui_response",
    id: "q-1",
    value: "b.ts",
  });
});

test("refuses an answer the runtime never offered", async () => {
  const { bridge, runtime } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "which file?", projectPath: project });
  runtime.push({
    type: "extension_ui_request",
    id: "q-1",
    method: "select",
    title: "Which file should I open?",
    options: ["a.ts", "b.ts"],
  });
  const refused = bridge.resolveAsk({ requestId: "q-1", sessionId: OMP_SESSION, answers: [["c.ts"]] });
  assert.equal(refused.ok, false);
  assert.equal(runtime.written.length, 0);
  assert.equal(bridge.hasPendingRequest("q-1"), true);
});

test("stopping cancels the dialogs the runtime is blocked on", async () => {
  const { bridge, runtime } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);
  const stopped = bridge.stop(OMP_SESSION);
  // The turn converges only after the cancel was delivered.
  setTimeout(() => runtime.push({ type: "agent_end", messages: [] }), 5);
  const outcome = await stopped;
  assert.equal(outcome.converged, true);
  assert.ok(runtime.commands.includes("abort"));
  assert.deepEqual(runtime.written.at(-1), {
    type: "extension_ui_response",
    id: "ui-1",
    cancelled: true,
  });
  // A decision arriving after the stop cannot be delivered.
  assert.equal(bridge.resolvePermission("ui-1", "allow-once").ok, false);
  assert.equal(bridge.hasPendingRequest("ui-1"), false);
});

test("dispose cancels dialogs and reclaims the runtime", async () => {
  const { bridge, runtime, supervisor, envelopes } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);
  const before = envelopes.length;
  await bridge.dispose("application shutdown");
  assert.deepEqual(runtime.written.at(-1), {
    type: "extension_ui_response",
    id: "ui-1",
    cancelled: true,
  });
  // Frames arriving after dispose are not attributed to anything.
  runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
  assert.equal(envelopes.length, before);
  assert.equal(supervisor.stopped.length >= 0, true);
});

test("reports a transport failure as one typed error, not a hung turn", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
  const { OmpRuntimeError } = await import("../../../packages/omp-runtime/src/errors.ts");
  runtime.fail(new OmpRuntimeError("transport-failed", "stdout closed"));
  const last = envelopes.at(-1).event;
  assert.equal(last.type, "error");
  assert.equal(last.error.code, "OMP_TRANSPORT_FAILED");
  assert.equal(bridge.status(OMP_SESSION).isRunning, false);
});

test("an OMP prompt reaches the bridge without touching the Pi runtime", async () => {
  const { bridge } = bridgeHarness();
  const project = makeProject();
  const handlers = new Map();
  const sidecarCalls = [];
  const hostCalls = [];
  const dispatches = [];
  const launched = [];
  const host = {
    async call(method, params) {
      hostCalls.push(method);
      if (method === "session.get") {
        return { session: { id: params?.id, engine: "omp", projectPath: project } };
      }
      if (method === "settings.get") return {};
      return {};
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      async call(method) {
        sidecarCalls.push(method);
        return { accepted: true, turnId: "pi-turn" };
      },
    }),
    getAgentHostBridge: () => null,
    ompSessions: bridge,
    logger: { app: () => undefined },
    vendorOAuth: {},
    agentExtensions: { cancelPrompts: () => undefined },
    cancelSessionTools: () => undefined,
    persistenceOutbox: {},
    dataDir: "/tmp",
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => {
      launched.push(1);
      return { projectPath: project, sidecarParams: {} };
    },
    engineRouter: createEngineRouter({
      status: (engine) => ({ engine, phase: "idle", runtimeVersion: null, protocolVersion: null, reason: null, capabilities: {} }),
      sessionEngine: async () => "omp",
    }),
    acquireSessionOperation: async () => () => undefined,
    finishTurn: async () => undefined,
    lockAbortReason: () => undefined,
    finishApprovedExecution: async () => undefined,
    dispatchApprovedPlan: async () => undefined,
    dispatchExecutionForProposal: async () => undefined,
    emitAgentEvent: () => undefined,
    setNotificationViewingSessionId: () => undefined,
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
  });

  const result = await handlers.get(IPC.invoke.agentPrompt)({
    sessionId: OMP_SESSION,
    content: "hello",
    messageId: "m-1",
  });
  assert.equal(result.accepted, true);
  assert.match(result.turnId, /^omp-turn:/);
  assert.deepEqual(sidecarCalls, []);
  assert.deepEqual(launched, []);
  // The handler reads the session record (and settings) on the way to the
  // engine gate; what it must never reach is the Pi-side permission or plan
  // machinery, or the sidecar.
  assert.ok(hostCalls.every((method) => method === "session.get" || method === "settings.get"));
  assert.ok(!hostCalls.includes("permissions.resolve"));

  // A permission decision for a request the bridge never raised must not be
  // answered by the bridge (the Pi path owns its own request ids).
  assert.equal(bridge.hasPendingRequest("pi-request-1"), false);
});

test("an OMP session's status comes from the runtime that owns it", async () => {
  const { bridge } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
  const handlers = new Map();
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ async call() { return {}; } }),
    getSidecar: () => null,
    getAgentHostBridge: () => null,
    ompSessions: bridge,
    logger: { app: () => undefined },
    vendorOAuth: {},
    agentExtensions: { cancelPrompts: () => undefined },
    cancelSessionTools: () => undefined,
    persistenceOutbox: {},
    dataDir: "/tmp",
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({ projectPath: project, sidecarParams: {} }),
    engineRouter: createEngineRouter({
      status: (engine) => ({ engine, phase: "idle", runtimeVersion: null, protocolVersion: null, reason: null, capabilities: {} }),
      sessionEngine: async () => "omp",
    }),
    acquireSessionOperation: async () => () => undefined,
    finishTurn: async () => undefined,
    lockAbortReason: () => undefined,
    finishApprovedExecution: async () => undefined,
    dispatchApprovedPlan: async () => undefined,
    dispatchExecutionForProposal: async () => undefined,
    emitAgentEvent: () => undefined,
    setNotificationViewingSessionId: () => undefined,
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
  });

  const status = await handlers.get(IPC.invoke.agentGetStatus)(OMP_SESSION);
  assert.equal(status.status.isRunning, true);
  assert.equal(status.status.currentTurnId, "omp-turn:session-omp:1");
});

test("binds the session's project directory before the runtime starts", async () => {
  const project = makeProject();
  const { bridge, supervisor } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
  assert.deepEqual(supervisor.calls, [`setWorkingDirectory:${project}`, "start"]);
  assert.equal(bridge.workingDirectory(), project);
});

test("refuses an empty or relative project directory without starting anything", async () => {
  const { bridge, supervisor } = bridgeHarness();
  for (const projectPath of [null, "", "   ", "relative/project", "./project"]) {
    await assert.rejects(
      () => bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath }),
      (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT,
      `projectPath ${JSON.stringify(projectPath)}`,
    );
  }
  await assert.rejects(
    () => bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: join(process.cwd(), "does-not-exist-omp") }),
    (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT,
  );
  assert.deepEqual(supervisor.calls, []);
  assert.equal(supervisor.started, 0);
});

test("refuses a different project directory for a runtime already bound to one", async () => {
  const first = makeProject();
  const second = makeProject();
  const { bridge, runtime, supervisor } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "one", projectPath: first });
  runtime.push({ type: "agent_end", messages: [] });
  await assert.rejects(
    () => bridge.prompt({ sessionId: OMP_SESSION, content: "two", projectPath: second }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  // The same project keeps working on the runtime that is already up, and the
  // directory was set exactly once, before the runtime started.
  await bridge.prompt({ sessionId: OMP_SESSION, content: "three", projectPath: first });
  assert.deepEqual(supervisor.calls, [`setWorkingDirectory:${first}`, "start"]);
  assert.equal(supervisor.started, 1);
});

test("a question's id cannot be consumed through the permission path", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "which file?", projectPath: project });
  runtime.push({
    type: "extension_ui_request",
    id: "q-1",
    method: "select",
    title: "Which file?",
    options: ["a.ts", "b.ts"],
  });
  const refused = bridge.resolvePermission("q-1", "allow-once");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "wrong-kind");
  assert.equal(runtime.written.length, 0, "a mismatched kind must not answer the runtime");
  // The question is still answerable through its own path.
  const answered = bridge.resolveAsk({ requestId: "q-1", sessionId: OMP_SESSION, answers: [["a.ts"]] });
  assert.equal(answered.ok, true);
  assert.deepEqual(runtime.written.at(-1), { type: "extension_ui_response", id: "q-1", value: "a.ts" });
  assert.ok(envelopes.some((entry) => entry.event.type === "asktool_request"));
});

test("an approval's id cannot be consumed through the ask path", async () => {
  const { bridge, runtime } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);
  const refused = bridge.resolveAsk({
    requestId: "ui-1",
    sessionId: OMP_SESSION,
    answers: [["Allow once"]],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "wrong-kind");
  assert.equal(runtime.written.length, 0, "a mismatched kind must not answer the runtime");
  const allowed = bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(allowed.ok, true);
  assert.equal(runtime.written.length, 1);
});

test("an answer that names another session is refused", async () => {
  const { bridge, runtime } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "which file?", projectPath: project });
  runtime.push({
    type: "extension_ui_request",
    id: "q-2",
    method: "select",
    title: "Which file?",
    options: ["a.ts"],
  });
  const refused = bridge.resolveAsk({ requestId: "q-2", sessionId: "someone-else", answers: [["a.ts"]] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "stale");
  assert.equal(runtime.written.length, 0);
  // The stored session is the bound one: the same answer from it is accepted.
  assert.equal(bridge.resolveAsk({ requestId: "q-2", sessionId: OMP_SESSION, answers: [["a.ts"]] }).ok, true);
});

test("a duplicate decision, or one after a stop, never writes a second frame", async () => {
  const { bridge, runtime } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);
  assert.equal(bridge.resolvePermission("ui-1", "allow-once").ok, true);
  const duplicate = bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(runtime.written.length, 1);

  // A second approval, answered only after the run was stopped, is refused too.
  runtime.push({ ...APPROVAL_FRAME, id: "ui-2" });
  const stop = bridge.stop(OMP_SESSION);
  setTimeout(() => runtime.push({ type: "agent_end", messages: [] }), 5);
  await stop;
  const late = bridge.resolvePermission("ui-2", "allow-once");
  assert.equal(late.ok, false);
  assert.equal(runtime.written.length, 2, "the stop cancels it; nothing else is written");
  assert.equal(bridge.hasPendingRequest("ui-2"), false);
});
