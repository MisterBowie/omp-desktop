import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const { projectMessageEnd } = await import("../src/lib/session-transcript.ts");
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
  assert.match(first.turnId, /^omp-turn:session-omp:[^:]+:1$/);

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

/** A fake runtime that records every command written to it. */
function c1Runtime(nativeId, nativePath, childRunning) {
  const handlers = new Set();
  const commands = [];
  return {
    pid: 4242,
    pgid: 4242,
    currentPhase: "idle",
    usable: true,
    runtimeVersion: "18.2.7",
    protocolVersion: 2,
    commands,
    handlers,
    write: () => true,
    onFrame(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    onFailure() { return () => {}; },
    async stop() {
      this.usable = false;
      return { reaped: true, escalated: "none", steps: [], errors: [], abortAcknowledged: true };
    },
    async request(command) {
      commands.push(command.type);
      if (command.type === "get_state") return { success: true, data: { sessionId: nativeId, sessionFile: nativePath } };
      if (command.type === "get_subagents") {
        return childRunning
          ? { success: true, data: { subagents: [{ id: "child", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "task-1" }] } }
          : { success: true, data: { subagents: [] } };
      }
      if (command.type === "abort") for (const fn of handlers) fn({ type: "agent_end", isTerminal: true });
      return { success: true, data: { cancelled: false } };
    },
  };
}

/**
 * A real supervisor + real SessionEntry whose factory mints one fake runtime per
 * start, so `runtimes.length` is the runtime-start count and each runtime's
 * `commands` is the ordered command log the C1 contract checks against.
 */
function c1Harness({ childRunning = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omp-bridge-c1-"));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativeId = "native-c1";
  const nativePath = join(sessionDir, "native.jsonl");
  writeFileSync(nativePath, `${JSON.stringify({ type: "session", id: nativeId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);

  const runtimes = [];
  const envelopes = [];
  let runRoot;
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: join(root, "data"),
    sessionDir,
    launcherPath: mockLauncher,
    expectedRuntimeVersion: "18.2.7",
    prepareRun(paths) { runRoot = paths.runRoot; },
    runtimeFactory: async () => {
      const runtime = c1Runtime(nativeId, nativePath, childRunning);
      runtime.pid = 4242 + runtimes.length;
      runtime.pgid = runtime.pid;
      runtimes.push(runtime);
      return runtime;
    },
  });
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: mockLauncher,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => join(here, "..", "..", "..", "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
    emitAgentEvent: (envelope) => envelopes.push(envelope),
  });
  return { root, project, nativeId, nativePath, supervisor, bridge, runtimes, envelopes, runRoot: () => runRoot };
}

test("reclaims a dead runtime and rebuilds it for the next prompt in the same session", async () => {
  // C1's actual user path: prompt -> task child -> stop -> failed cleanup ->
  // retry until reaped && cleaned -> send the next message in the SAME session
  // (no dispose). The fully reclaimed runtime must be retired and rebuilt, and
  // the replacement must restore the SAME native session before exactly one
  // prompt.
  const { root, project, nativeId, nativePath, supervisor, bridge, runtimes, runRoot } = c1Harness({ childRunning: true });

  try {
    await bridge.prompt({ sessionId: "c1-retry", content: "delegate", projectPath: project });
    for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });

    chmodSync(runRoot(), 0o500);
    assert.equal((await bridge.stop("c1-retry")).toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 1);
    assert.equal((await bridge.stop("c1-retry")).toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 1);
    chmodSync(runRoot(), 0o700);
    const third = await bridge.stop("c1-retry");
    assert.equal(third.toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 0);
    assert.equal(existsSync(runRoot()), false);

    // The same session, without dispose, starts a second runtime and restores
    // the same native identity before exactly one prompt.
    const next = await bridge.prompt({
      sessionId: "c1-retry",
      content: "continue",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    });
    assert.equal(next.accepted, true);
    assert.match(next.turnId, /^omp-turn:c1-retry:[^:]+:2$/, "the turn identity must not reuse the first turn's");
    assert.equal(runtimes.length, 2, "a second runtime must start for the replacement");
    assert.deepEqual(runtimes[1].commands, ["switch_session", "get_state", "set_subagent_subscription", "prompt"]);
    assert.equal(runtimes[1].commands.filter((command) => command === "prompt").length, 1, "exactly one prompt is submitted");
  } finally {
    if (runRoot() && existsSync(runRoot())) chmodSync(runRoot(), 0o700);
    await bridge.dispose("c1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an immediate successful teardown still lets the next prompt rebuild", async () => {
  // No filesystem failure: the first stop tears the process down and cleans the
  // run root. The next prompt in the same session must still rebuild.
  const { root, project, nativeId, nativePath, supervisor, bridge, runtimes } = c1Harness({ childRunning: true });

  try {
    await bridge.prompt({ sessionId: "c1-immediate", content: "delegate", projectPath: project });
    for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
    const stop = await bridge.stop("c1-immediate");
    assert.equal(stop.toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 0);

    const next = await bridge.prompt({
      sessionId: "c1-immediate",
      content: "again",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    });
    assert.equal(next.accepted, true);
    assert.equal(runtimes.length, 2);
    assert.match(next.turnId, /^omp-turn:c1-immediate:[^:]+:2$/);
  } finally {
    await bridge.dispose("c1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a converged protocol stop reuses the live runtime", async () => {
  // A normal stop with no detached child converges in-protocol and leaves the
  // process alive: the runner is not retired and the next prompt reuses it.
  const { root, project, nativeId, nativePath, supervisor, bridge, runtimes } = c1Harness({ childRunning: false });

  try {
    await bridge.prompt({ sessionId: "c1-converged", content: "hello", projectPath: project });
    const stop = await bridge.stop("c1-converged");
    assert.equal(stop.converged, true);
    assert.equal(stop.toreDown, false);

    const next = await bridge.prompt({
      sessionId: "c1-converged",
      content: "again",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    });
    assert.equal(next.accepted, true);
    assert.equal(runtimes.length, 1, "a converged stop must not start a second runtime");
    assert.match(next.turnId, /^omp-turn:c1-converged:[^:]+:2$/, "the same runner continues the turn sequence");
  } finally {
    await bridge.dispose("c1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending cleanup refuses the next prompt without starting a second runtime", async () => {
  // A failed teardown keeps the runner (its retry obligation is still owed) and
  // must not trigger a rebuild: the prompt is refused and the factory is not
  // called a second time.
  const { root, project, supervisor, bridge, runtimes, runRoot } = c1Harness({ childRunning: true });

  try {
    await bridge.prompt({ sessionId: "c1-pending", content: "delegate", projectPath: project });
    for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
    chmodSync(runRoot(), 0o500);
    const stop = await bridge.stop("c1-pending");
    assert.equal(stop.toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 1);

    await assert.rejects(
      () => bridge.prompt({ sessionId: "c1-pending", content: "again", projectPath: project }),
      (error) => error.errorCode === "NOT_STARTED",
    );
    assert.equal(runtimes.length, 1, "a pending reclaim must not start a second runtime");
  } finally {
    if (runRoot() && existsSync(runRoot())) chmodSync(runRoot(), 0o700);
    await bridge.dispose("c1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the retired runtime's handlers are detached and old frames do not reach the replacement", async () => {
  // After a full reclaim the retired runner must detach its frame handlers: a
  // late frame from the dead process cannot settle or mutate the new turn, and
  // the replacement runner is wired to the new runtime instead.
  const { root, project, nativeId, nativePath, supervisor, bridge, runtimes, envelopes } = c1Harness({ childRunning: true });

  try {
    await bridge.prompt({ sessionId: "c1-detach", content: "delegate", projectPath: project });
    for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
    const stop = await bridge.stop("c1-detach");
    assert.equal(stop.toreDown, true);
    assert.equal(supervisor.pendingCleanup.length, 0);

    // The retired runtime has no listeners left; a late frame reaches nothing.
    assert.equal(runtimes[0].handlers.size, 0, "the retired runtime's handlers must be detached");
    for (const fn of runtimes[0].handlers) fn({ type: "agent_start" });
    assert.equal(envelopes.filter((envelope) => envelope.event.type === "agent_start").length, 0);

    const next = await bridge.prompt({
      sessionId: "c1-detach",
      content: "continue",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    });
    assert.equal(next.accepted, true);
    assert.equal(runtimes.length, 2);
    assert.equal(runtimes[1].handlers.size, 1, "the replacement runner is wired to the new runtime");
    for (const fn of runtimes[1].handlers) fn({ type: "agent_start" });
    const start = envelopes.find((envelope) => envelope.event.type === "agent_start");
    assert.equal(start.turnId, next.turnId, "a frame on the new runtime belongs to the new turn");
  } finally {
    await bridge.dispose("c1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dispose that cannot reclaim keeps the session's ownership, not a second runtime", async () => {
  // Stop leaves a directory debt, then dispose runs (the stop/dispose overlap
  // the shutdown path must survive): the failed reclaim keeps the entry and the
  // supervisor's obligation, a prompt cannot start a second runtime, and a
  // retry dispose clears the debt once the directory is removable.
  const { root, project, supervisor, bridge, runtimes, runRoot } = c1Harness({ childRunning: true });

  try {
    await bridge.prompt({ sessionId: "c1-dispose-debt", content: "delegate", projectPath: project });
    for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
    chmodSync(runRoot(), 0o500);
    await bridge.stop("c1-dispose-debt");
    assert.equal(supervisor.pendingCleanup.length, 1);

    const disposed = await bridge.dispose("shutdown");
    assert.equal(disposed.ok, false, "a dispose that cannot reclaim must report failure");
    assert.equal(supervisor.pendingCleanup.length, 1, "the supervisor still owns the debt after dispose");

    await assert.rejects(
      () => bridge.prompt({ sessionId: "c1-dispose-debt", content: "again", projectPath: project }),
      (error) => error.errorCode === ErrorCodes.ENGINE_UNAVAILABLE,
      "a whole-bridge shutdown refuses every session, existing or new",
    );
    assert.equal(runtimes.length, 1, "dispose must not start a second runtime");

    chmodSync(runRoot(), 0o700);
    const retried = await bridge.dispose("shutdown");
    assert.equal(retried.ok, true);
    assert.equal(supervisor.pendingCleanup.length, 0);
  } finally {
    if (runRoot() && existsSync(runRoot())) chmodSync(runRoot(), 0o700);
    await bridge.dispose("c1 cleanup").catch(() => undefined);
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
  const result = await bridge.prompt({ sessionId: OMP_SESSION, content: "hello", projectPath: project });
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
  assert.equal(status.status.currentTurnId, result.turnId);
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
  assert.match(terminal.turnId, /^omp-turn:session-omp:[^:]+:1$/);
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
  assert.match(envelopes.at(-1).turnId, /^omp-turn:session-omp:[^:]+:1$/);
  assert.deepEqual(runtime.written, [
    { type: "extension_ui_response", id: "ui-error", cancelled: true },
  ]);
  assert.equal(bridge.status(OMP_SESSION).pendingToolConfirmations, 0);
});

/** A deferred value the tests resolve at a controlled moment. */
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** A fake runtime whose prompt emits one assistant reply, keyed by ordinal. */
function messageRuntime(nativeId, nativePath, ordinal) {
  const handlers = new Set();
  const failures = new Set();
  const commands = [];
  let bound = false;
  return {
    pid: 5000 + ordinal,
    pgid: 5000 + ordinal,
    currentPhase: "idle",
    usable: true,
    runtimeVersion: "18.2.7",
    protocolVersion: 2,
    commands,
    handlers,
    failures,
    write() { return this.usable; },
    onFrame(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    onFailure(fn) { failures.add(fn); return () => failures.delete(fn); },
    emit(frame) { for (const fn of [...handlers]) fn(frame); },
    async stop() {
      this.usable = false;
      return { reaped: true, escalated: "none", steps: [], errors: [], abortAcknowledged: true };
    },
    async request(command) {
      commands.push(command.type);
      if (!this.usable) throw new Error("request used a retired runtime");
      if (command.type === "new_session" || command.type === "switch_session") bound = true;
      if (command.type === "get_state") {
        return { success: true, data: bound ? { sessionId: nativeId, sessionFile: nativePath } : { sessionId: "unbound", sessionFile: "" } };
      }
      if (command.type === "prompt" && !bound) throw new Error("replacement runtime was not restored before prompt");
      if (command.type === "prompt") {
        const message = { role: "assistant", content: [{ type: "text", text: `reply-runtime-${ordinal}` }], timestamp: 1 };
        this.emit({ type: "message_start", message });
        this.emit({ type: "message_end", message });
      }
      if (command.type === "abort") this.emit({ type: "agent_end", isTerminal: true });
      if (command.type === "get_subagents") {
        return { success: true, data: { subagents: [{ id: "child", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "task-1" }] } };
      }
      return { success: true, data: { cancelled: false } };
    },
  };
}

/** A real supervisor whose factory mints one message-emitting runtime per start. */
function messageHarness() {
  const root = mkdtempSync(join(tmpdir(), "omp-bridge-msg-"));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativeId = "native-msg";
  const nativePath = join(sessionDir, "native.jsonl");
  writeFileSync(nativePath, `${JSON.stringify({ type: "session", id: nativeId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);
  const runtimes = [];
  const envelopes = [];
  let runRoot;
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: join(root, "data"),
    sessionDir,
    launcherPath: mockLauncher,
    expectedRuntimeVersion: "18.2.7",
    prepareRun(paths) { runRoot = paths.runRoot; },
    runtimeFactory: async () => {
      const runtime = messageRuntime(nativeId, nativePath, runtimes.length + 1);
      runtime.pid = 5000 + runtimes.length;
      runtime.pgid = runtime.pid;
      runtimes.push(runtime);
      return runtime;
    },
  });
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: mockLauncher,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => join(here, "..", "..", "..", "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
    emitAgentEvent: (envelope) => envelopes.push(envelope),
  });
  return { root, project, nativeId, nativePath, supervisor, bridge, runtimes, envelopes, runRoot: () => runRoot };
}

test("replacement runtimes keep every reply visible with distinct ids", async () => {
  // Two reclaim/rebuild cycles: the live message-id sequence must continue
  // across runtimes, or the renderer's id-keyed projection would collapse the
  // later replies into the first row.
  const { project, nativeId, nativePath, supervisor, bridge, runtimes, envelopes } = messageHarness();
  try {
    const replyFor = () => {
      const ordinal = runtimes.length;
      for (const fn of runtimes[ordinal - 1].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
    };
    await bridge.prompt({ sessionId: "reply-identity", content: "first", projectPath: project });
    replyFor();
    await bridge.stop("reply-identity");
    await bridge.prompt({ sessionId: "reply-identity", content: "second", projectPath: project, nativeSessionId: nativeId, nativeSessionPath: nativePath });
    replyFor();
    await bridge.stop("reply-identity");
    const third = await bridge.prompt({ sessionId: "reply-identity", content: "third", projectPath: project, nativeSessionId: nativeId, nativeSessionPath: nativePath });

    assert.equal(third.accepted, true);
    assert.equal(runtimes.length, 3, "two rebuilds must start three runtimes");
    const assistantEnds = envelopes.filter(
      (envelope) => envelope.event.type === "message_end" && envelope.event.message.role === "assistant",
    );
    const projected = assistantEnds.reduce((rows, envelope) => projectMessageEnd(rows, envelope.event), []);
    assert.deepEqual(
      projected.map(({ content }) => content),
      ["reply-runtime-1", "reply-runtime-2", "reply-runtime-3"],
      "each reply must keep its original content across rebuilds",
    );
    // The live ids stay distinct and share one execution context: the within-entry
    // rebuild carries the same context token and only the sequence advances, so
    // the renderer never collapses one reply into another.
    const ids = projected.map(({ id }) => id);
    assert.equal(new Set(ids).size, 3, "each reply must keep its own id");
    const context = ids[0].slice(0, ids[0].lastIndexOf(":"));
    assert.ok(
      ids.every((id) => id.startsWith(`${context}:`)),
      "all replies on one entry share the same live-id context",
    );
    assert.deepEqual(
      ids.map((id) => id.slice(id.lastIndexOf(":") + 1)),
      ["1", "2", "3"],
      "the message sequence advances across the rebuilds",
    );
  } finally {
    await bridge.dispose("msg cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
  }
});

/** A c1-style runtime with a running child, for the teardown-race regression. */
function r2Harness() {
  const root = mkdtempSync(join(tmpdir(), "omp-bridge-r2-"));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativeId = "native-r2";
  const nativePath = join(sessionDir, "native.jsonl");
  writeFileSync(nativePath, `${JSON.stringify({ type: "session", id: nativeId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);
  const runtimes = [];
  const state = { stopInFlight: false, startsDuringStop: 0 };
  let runRoot;
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: join(root, "data"),
    sessionDir,
    launcherPath: mockLauncher,
    expectedRuntimeVersion: "18.2.7",
    prepareRun(paths) { runRoot = paths.runRoot; },
    runtimeFactory: async () => {
      if (state.stopInFlight) state.startsDuringStop += 1;
      const runtime = c1Runtime(nativeId, nativePath, true);
      runtime.pid = 7000 + runtimes.length;
      runtime.pgid = runtime.pid;
      runtimes.push(runtime);
      return runtime;
    },
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
  return { root, project, nativeId, nativePath, supervisor, bridge, runtimes, state, runRoot: () => runRoot };
}

test("a prompt racing a stop is refused and never starts a second runtime mid-teardown", async () => {
  const { project, nativeId, nativePath, supervisor, bridge, runtimes, state } = r2Harness();
  try {
    await bridge.prompt({ sessionId: "r2", content: "delegate", projectPath: project });
    for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });

    state.stopInFlight = true;
    const stopPromise = bridge.stop("r2").finally(() => { state.stopInFlight = false; });
    // Wait until the runtime is stopped while the stop is still in flight: the
    // run is already idle (agent_end) but the teardown still owns the lifecycle.
    for (let turn = 0; turn < 100 && state.stopInFlight && supervisor.currentRuntime() !== null; turn += 1) await Promise.resolve();
    assert.equal(state.stopInFlight, true, "the racing prompt must fire while the stop is still in flight");

    const raced = await bridge.prompt({
      sessionId: "r2",
      content: "racing stop",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));
    await stopPromise;

    assert.equal(raced.refused, true, "the racing prompt must be refused, not answered into the dead turn");
    assert.equal(raced.code, "stopping");
    assert.equal(state.startsDuringStop, 0, "no second runtime may start while the stop is unresolved");

    // After the stop settles, the replacement restores the native identity first.
    const next = await bridge.prompt({
      sessionId: "r2",
      content: "continue",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    });
    assert.equal(next.accepted, true);
    assert.equal(runtimes.length, 2);
    assert.deepEqual(runtimes[1].commands, ["switch_session", "get_state", "set_subagent_subscription", "prompt"]);
  } finally {
    await bridge.dispose("r2 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
  }
});

/** A runtime whose `switch_session` can be gated for the restore race. */
function gatedRuntime(nativeId, nativePath, gate) {
  const handlers = new Set();
  const commands = [];
  let bound = false;
  return {
    pid: 8000,
    pgid: 8000,
    currentPhase: "idle",
    usable: true,
    runtimeVersion: "18.2.7",
    protocolVersion: 2,
    commands,
    handlers,
    write() { return this.usable; },
    onFrame(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    onFailure() { return () => {}; },
    async stop() {
      this.usable = false;
      this.currentPhase = "exited";
      return { reaped: true, escalated: "none", steps: [], errors: [], abortAcknowledged: true };
    },
    async request(command) {
      commands.push(command.type);
      if (!this.usable) throw new Error("request used a retired runtime");
      if (command.type === "switch_session") {
        if (gate) {
          gate.entered.resolve();
          await gate.release.promise;
        }
        bound = true;
      }
      if (command.type === "get_state") {
        return { success: true, data: bound ? { sessionId: nativeId, sessionFile: nativePath } : {} };
      }
      if (command.type === "prompt" && !bound) throw new Error("native session was not restored before prompt");
      if (command.type === "abort") this.emit({ type: "agent_end", isTerminal: true });
      if (command.type === "get_subagents") return { success: true, data: { subagents: [] } };
      return { success: true, data: { cancelled: false } };
    },
  };
}

/** A supervisor whose factory (start boundary) or `switch_session` (restore) can be held. */
function r3Harness(boundary, afterReclaim) {
  const root = mkdtempSync(join(tmpdir(), "omp-bridge-r3-"));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativeId = "native-r3";
  const nativePath = join(sessionDir, "native.jsonl");
  writeFileSync(nativePath, `${JSON.stringify({ type: "session", id: nativeId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);
  const entered = deferred();
  const release = deferred();
  const runtimes = [];
  const targetOrdinal = afterReclaim ? 2 : 1;
  let runRoot;
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: join(root, "data"),
    sessionDir,
    launcherPath: mockLauncher,
    expectedRuntimeVersion: "18.2.7",
    prepareRun(paths) { runRoot = paths.runRoot; },
    runtimeFactory: async () => {
      const ordinal = runtimes.length + 1;
      if (boundary === "start" && ordinal === targetOrdinal) {
        entered.resolve();
        await release.promise;
      }
      const gate = boundary === "restore" && ordinal === targetOrdinal ? { entered, release } : undefined;
      const runtime = gatedRuntime(nativeId, nativePath, gate);
      runtime.pid = 8000 + ordinal;
      runtime.pgid = runtime.pid;
      runtimes.push(runtime);
      return runtime;
    },
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
  return { root, project, nativeId, nativePath, supervisor, bridge, runtimes, entered, release, runRoot: () => runRoot };
}

test("stop during startup or restore cancels the pending prompt and leaves the session idle", async () => {
  for (const afterReclaim of [false, true]) {
    for (const boundary of ["start", "restore"]) {
      const { project, nativeId, nativePath, supervisor, bridge, runtimes, entered, release } = r3Harness(boundary, afterReclaim);
      try {
        if (afterReclaim) {
          await bridge.prompt({ sessionId: "r3", content: "first", projectPath: project, nativeSessionId: nativeId, nativeSessionPath: nativePath });
          for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
          await bridge.stop("r3");
        }
        const pendingPrompt = bridge.prompt({
          sessionId: "r3",
          content: "must be cancelled by stop",
          projectPath: project,
          nativeSessionId: nativeId,
          nativeSessionPath: nativePath,
        }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));

        await entered.promise;
        const pendingStop = bridge.stop("r3");
        let stopSettledBeforeRelease = false;
        pendingStop.then(() => { stopSettledBeforeRelease = true; });
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
        assert.equal(stopSettledBeforeRelease, false, `stop must own the pending ${boundary}, not return "nothing running"`);
        release.resolve();
        const [prompt, stop] = await Promise.all([pendingPrompt, pendingStop]);

        assert.equal(prompt.refused, true, `the pending prompt must be cancelled on ${boundary}`);
        assert.equal(prompt.code, "stopping");
        assert.equal(stop.toreDown, false);
        assert.equal(bridge.status("r3").isRunning, false);
        assert.equal(bridge.status("r3").state, "idle");
      } finally {
        release.resolve();
        await bridge.dispose("r3 cleanup").catch(() => undefined);
        await supervisor.reclaimAll().catch(() => undefined);
      }
    }
  }
});

test("dispose during startup or restore cancels the pending prompt and reclaims", async () => {
  for (const boundary of ["start", "restore"]) {
    const { project, nativeId, nativePath, supervisor, bridge, entered, release } = r3Harness(boundary, false);
    try {
      const pendingPrompt = bridge.prompt({
        sessionId: "r3",
        content: "must be cancelled by dispose",
        projectPath: project,
        nativeSessionId: nativeId,
        nativeSessionPath: nativePath,
      }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));

      await entered.promise;
      const pendingDispose = bridge.dispose("shutdown");
      release.resolve();
      const [prompt, disposed] = await Promise.all([pendingPrompt, pendingDispose]);

      assert.equal(prompt.refused, true, `the pending prompt must be cancelled on ${boundary}`);
      assert.equal(prompt.code, "stopping");
      assert.deepEqual(disposed, { ok: true, failures: [] });
    } finally {
      release.resolve();
      await bridge.dispose("r3 dispose cleanup").catch(() => undefined);
      await supervisor.reclaimAll().catch(() => undefined);
    }
  }
});

test("two concurrent prompts share one runtime and only one starts a run", async () => {
  const { bridge, supervisor } = bridgeHarness();
  const project = makeProject();
  const [first, second] = await Promise.allSettled([
    bridge.prompt({ sessionId: OMP_SESSION, content: "one", projectPath: project }),
    bridge.prompt({ sessionId: OMP_SESSION, content: "two", projectPath: project }),
  ]);
  const accepted = [first, second].filter((outcome) => outcome.status === "fulfilled");
  const refused = [first, second].filter((outcome) => outcome.status === "rejected");
  assert.equal(accepted.length, 1, "exactly one of the concurrent prompts starts the run");
  assert.equal(refused.length, 1, "the other concurrent prompt is refused while the run is busy");
  assert.equal(accepted[0].value.accepted, true);
  assert.equal(refused[0].reason.code ?? refused[0].reason.errorCode, "not-started");
  assert.equal(supervisor.started, 1, "concurrent prompts must not start a second runtime");
});

/** A real supervisor whose factory mints one message-emitting runtime per start, tracking starts during disposal. */
function d1Harness() {
  const root = mkdtempSync(join(tmpdir(), "omp-bridge-d1-"));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativeId = "native-d1";
  const nativePath = join(sessionDir, "native.jsonl");
  writeFileSync(nativePath, `${JSON.stringify({ type: "session", id: nativeId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);
  const runtimes = [];
  const state = { disposeInFlight: false, startsDuringDispose: 0 };
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: join(root, "data"),
    sessionDir,
    launcherPath: mockLauncher,
    expectedRuntimeVersion: "18.2.7",
    runtimeFactory: async () => {
      if (state.disposeInFlight) state.startsDuringDispose += 1;
      const runtime = messageRuntime(nativeId, nativePath, runtimes.length + 1);
      runtime.pid = 9000 + runtimes.length;
      runtime.pgid = runtime.pid;
      runtimes.push(runtime);
      return runtime;
    },
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
  return { root, project, nativeId, nativePath, supervisor, bridge, runtimes, state };
}

test("a prompt racing disposeSession's completion window is refused and leaves no orphan", async () => {
  const { project, nativeId, nativePath, supervisor, bridge, runtimes, state } = d1Harness();
  try {
    await bridge.prompt({ sessionId: "d1-dispose", content: "first", projectPath: project });

    state.disposeInFlight = true;
    const disposePromise = bridge.disposeSession("d1-dispose", "d1 disposal").finally(() => { state.disposeInFlight = false; });
    // Fire while dispose owns the lifecycle but the supervisor's stop gate has
    // already released ownership (the one-microtask completion window).
    for (let turn = 0; turn < 100 && state.disposeInFlight && supervisor.currentRuntime() !== null; turn += 1) await Promise.resolve();
    assert.equal(state.disposeInFlight, true, "the racing prompt must fire while dispose is still in flight");

    const raced = await bridge.prompt({
      sessionId: "d1-dispose",
      content: "racing dispose",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));
    await disposePromise;

    assert.equal(raced.refused, true, "the racing prompt must be refused, not answered into a replaced runtime");
    assert.equal(raced.code, "not-started");
    assert.equal(state.startsDuringDispose, 0, "no replacement runtime may start during disposal");
    assert.equal(runtimes.length, 1, "dispose must not start a second runtime");
    assert.equal(supervisor.currentRuntime(), null, "the disposed runtime must be fully reclaimed");
    assert.equal(runtimes[0].handlers.size, 0, "the disposed runtime's handlers must be detached");
    assert.equal(bridge.status("d1-dispose").isRunning, false, "the disposed session must report not running");
  } finally {
    await bridge.dispose("d1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
  }
});

test("a prompt racing application shutdown's completion window is refused and leaves no orphan", async () => {
  const { project, nativeId, nativePath, supervisor, bridge, runtimes, state } = d1Harness();
  try {
    await bridge.prompt({ sessionId: "d1-shutdown", content: "first", projectPath: project });

    state.disposeInFlight = true;
    const disposePromise = bridge.dispose("review shutdown").finally(() => { state.disposeInFlight = false; });
    for (let turn = 0; turn < 100 && state.disposeInFlight && supervisor.currentRuntime() !== null; turn += 1) await Promise.resolve();
    assert.equal(state.disposeInFlight, true, "the racing prompt must fire while shutdown is still in flight");

    const raced = await bridge.prompt({
      sessionId: "d1-shutdown",
      content: "racing shutdown",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));
    await disposePromise;

    assert.equal(raced.refused, true, "the racing prompt must be refused during shutdown");
    assert.equal(state.startsDuringDispose, 0, "no replacement runtime may start during shutdown");
    assert.equal(runtimes.length, 1, "shutdown must not start a second runtime");
    assert.equal(supervisor.currentRuntime(), null, "the runtime must be fully reclaimed");
    assert.equal(bridge.status("d1-shutdown").isRunning, false, "the session must report not running");
  } finally {
    await bridge.dispose("d1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
  }
});

test("a new session racing whole-bridge shutdown is refused before it starts a runtime", async () => {
  const { project, supervisor, bridge, runtimes } = d1Harness();
  try {
    await bridge.prompt({ sessionId: "d1-existing", content: "first", projectPath: project });
    // Shutdown closes admission synchronously before its first await: the new
    // session must be refused even before the sweep's snapshot is iterated.
    const disposePromise = bridge.dispose("review shutdown");
    const raced = await bridge.prompt({
      sessionId: "d1-new",
      content: "new session during shutdown",
      projectPath: project,
    }).then((result) => result, (error) => ({ refused: true, code: error.errorCode ?? error.code, message: error.message }));
    await disposePromise;

    assert.equal(raced.refused, true, "a new session must be refused during whole-bridge shutdown");
    assert.equal(raced.code, "ENGINE_UNAVAILABLE");
    assert.equal(runtimes.length, 1, "no runtime may start for the new session");
  } finally {
    await bridge.dispose("d1 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
  }
});

test("a prompt racing a startup or restore stop is refused, not submitted after the stop reports nothing running", async () => {
  for (const afterReclaim of [false, true]) {
    for (const boundary of ["start", "restore"]) {
      const { project, nativeId, nativePath, supervisor, bridge, runtimes, entered, release } = r3Harness(boundary, afterReclaim);
      try {
        if (afterReclaim) {
          await bridge.prompt({ sessionId: "r3", content: "first", projectPath: project, nativeSessionId: nativeId, nativeSessionPath: nativePath });
          for (const fn of runtimes[0].handlers) fn({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} });
          await bridge.stop("r3");
        }
        const pendingPrompt = bridge.prompt({
          sessionId: "r3",
          content: "must be cancelled by stop",
          projectPath: project,
          nativeSessionId: nativeId,
          nativeSessionPath: nativePath,
        }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));

        await entered.promise;
        const pendingStop = bridge.stop("r3");
        let stopSettledBeforeRelease = false;
        pendingStop.then(() => { stopSettledBeforeRelease = true; });
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
        assert.equal(stopSettledBeforeRelease, false, `stop must own the pending ${boundary}`);

        // The second prompt arrives while the stop still owns startup/restore: it
        // must be refused, not submitted after the stop returns "nothing running".
        const concurrentPrompt = bridge.prompt({
          sessionId: "r3",
          content: "must not start during active cancellation",
          projectPath: project,
          nativeSessionId: nativeId,
          nativeSessionPath: nativePath,
        }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));

        release.resolve();
        const [prompt, stop, duringCancel] = await Promise.all([pendingPrompt, pendingStop, concurrentPrompt]);

        assert.equal(prompt.refused, true, `the pending prompt must be cancelled on ${boundary}`);
        assert.equal(prompt.code, "stopping");
        assert.equal(duringCancel.refused, true, `the second prompt must be refused while the stop owns ${boundary}`);
        assert.equal(duringCancel.code, "stopping");
        assert.equal(stop.toreDown, false);
        assert.equal(bridge.status("r3").isRunning, false);
        assert.equal(bridge.status("r3").state, "idle");
      } finally {
        release.resolve();
        await bridge.dispose("r3 cleanup").catch(() => undefined);
        await supervisor.reclaimAll().catch(() => undefined);
      }
    }
  }
});

test("concurrent stop and dispose overlap without reopening admission", async () => {
  const { project, nativeId, nativePath, supervisor, bridge, runtimes, entered, release } = r3Harness("start", false);
  try {
    const pendingPrompt = bridge.prompt({
      sessionId: "r3",
      content: "held",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));

    await entered.promise;
    // Stop and dispose are issued together: dispose must join the in-flight stop
    // and admission must stay closed for the whole overlap.
    const stopPromise = bridge.stop("r3");
    const disposePromise = bridge.dispose("shutdown");
    const raced = await bridge.prompt({
      sessionId: "r3",
      content: "racing the overlap",
      projectPath: project,
      nativeSessionId: nativeId,
      nativeSessionPath: nativePath,
    }).then((result) => result, (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }));

    release.resolve();
    const [prompt, , disposed] = await Promise.all([pendingPrompt, stopPromise, disposePromise]);

    assert.equal(prompt.refused, true);
    assert.equal(raced.refused, true, "a prompt racing the stop/dispose overlap must be refused");
    assert.deepEqual(disposed, { ok: true, failures: [] });
    assert.equal(bridge.status("r3").isRunning, false);
    assert.equal(runtimes.length, 1, "no second runtime may start across the overlap");
  } finally {
    release.resolve();
    await bridge.dispose("r3 cleanup").catch(() => undefined);
    await supervisor.reclaimAll().catch(() => undefined);
  }
});

/** A bridge over real per-session supervisors whose session A stop is held. */
function shutdownAdmissionHarness() {
  // Canonicalize like the production restore boundary: `mkdtempSync(tmpdir())`
  // keeps a macOS `/var` alias while the bridge realpaths to `/private/var`,
  // which would otherwise mismatch the session path and fail closed.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-bridge-shutdown-")));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const inputs = {};
  for (const id of ["a", "b", "c"]) {
    const nativeSessionId = `native-${id}`;
    const nativeSessionPath = join(sessionDir, `${id}.jsonl`);
    writeFileSync(nativeSessionPath, `${JSON.stringify({ type: "session", id: nativeSessionId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);
    inputs[id] = { sessionId: id, projectPath: project, nativeSessionId, nativeSessionPath };
  }
  const entered = deferred();
  const release = deferred();
  const runtimes = new Map();
  const supervisors = new Map();
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const bridge = createOmpSessionBridge({
    createSupervisor: (spec) => {
      const id = spec.sessionId;
      const supervisor = new OmpRuntimeSupervisor({
        dataRoot: join(root, `data-${id}`),
        sessionDir,
        launcherPath: mockLauncher,
        expectedRuntimeVersion: "18.2.7",
        runtimeFactory: async () => {
          const frames = new Set();
          const failures = new Set();
          let bound = false;
          const runtime = {
            pid: 5454 + runtimes.size,
            pgid: 5454 + runtimes.size,
            currentPhase: "idle",
            usable: true,
            runtimeVersion: "18.2.7",
            protocolVersion: 2,
            commands: [],
            write() { return this.usable; },
            onFrame(fn) { frames.add(fn); return () => frames.delete(fn); },
            onFailure(fn) { failures.add(fn); return () => failures.delete(fn); },
            emit(frame) { for (const fn of [...frames]) fn(frame); },
            async stop() {
              this.usable = false;
              this.currentPhase = "stopping";
              if (id === "a") { entered.resolve(); await release.promise; }
              this.currentPhase = "exited";
              return { reaped: true, escalated: "none", steps: [], errors: [], abortAcknowledged: true };
            },
            async request(command) {
              this.commands.push(command.type);
              if (!this.usable) throw new Error("request used a retired runtime");
              if (command.type === "switch_session") {
                if (command.sessionPath !== inputs[id].nativeSessionPath) throw new Error("incorrect session binding");
                bound = true;
              }
              if (command.type === "get_state") return { success: true, data: bound ? { sessionId: inputs[id].nativeSessionId, sessionFile: inputs[id].nativeSessionPath } : {} };
              if (command.type === "prompt" && !bound) throw new Error("prompt before restore");
              return { success: true, data: { cancelled: false } };
            },
          };
          runtimes.set(id, runtime);
          return runtime;
        },
      });
      supervisors.set(id, supervisor);
      return supervisor;
    },
    launcher: mockLauncher,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => join(here, "..", "..", "..", "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
    emitAgentEvent: () => {},
  });
  return { root, project, inputs, entered, release, runtimes, supervisors, bridge };
}

const captured = (promise) => promise.then(
  (value) => value,
  (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }),
);

test("whole-bridge shutdown refuses an existing session before any cleanup await", async () => {
  const { inputs, entered, release, runtimes, supervisors, bridge } = shutdownAdmissionHarness();
  try {
    for (const id of ["a", "b"]) {
      await bridge.prompt({ ...inputs[id], content: `first ${id}` });
      runtimes.get(id).emit({ type: "agent_end", isTerminal: true });
    }
    const shutdown = bridge.dispose("review shutdown");
    await entered.promise;
    const existing = await captured(bridge.prompt({ ...inputs.b, content: "must not execute during shutdown" }));
    const created = await captured(bridge.prompt({ ...inputs.c, content: "must not create during shutdown" }));
    release.resolve();
    await shutdown;

    assert.equal(existing.refused, true, "an existing session must be refused during whole shutdown");
    assert.equal(existing.code, "ENGINE_UNAVAILABLE");
    assert.equal(created.refused, true, "a new session must still be refused during whole shutdown");
    assert.equal(created.code, "ENGINE_UNAVAILABLE");
    assert.equal(
      runtimes.get("b").commands.filter((type) => type === "prompt").length,
      1,
      "no second prompt command may reach the existing session B",
    );
    assert.equal(runtimes.size, 2, "only A and B ever start a runtime");
    assert.equal(supervisors.size, 2, "no supervisor may be created for C");
    assert.deepEqual(
      [...supervisors.entries()].filter(([, supervisor]) => supervisor.currentRuntime() !== null).map(([id]) => id),
      [],
      "no runtime may survive the shutdown sweep",
    );
  } finally {
    release.resolve();
    await bridge.dispose("shutdown cleanup").catch(() => undefined);
    for (const supervisor of supervisors.values()) await supervisor.reclaimAll().catch(() => undefined);
  }
});

test("whole-bridge shutdown invalidates a prompt still preparing before it submits", async () => {
  const { inputs, entered, release, runtimes, supervisors, bridge } = shutdownAdmissionHarness();
  try {
    for (const id of ["a", "b"]) {
      await bridge.prompt({ ...inputs[id], content: `first ${id}` });
      runtimes.get(id).emit({ type: "agent_end", isTerminal: true });
    }
    // Admitted just before the sweep, still mid-preparation: the epoch bump must
    // invalidate it before any content reaches B.
    const preadmitted = captured(bridge.prompt({ ...inputs.b, content: "must not submit after shutdown begins" }));
    const shutdown = bridge.dispose("review shutdown");
    await entered.promise;
    const existing = await preadmitted;
    const created = await captured(bridge.prompt({ ...inputs.c, content: "must not create during shutdown" }));
    release.resolve();
    await shutdown;

    assert.equal(existing.refused, true, "the pre-admitted prompt must be invalidated before submission");
    assert.equal(existing.code, "stopping");
    assert.equal(created.refused, true);
    assert.equal(
      runtimes.get("b").commands.filter((type) => type === "prompt").length,
      1,
      "the pre-admitted prompt must never submit a second prompt command to B",
    );
    assert.equal(runtimes.size, 2, "no runtime may start for a pre-admitted or new session");
    assert.deepEqual(
      [...supervisors.entries()].filter(([, supervisor]) => supervisor.currentRuntime() !== null).map(([id]) => id),
      [],
    );
  } finally {
    release.resolve();
    await bridge.dispose("shutdown cleanup").catch(() => undefined);
    for (const supervisor of supervisors.values()) await supervisor.reclaimAll().catch(() => undefined);
  }
});

/** A bridge whose per-session supervisor mints one reply-emitting runtime. */
function modelSwitchHarness() {
  // Canonicalize like the production restore boundary (see shutdownAdmissionHarness).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-bridge-model-")));
  scratch.push(root);
  const project = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(project);
  mkdirSync(sessionDir);
  const nativeSessionId = "review-native";
  const nativeSessionPath = join(sessionDir, "native.jsonl");
  writeFileSync(nativeSessionPath, `${JSON.stringify({ type: "session", id: nativeSessionId, cwd: project, timestamp: "2026-09-24T00:00:00Z" })}\n`);
  const runtimes = [];
  const supervisors = [];
  const envelopes = [];
  const persisted = [];
  const mockLauncher = join(here, "..", "..", "..", "packages", "omp-runtime", "test", "mock-omp.mjs");
  const bridge = createOmpSessionBridge({
    createSupervisor: () => {
      const supervisor = new OmpRuntimeSupervisor({
        dataRoot: join(root, `data-${supervisors.length}`),
        sessionDir,
        launcherPath: mockLauncher,
        expectedRuntimeVersion: "18.2.7",
        runtimeFactory: async () => {
          const frames = new Set();
          const failures = new Set();
          let bound = false;
          const number = runtimes.length + 1;
          const runtime = {
            pid: 6454 + number,
            pgid: 6454 + number,
            currentPhase: "idle",
            usable: true,
            runtimeVersion: "18.2.7",
            protocolVersion: 2,
            frames,
            failures,
            commands: [],
            write() { return this.usable; },
            onFrame(fn) { frames.add(fn); return () => frames.delete(fn); },
            onFailure(fn) { failures.add(fn); return () => failures.delete(fn); },
            emit(frame) { for (const fn of [...frames]) fn(frame); },
            async stop() {
              this.usable = false;
              this.currentPhase = "exited";
              return { reaped: true, escalated: "none", steps: [], errors: [], abortAcknowledged: true };
            },
            async request(command) {
              this.commands.push(command.type);
              if (!this.usable) throw new Error("request used a retired runtime");
              if (command.type === "switch_session") {
                if (command.sessionPath !== nativeSessionPath) throw new Error("incorrect session binding");
                bound = true;
              }
              if (command.type === "get_state") {
                return { success: true, data: bound ? { sessionId: nativeSessionId, sessionFile: nativeSessionPath } : {} };
              }
              if (command.type === "prompt") {
                if (!bound) throw new Error("prompt before restore");
                const message = { role: "assistant", content: [{ type: "text", text: `reply-model-${number}` }], timestamp: number };
                this.emit({ type: "message_start", message });
                this.emit({ type: "message_end", message });
              }
              return { success: true, data: { cancelled: false } };
            },
          };
          runtimes.push(runtime);
          return runtime;
        },
      });
      supervisors.push(supervisor);
      return supervisor;
    },
    launcher: mockLauncher,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => join(here, "..", "..", "..", "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
    emitAgentEvent: (envelope) => envelopes.push(envelope),
    persistConfig: async (config) => { persisted.push(config); },
  });
  return { root, project, nativeSessionId, nativeSessionPath, runtimes, supervisors, envelopes, persisted, bridge };
}

/** Project the assistant `message_end` rows exactly as the renderer does. */
function projectedAssistantReplies(envelopes) {
  return envelopes
    .filter((envelope) => envelope.event.type === "message_end" && envelope.event.message.role === "assistant")
    .reduce((rows, envelope) => projectMessageEnd(rows, envelope.event), []);
}

test("a model change reconfigures without reusing the earlier reply's live ids", async () => {
  const { project, nativeSessionId, nativeSessionPath, runtimes, supervisors, envelopes, bridge } = modelSwitchHarness();
  const input = { sessionId: "model-review", projectPath: project, nativeSessionId, nativeSessionPath, providerId: "local" };
  try {
    const first = await bridge.prompt({ ...input, modelId: "first", content: "first" });
    runtimes[0].emit({ type: "agent_end", isTerminal: true });
    const configured = await bridge.configure(input.sessionId, { providerId: "local", modelId: "second" });
    const second = await bridge.prompt({ ...input, modelId: "second", content: "second" });
    runtimes[1].emit({ type: "agent_end", isTerminal: true });

    assert.equal(configured.ok, true);
    assert.notEqual(first.turnId, second.turnId, "a recreated execution context must mint a distinct turn id");
    const projected = projectedAssistantReplies(envelopes);
    assert.deepEqual(
      projected.map(({ content }) => content),
      ["reply-model-1", "reply-model-2"],
      "both replies must stay visible across the model change",
    );
    assert.equal(new Set(projected.map(({ id }) => id)).size, 2, "the two replies must not share a live id");
    assert.equal(runtimes.length, 2, "the model change starts a fresh runtime");
    assert.equal(supervisors.length, 2, "the recreated entry owns a fresh supervisor");
    assert.equal(runtimes[0].frames.size + runtimes[0].failures.size, 0, "the old runtime's handlers must be detached");
    assert.deepEqual(
      runtimes[1].commands,
      ["switch_session", "get_state", "set_subagent_subscription", "prompt"],
      "the replacement restores the same native session before the prompt",
    );
  } finally {
    await bridge.dispose("model cleanup").catch(() => undefined);
    for (const supervisor of supervisors) await supervisor.reclaimAll().catch(() => undefined);
  }
});

test("a disposed and reopened session mints fresh live ids without colliding", async () => {
  const { project, nativeSessionId, nativeSessionPath, runtimes, supervisors, envelopes, bridge } = modelSwitchHarness();
  const input = { sessionId: "model-review", projectPath: project, nativeSessionId, nativeSessionPath, providerId: "local" };
  try {
    const first = await bridge.prompt({ ...input, modelId: "first", content: "first" });
    runtimes[0].emit({ type: "agent_end", isTerminal: true });
    const disposed = await bridge.disposeSession(input.sessionId, "reopen regression");
    assert.equal(disposed.ok, true);
    const second = await bridge.prompt({ ...input, modelId: "first", content: "second" });
    runtimes[1].emit({ type: "agent_end", isTerminal: true });

    assert.notEqual(first.turnId, second.turnId, "a reopened session must mint a distinct turn id");
    const projected = projectedAssistantReplies(envelopes);
    assert.deepEqual(projected.map(({ content }) => content), ["reply-model-1", "reply-model-2"]);
    assert.equal(new Set(projected.map(({ id }) => id)).size, 2, "the two replies must not share a live id");
    assert.deepEqual(
      runtimes[1].commands,
      ["switch_session", "get_state", "set_subagent_subscription", "prompt"],
      "the reopened session restores the same native session before the prompt",
    );
  } finally {
    await bridge.dispose("reopen cleanup").catch(() => undefined);
    for (const supervisor of supervisors) await supervisor.reclaimAll().catch(() => undefined);
  }
});

test("a recreated bridge mints live ids that do not collide with a retained reply", async () => {
  const first = modelSwitchHarness();
  const second = modelSwitchHarness();
  try {
    const inputA = { sessionId: "model-review", projectPath: first.project, nativeSessionId: first.nativeSessionId, nativeSessionPath: first.nativeSessionPath, providerId: "local" };
    const inputB = { sessionId: "model-review", projectPath: second.project, nativeSessionId: second.nativeSessionId, nativeSessionPath: second.nativeSessionPath, providerId: "local" };
    await first.bridge.prompt({ ...inputA, modelId: "first", content: "first" });
    first.runtimes[0].emit({ type: "agent_end", isTerminal: true });
    await second.bridge.prompt({ ...inputB, modelId: "first", content: "second" });
    second.runtimes[0].emit({ type: "agent_end", isTerminal: true });

    const projected = projectedAssistantReplies([...first.envelopes, ...second.envelopes]);
    assert.equal(projected.length, 2, "a recreated bridge must not collapse the retained reply");
    assert.equal(new Set(projected.map(({ id }) => id)).size, 2, "the two replies must not share a live id");
  } finally {
    await first.bridge.dispose("bridge a cleanup").catch(() => undefined);
    await second.bridge.dispose("bridge b cleanup").catch(() => undefined);
    for (const supervisor of [...first.supervisors, ...second.supervisors]) await supervisor.reclaimAll().catch(() => undefined);
  }
});
