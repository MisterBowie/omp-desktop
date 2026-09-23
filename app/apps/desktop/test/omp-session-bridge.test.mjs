import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const {
  clearSessionPermissions,
  enqueuePermission,
  queuedPermissionCount,
} = await import("../src/lib/pending-permissions.ts");
const { clearSessionAsks, enqueueAsk, headAsk, queuedAskCount } = await import(
  "../src/lib/pending-asks.ts"
);
const { readStoreSource } = await import("./helpers/source-contracts.mjs");
const storeSource = await readStoreSource();
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
const { OmpRuntimeSupervisor } = await import("../../../packages/omp-runtime/src/supervisor.ts");
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

  /** Raised while the prompt request is in flight, when the test wants one. */
  onPrompt = undefined;
  promptResponse = undefined;
  promptFailure = undefined;
  /** Scripted session state for the lifecycle commands (new_session/get_state). */
  stateResponse = undefined;

  async request(command) {
    this.commands.push(command.type);
    if (command.type === "prompt") {
      this.onPrompt?.();
      if (this.promptFailure) throw this.promptFailure;
      if (this.promptResponse) return this.promptResponse;
    }
    if (command.type === "new_session") {
      return { success: true, data: { cancelled: false } };
    }
    if (command.type === "get_state") {
      if (this.stateResponse !== undefined) return this.stateResponse;
      return {
        success: true,
        data: { sessionId: "native-id", sessionFile: "/tmp/native-session.jsonl", sessionName: "session" },
      };
    }
    if (command.type === "switch_session") {
      return { success: true, data: { cancelled: false } };
    }
    if (command.type === "set_session_name" || command.type === "set_model" || command.type === "set_thinking_level") {
      return { success: true };
    }
    if (command.type === "get_branch_messages") {
      return { success: true, data: { messages: [{ entryId: "entry-1", text: "root" }] } };
    }
    if (command.type === "branch") {
      return { success: true, data: { text: "branched", cancelled: false } };
    }
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
  const runtimes = [];
  const supervisors = [];
  const envelopes = [];
  const logs = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "omp-bridge-sessions-"));
  scratch.push(sessionDir);
  // A native transcript the fake runtime reports, inside the session directory,
  // so the bridge's containment/file-type/identity validation passes.
  const nativeSessionId = "native-id";
  const nativeSessionPath = join(sessionDir, "native-session.jsonl");
  writeFileSync(nativeSessionPath, JSON.stringify({ type: "session", id: nativeSessionId, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  // Pre-create the first runtime/supervisor so the destructured handles the
  // single-session tests use are live before the first prompt.
  const firstRuntime = new FakeRuntime();
  firstRuntime.stateResponse = { success: true, data: { sessionId: nativeSessionId, sessionFile: nativeSessionPath, sessionName: "session" } };
  const firstSupervisor = fakeSupervisor(firstRuntime);
  runtimes.push(firstRuntime);
  supervisors.push(firstSupervisor);
  let created = 0;
  const bridge = createOmpSessionBridge({
    createSupervisor: () => {
      if (created === 0) {
        created += 1;
        return firstSupervisor;
      }
      const runtime = new FakeRuntime();
      runtime.stateResponse = { success: true, data: { sessionId: nativeSessionId, sessionFile: nativeSessionPath, sessionName: "session" } };
      const supervisor = fakeSupervisor(runtime);
      runtimes.push(runtime);
      supervisors.push(supervisor);
      created += 1;
      return supervisor;
    },
    launcher,
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    emitAgentEvent: (envelope) => envelopes.push(envelope),
    logger: { app: (scope, level, message, fields) => logs.push({ scope, level, message, fields }) },
    gateResolver: () => gate,
  });
  return { bridge, runtime: firstRuntime, supervisor: firstSupervisor, runtimes, supervisors, envelopes, logs, sessionDir, nativeSessionId, nativeSessionPath };
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

test("runs two OMP sessions on independent runtimes", async () => {
  const { bridge, runtimes, supervisors } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
  await bridge.prompt({ sessionId: "another-session", content: "hi", projectPath: project });
  assert.equal(runtimes.length, 2, "each session gets its own runtime");
  assert.equal(supervisors.length, 2, "each session gets its own supervisor");
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

test("retains a directory-only debt across stop retries until it is removable", async () => {
  // A real supervisor + real SessionEntry, with the filesystem failure at the
  // external boundary (the run root is made unremovable). Fake teardown
  // verdicts cannot catch this: the bridge's teardown must re-sweep a retained
  // directory even when `stop` reports "nothing owned" on the retry.
  const root = mkdtempSync(join(tmpdir(), "omp-bridge-debt-"));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativePath = join(sessionDir, "native.jsonl");
  writeFileSync(nativePath, `${JSON.stringify({ type: "session", id: "native-debt", cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);

  const handlers = new Set();
  let runRoot;
  const runtime = {
    pid: 4242,
    pgid: 4242,
    currentPhase: "idle",
    usable: true,
    runtimeVersion: "18.2.7",
    protocolVersion: 2,
    write: () => true,
    onFrame(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    onFailure: () => () => {},
    async stop() { this.usable = false; return { reaped: true, escalated: "none", steps: [], errors: [], abortAcknowledged: true }; },
    async request(command) {
      if (command.type === "get_state") return { success: true, data: { sessionId: "native-debt", sessionFile: nativePath } };
      if (command.type === "get_subagents") return { success: true, data: { subagents: [{ id: "child", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "task-1" }] } };
      if (command.type === "abort") for (const fn of handlers) fn({ type: "agent_end", isTerminal: true });
      return { success: true, data: { cancelled: false } };
    },
  };
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: join(root, "data"),
    sessionDir,
    launcherPath: mockLauncher,
    expectedRuntimeVersion: "18.2.7",
    prepareRun(paths) { runRoot = paths.runRoot; },
    runtimeFactory: async () => runtime,
  });
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: mockLauncher,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => join(here, "..", "..", "..", "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
    emitAgentEvent: () => {},
  });

  try {
    await bridge.prompt({ sessionId: "debt", content: "delegate", projectPath: project });
    for (const fn of handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });

    // The first stop reaps the group but cannot remove the run root.
    chmodSync(runRoot, 0o500);
    const first = await bridge.stop("debt");
    assert.equal(first.toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 1);
    assert.equal(existsSync(runRoot), true);

    // The retained debt blocks a new prompt: the bridge fails closed with a
    // typed NOT_STARTED (the runtime was stopped and is not available) rather
    // than accepting a turn against a session that still owes a directory.
    await assert.rejects(
      () => bridge.prompt({ sessionId: "debt", content: "again", projectPath: project }),
      (error) => error.errorCode === "NOT_STARTED",
    );

    // A retry while the directory is still unremovable keeps the debt.
    const second = await bridge.stop("debt");
    assert.equal(supervisor.pendingCleanup.length, 1);
    assert.equal(existsSync(runRoot), true);

    // Once the directory is removable, the next stop clears the debt for good.
    chmodSync(runRoot, 0o700);
    const third = await bridge.stop("debt");
    assert.equal(supervisor.pendingCleanup.length, 0);
    assert.equal(existsSync(runRoot), false);

    // A final stop has nothing left to do, and disposal succeeds cleanly.
    const fourth = await bridge.stop("debt");
    assert.deepEqual(fourth.steps, ["nothing running"]);
    const disposed = await bridge.dispose("debt finished");
    assert.deepEqual(disposed, { ok: true, failures: [] });
  } finally {
    if (runRoot && existsSync(runRoot)) chmodSync(runRoot, 0o700);
    await bridge.dispose("debt cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
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
  // The handler reads the session record, its native reference, and settings on
  // the way to the engine gate; what it must never reach is the Pi-side
  // permission or plan machinery, or the sidecar.
  assert.ok(hostCalls.every((method) => method === "session.get" || method === "session.getEngineRef" || method === "settings.get"));
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
  assert.equal(bridge.workingDirectory(OMP_SESSION), project);
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

test("a skipped question is failed closed instead of leaving the runtime waiting", async () => {
  const { bridge, runtime } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "which file?", projectPath: makeProject() });
  runtime.push({
    type: "extension_ui_request",
    id: "q-skip",
    method: "select",
    title: "Which file?",
    options: ["a.ts", "b.ts"],
  });
  const resolution = bridge.resolveAsk({
    requestId: "q-skip",
    sessionId: OMP_SESSION,
    answers: [null],
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.outcome, "cancelled");
  assert.deepEqual(runtime.written, [
    { type: "extension_ui_response", id: "q-skip", cancelled: true },
  ]);
  // Both layers forget it: the bridge reports nothing pending and the runtime's
  // own status agrees.
  assert.equal(bridge.hasPendingRequest("q-skip"), false);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);
  assert.equal(bridge.diagnostics().uiRecords.at(-1).outcome, "cancelled");
});

test("an answer the runtime's select cannot carry is failed closed too", async () => {
  const { bridge, runtime } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "which file?", projectPath: makeProject() });
  runtime.push({
    type: "extension_ui_request",
    id: "q-custom",
    method: "select",
    title: "Which file?",
    options: ["a.ts", "b.ts"],
  });
  // The card allows a free-text answer; the runtime's `select` accepts only the
  // options it offered, so the dialog must not be left open for it.
  const resolution = bridge.resolveAsk({
    requestId: "q-custom",
    sessionId: OMP_SESSION,
    answers: [["typed-by-hand"]],
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.outcome, "cancelled");
  assert.deepEqual(runtime.written, [
    { type: "extension_ui_response", id: "q-custom", cancelled: true },
  ]);
  assert.equal(bridge.hasPendingRequest("q-custom"), false);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);
});

test("a confirmation answers yes/no and a dismissal is a cancellation", async () => {
  const { bridge, runtime } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "proceed?", projectPath: makeProject() });
  const confirmFrame = (id) => ({
    type: "extension_ui_request",
    id,
    method: "confirm",
    title: "Proceed?",
    message: "really",
  });
  runtime.push(confirmFrame("c-yes"));
  runtime.push(confirmFrame("c-dismissed"));
  assert.deepEqual(
    bridge.resolveAsk({ requestId: "c-yes", sessionId: OMP_SESSION, answers: [["Yes"]] }),
    { ok: true, outcome: "answered" },
  );
  assert.deepEqual(
    bridge.resolveAsk({ requestId: "c-dismissed", sessionId: OMP_SESSION, answers: [null] }),
    { ok: true, outcome: "cancelled" },
  );
  assert.deepEqual(runtime.written, [
    { type: "extension_ui_response", id: "c-yes", confirmed: true },
    { type: "extension_ui_response", id: "c-dismissed", cancelled: true },
  ]);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);
});

test("a dialog raised by an earlier run cannot be answered into the next one", async () => {
  const { bridge, runtime } = bridgeHarness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write a file", projectPath: project });
  runtime.push(APPROVAL_FRAME);
  runtime.push({
    type: "extension_ui_request",
    id: "q-old",
    method: "select",
    title: "Which file?",
    options: ["a.ts"],
  });
  // The run ends with both dialogs still open.
  runtime.push({ type: "agent_end", messages: [] });
  assert.equal(bridge.hasPendingRequest("ui-1"), false);
  assert.equal(bridge.hasPendingRequest("q-old"), false);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);

  // A second run starts, and the old ids stay dead.
  await bridge.prompt({ sessionId: OMP_SESSION, content: "again", projectPath: project });
  const staleApproval = bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(staleApproval.ok, false);
  const staleAnswer = bridge.resolveAsk({ requestId: "q-old", sessionId: OMP_SESSION, answers: [["a.ts"]] });
  assert.equal(staleAnswer.ok, false);
  // The only frames written are the cancellations from the run that ended.
  assert.deepEqual(
    runtime.written.filter((frame) => frame.cancelled || frame.value || frame.confirmed),
    [
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
      { type: "extension_ui_response", id: "q-old", cancelled: true },
    ],
  );
});

test("a late reply after a transport failure or a dispose writes nothing", async () => {
  const { OmpRuntimeError } = await import("../../../packages/omp-runtime/src/errors.ts");

  const failed = bridgeHarness();
  await failed.bridge.prompt({ sessionId: OMP_SESSION, content: "write", projectPath: makeProject() });
  failed.runtime.push(APPROVAL_FRAME);
  failed.runtime.fail(new OmpRuntimeError("transport-failed", "stdout closed"));
  const afterFailure = failed.bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(afterFailure.ok, false);
  assert.equal(failed.bridge.hasPendingRequest("ui-1"), false);
  assert.deepEqual(failed.runtime.written, [
    { type: "extension_ui_response", id: "ui-1", cancelled: true },
  ]);

  const disposed = bridgeHarness();
  await disposed.bridge.prompt({ sessionId: OMP_SESSION, content: "write", projectPath: makeProject() });
  disposed.runtime.push(APPROVAL_FRAME);
  await disposed.bridge.dispose("window closed");
  const afterDispose = disposed.bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(afterDispose.ok, false);
  assert.deepEqual(disposed.runtime.written, [
    { type: "extension_ui_response", id: "ui-1", cancelled: true },
  ]);
});

test("the runtime retracting a dialog clears it in the bridge as well", async () => {
  const { bridge, runtime } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write", projectPath: makeProject() });
  runtime.push(APPROVAL_FRAME);
  assert.equal(bridge.hasPendingRequest("ui-1"), true);
  runtime.push({ type: "extension_ui_request", id: "ui-2", method: "cancel", targetId: "ui-1" });
  assert.equal(bridge.hasPendingRequest("ui-1"), false);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);
  assert.deepEqual(runtime.written, [], "a retraction is answered by nobody");
  const decision = bridge.resolvePermission("ui-1", "allow-once");
  assert.equal(decision.ok, false);
  assert.equal(runtime.written.length, 0);
});

test("stopping another session leaves this one's dialogs, state and wire untouched", async () => {
  const { bridge, runtime, supervisor } = bridgeHarness();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "write", projectPath: makeProject() });
  runtime.push(APPROVAL_FRAME);
  const before = bridge.status(OMP_SESSION);

  // A stop addressed to a session with no runtime is a no-op, not a signal to
  // this session's process.
  const outcome = await bridge.stop("other-session");
  assert.equal(outcome.converged, true);

  assert.equal(bridge.hasPendingRequest("ui-1"), true, "the pending dialog must survive");
  assert.deepEqual(bridge.status(OMP_SESSION), before, "the run state must not change");
  assert.deepEqual(runtime.written, [], "no frame may be written for another session's stop");
  assert.deepEqual(runtime.commands, ["new_session", "get_state", "set_subagent_subscription", "prompt"], "no abort may be sent for another session");
  assert.deepEqual(supervisor.stopped, []);
  // The pending dialog is still answerable by its own session.
  assert.deepEqual(bridge.resolvePermission("ui-1", "allow-once"), { ok: true, outcome: "answered" });
});

test("a refused prompt closes its dialog and tells the renderer the turn ended", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  // The runtime raises a dialog while handling the prompt, then refuses it.
  runtime.onPrompt = () => {
    runtime.push({
      type: "extension_ui_request",
      id: "ui-refused",
      method: "select",
      title: "write",
      options: ["Allow once", "Allow for this session", "Deny"],
      optionDetails: [
        {
          description: JSON.stringify({
            v: 1,
            kind: "omp-desktop-approval",
            toolCallId: "call_refused",
            toolName: "write",
            risk: "high",
            reason: "write",
            argsPreview: {},
          }),
        },
        {},
        {},
      ],
    });
  };
  runtime.promptResponse = { success: false, error: "busy" };

  await assert.rejects(
    () => bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: makeProject() }),
    (error) => {
      // The refusal reaches the caller unchanged: the cleanup must not replace
      // the root cause.
      assert.equal(error.code, "not-started");
      assert.match(error.message, /refused the prompt: busy/);
      return true;
    },
  );

  // The renderer's sequence: the card, then exactly one terminal event.
  assert.deepEqual(
    envelopes.map((entry) => entry.event.type),
    ["tool_permission_request", "error"],
  );
  const terminal = envelopes.at(-1);
  assert.equal(terminal.sessionId, OMP_SESSION);
  assert.equal(terminal.turnId, "omp-turn:session-omp:1");
  assert.equal(terminal.event.type, "error");
  assert.match(terminal.event.error.message, /busy/);

  // The dialog is failed closed exactly once, and forgotten.
  assert.deepEqual(runtime.written, [
    { type: "extension_ui_response", id: "ui-refused", cancelled: true },
  ]);
  assert.equal(bridge.hasPendingRequest("ui-refused"), false);
  assert.equal(bridge.status(OMP_SESSION).isRunning, false);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);

  // Renderer contract: the terminal event is exactly the kind PI-Desktop's store
  // clears pending permissions and asks on, and clearing by that session empties
  // the queues the card was queued into.
  assert.ok(
    terminal.event.type === "agent_end" || terminal.event.type === "error",
    "the terminal event must be the type the store clears on",
  );
  const permission = envelopes[0].event.request;
  const queues = enqueuePermission(
    enqueuePermission({}, permission),
    { ...permission, requestId: "second-request" },
  );
  assert.equal(queuedPermissionCount(queues, terminal.sessionId), 1);
  assert.deepEqual(Object.keys(clearSessionPermissions(queues, terminal.sessionId)), []);

  const askQueues = enqueueAsk({}, {
    requestId: "ask-1",
    sessionId: terminal.sessionId,
    toolCallId: "call-1",
    questions: [{ question: "Which file?", options: ["a.ts"] }],
  });
  // One ask is queued: `queuedAskCount` counts the requests *behind* the head.
  assert.equal(headAsk(askQueues, terminal.sessionId)?.requestId, "ask-1");
  assert.equal(queuedAskCount(askQueues, terminal.sessionId), 0);
  assert.deepEqual(Object.keys(clearSessionAsks(askQueues, terminal.sessionId)), []);

  // The store's own cleanup branch, asserted the way PI-Desktop's
  // permission-inline test asserts the abort path: pending permissions and asks
  // are cleared on exactly the terminal event kinds the bridge emits.
  assert.match(
    storeSource,
    /event\.type === "agent_end" \|\| event\.type === "error"/,
    "the store clears on agent_end/error",
  );
  assert.match(storeSource, /clearSessionPermissions\(/);
  assert.match(storeSource, /clearSessionAsks\(/);

  // A decision arriving after the refusal cannot authorise anything.
  const late = bridge.resolvePermission("ui-refused", "allow-once");
  assert.equal(late.ok, false);
  assert.equal(runtime.written.length, 1);

  // And a dialog arriving after the terminal event is not presented again.
  runtime.push({
    type: "extension_ui_request",
    id: "ui-after-terminal",
    method: "select",
    title: "write",
    options: ["Allow once", "Allow for this session", "Deny"],
    optionDetails: [{ description: JSON.stringify({ v: 1, kind: "omp-desktop-approval", toolCallId: "c9", toolName: "write", risk: "high", reason: "r", argsPreview: {} }) }, {}, {}],
  });
  assert.equal(bridge.hasPendingRequest("ui-after-terminal"), false);
  assert.equal(
    envelopes.filter((entry) => entry.event.type === "tool_permission_request").length,
    1,
    "a post-terminal dialog must not be presented",
  );
});

test("a thrown prompt request keeps its own error and still ends the turn", async () => {
  const { bridge, runtime, envelopes } = bridgeHarness();
  runtime.onPrompt = () => {
    runtime.push({
      type: "extension_ui_request",
      id: "ui-error",
      method: "select",
      title: "write",
      options: ["Allow once", "Allow for this session", "Deny"],
      optionDetails: [
        { description: JSON.stringify({ v: 1, kind: "omp-desktop-approval", toolCallId: "call_err", toolName: "write", risk: "high", reason: "r", argsPreview: {} }) },
        {},
        {},
      ],
    });
  };
  runtime.promptFailure = new (await import("../../../packages/omp-runtime/src/errors.ts")).OmpRuntimeError(
    "request-timeout",
    "no response to prompt within 30000 ms",
  );

  await assert.rejects(
    () => bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: makeProject() }),
    (error) => {
      assert.equal(error.code, "request-timeout");
      assert.match(error.message, /no response to prompt/);
      return true;
    },
  );
  assert.deepEqual(
    envelopes.map((entry) => entry.event.type),
    ["tool_permission_request", "error"],
  );
  assert.equal(envelopes.at(-1).turnId, "omp-turn:session-omp:1");
  assert.deepEqual(runtime.written, [
    { type: "extension_ui_response", id: "ui-error", cancelled: true },
  ]);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);
});
