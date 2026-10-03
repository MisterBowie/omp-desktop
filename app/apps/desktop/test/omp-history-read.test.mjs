import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The bridge's read-only history path (M5/T20-R2).
 *
 * `sessionGet` for an OMP session must show the transcript the runtime wrote,
 * without a turn: no prompt, no provider call, no tool, no transcript write,
 * and no provider credential required to start the reader. These tests pin the
 * parts a fake runtime can prove deterministically — which runtime profile is
 * used, the command order (including stepping off the transcript before the
 * process is reclaimed, so the runtime's own `session_exit` diagnostic cannot
 * land in the read transcript), the identity/version refusals, the supersede
 * ledger, and that every failure surfaces as an error rather than an empty
 * page. The real pinned runtime is exercised in `omp-history-e2e.test.mjs`.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { serveTurnFenceCommand } = await import(
  "../../../packages/omp-runtime/src/session/turn-fence-testkit.ts"
);

const OMP_SESSION = "session-omp";
const GATE = "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts";
const LAUNCHER = "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp";

const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});

/** A directory that exists, because the bridge refuses a project path that does not. */
function makeProject() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "omp-history-project-")));
  scratch.push(path);
  return path;
}

class FakeRuntime {
  pid = 4321;
  usable = true;
  commands = [];
  /** Scripted `get_entries` payload (or a failure). */
  entriesResponse = { success: true, data: { entries: [], leafId: null } };
  /** Scripted `get_state` payload. */
  state = null;
  switchResponse = { success: true, data: { cancelled: false } };
  #frames = new Set();

  async request(command) {
    const fence = serveTurnFenceCommand(command, (frame) => this.push(frame));
    if (fence) return fence;
    this.commands.push(command.type);
    if (command.type === "switch_session") return this.switchResponse;
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "get_entries") return this.entriesResponse;
    if (command.type === "get_state") return { success: true, data: this.state };
    return { success: true };
  }

  onFrame(handler) {
    this.#frames.add(handler);
    return () => this.#frames.delete(handler);
  }

  onFailure() {
    return () => undefined;
  }

  push(frame) {
    for (const handler of [...this.#frames]) handler(frame);
  }
}

function fakeSupervisor(runtime) {
  return {
    started: 0,
    stopped: [],
    reclaimed: 0,
    calls: [],
    workingDirectory: null,
    pendingCleanup: [],
    setWorkingDirectory(path) {
      if (this.started > 0) throw new Error("the runtime is running");
      this.calls.push(`setWorkingDirectory:${path}`);
      this.workingDirectory = path;
    },
    status() {
      return {
        engine: "omp",
        phase: this.started > 0 ? "idle" : "stopped",
        runtimeVersion: this.started > 0 ? "18.3.0" : null,
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
      this.calls.push("stop");
      this.stopped.push(options ?? {});
      return {
        reaped: true,
        cleaned: true,
        escalated: "none",
        steps: ["fake stop"],
        abortAcknowledged: true,
        errors: [],
      };
    },
    async reclaimAll() {
      this.reclaimed += 1;
      return [];
    },
    currentRuntime: () => (runtime.usable ? runtime : null),
  };
}

/** The three-message transcript every projection case reads. */
const TRANSCRIPT_ENTRIES = [
  { id: "m1", parentId: null, type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
  { id: "m2", parentId: "m1", type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 } },
  { id: "m3", parentId: "m2", type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "body" }], timestamp: 3 } },
];

function readHarness() {
  const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "omp-history-sessions-")));
  const project = makeProject();
  scratch.push(sessionDir);
  const nativeSessionId = "native-id";
  const nativeSessionPath = join(sessionDir, "native-session.jsonl");
  writeFileSync(
    nativeSessionPath,
    `${JSON.stringify({ type: "session", id: nativeSessionId, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  const envelopes = [];
  const readSupervisors = [];
  const readRuntimes = [];
  const promptSupervisors = [];
  const promptRuntimes = [];
  /** Supervisors the next `createReadSupervisor` call returns, in order. */
  const scriptedReaders = [];
  const createRuntime = () => {
    const runtime = new FakeRuntime();
    runtime.state = { sessionId: nativeSessionId, sessionFile: nativeSessionPath, sessionName: "session", isStreaming: false };
    runtime.entriesResponse = {
      success: true,
      data: { entries: TRANSCRIPT_ENTRIES, leafId: TRANSCRIPT_ENTRIES.at(-1).id },
    };
    return runtime;
  };
  const firstRuntime = createRuntime();
  const firstSupervisor = fakeSupervisor(firstRuntime);
  promptRuntimes.push(firstRuntime);
  promptSupervisors.push(firstSupervisor);
  let promptCreated = 0;
  const promptFactoryCalls = [];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => {
      promptFactoryCalls.push(promptCreated);
      if (promptCreated === 0) {
        promptCreated += 1;
        return firstSupervisor;
      }
      const runtime = createRuntime();
      const supervisor = fakeSupervisor(runtime);
      promptRuntimes.push(runtime);
      promptSupervisors.push(supervisor);
      promptCreated += 1;
      return supervisor;
    },
    createReadSupervisor: () => {
      const supervisor = scriptedReaders.shift();
      if (supervisor) return supervisor;
      const runtime = createRuntime();
      const created = fakeSupervisor(runtime);
      readRuntimes.push(runtime);
      readSupervisors.push(created);
      return created;
    },
    launcher: LAUNCHER,
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    emitAgentEvent: (envelope) => envelopes.push(envelope),
    logger: { app: () => undefined },
    gateResolver: () => GATE,
  });
  return {
    bridge,
    sessionDir,
    nativeSessionId,
    nativeSessionPath,
    project,
    envelopes,
    readSupervisors,
    readRuntimes,
    promptSupervisors,
    promptRuntimes,
    scriptedReaders,
    promptFactoryCalls,
    createRuntime,
    identity: {
      sessionId: OMP_SESSION,
      projectPath: project,
      providerId: "fake-provider",
      modelId: "local-model",
      nativeSessionId,
      nativeSessionPath,
      adapterVersion: 1,
      runtimeVersion: "18.3.0",
    },
  };
}

test("a session with no native reference reads as empty and starts nothing", async () => {
  const { bridge, project, readSupervisors, promptFactoryCalls } = readHarness();
  const result = await bridge.readHistory({
    sessionId: OMP_SESSION,
    projectPath: project,
    nativeSessionId: null,
    nativeSessionPath: null,
  });
  assert.deepEqual(result.messages, []);
  assert.equal(result.messageCount, 0);
  assert.deepEqual(result.replacedLiveMessageIds, []);
  assert.equal(readSupervisors.length, 0);
  assert.deepEqual(promptFactoryCalls, []);
});

test("a cold read uses the read-only profile and leaves the transcript before reclaiming", async () => {
  const { bridge, identity, readSupervisors, readRuntimes, promptFactoryCalls } = readHarness();
  const result = await bridge.readHistory(identity);
  assert.deepEqual(promptFactoryCalls, [], "a history read must not use the prompt profile");
  assert.equal(readSupervisors.length, 1);
  const supervisor = readSupervisors[0];
  const runtime = readRuntimes[0];
  assert.deepEqual(runtime.commands, ["switch_session", "get_state", "get_entries", "new_session"]);
  assert.ok(
    runtime.commands.includes("new_session"),
    "the reader must leave the session before it is reclaimed (no session_exit in the transcript)",
  );
  assert.deepEqual(supervisor.calls.slice(0, 2), [`setWorkingDirectory:${identity.projectPath}`, "start"]);
  assert.equal(supervisor.stopped.length, 1);
  assert.equal(supervisor.reclaimed, 0);
  assert.deepEqual(
    result.messages.map((message) => [message.id, message.role, message.content]),
    [
      ["omp:session-omp:entry:m1", "user", "hello"],
      ["omp:session-omp:entry:m2", "assistant", "hi"],
      ["call-1", "tool", "body"],
    ],
  );
  assert.equal(result.messageCount, 3);
  assert.equal(result.messageStart, 0);
  assert.equal(result.hasMoreBefore, false);
});

test("a missing, foreign or unreadable reference fails closed without starting a runtime", async () => {
  const { bridge, identity, sessionDir, readSupervisors } = readHarness();

  await assert.rejects(
    () => bridge.readHistory({ ...identity, nativeSessionPath: "/tmp/somewhere-else.jsonl" }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  const impostor = join(sessionDir, "impostor.jsonl");
  writeFileSync(
    impostor,
    `${JSON.stringify({ type: "session", id: "someone-else", cwd: identity.projectPath, timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  await assert.rejects(
    () => bridge.readHistory({ ...identity, nativeSessionPath: impostor }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  await assert.rejects(
    () => bridge.readHistory({ ...identity, nativeSessionPath: null }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  await assert.rejects(
    () => bridge.readHistory({ ...identity, adapterVersion: 99 }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  assert.equal(readSupervisors.length, 0);
});

test("a reader that opens another session is refused, and its process is still reclaimed", async () => {
  const harness = readHarness();
  const runtime = harness.createRuntime();
  runtime.state = { sessionId: "different-session", sessionFile: harness.nativeSessionPath, sessionName: "other" };
  runtime.entriesResponse = { success: true, data: { entries: TRANSCRIPT_ENTRIES, leafId: "m3" } };
  const supervisor = fakeSupervisor(runtime);
  harness.scriptedReaders.push(supervisor);

  await assert.rejects(
    () => harness.bridge.readHistory(harness.identity),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  assert.equal(supervisor.stopped.length, 1);
  // A clean stop needs no sweep: only a reaped stop that left a directory debt
  // reclaims again (and that path is covered by the leak test below).
  assert.equal(supervisor.reclaimed, 0);
});

test("a refused get_entries throws instead of returning an empty transcript, and reclaims the reader", async () => {
  const harness = readHarness();
  const runtime = harness.createRuntime();
  runtime.entriesResponse = { success: false, error: "unknown_since" };
  const supervisor = fakeSupervisor(runtime);
  harness.scriptedReaders.push(supervisor);

  await assert.rejects(
    () => harness.bridge.readHistory(harness.identity),
    (error) => error.errorCode === "OMP_HISTORY_READ_FAILED",
  );
  assert.equal(supervisor.stopped.length, 1);
  assert.equal(supervisor.reclaimed, 0);
});

test("a reader that cannot be reclaimed reports failure instead of a silent leak", async () => {
  const harness = readHarness();
  const runtime = harness.createRuntime();
  const supervisor = fakeSupervisor(runtime);
  supervisor.pendingCleanup.push({ pid: 1 });
  supervisor.stop = async function stop() {
    this.stopped.push({});
    return { reaped: true, cleaned: false, escalated: "none", steps: [], abortAcknowledged: true, errors: [] };
  };
  supervisor.reclaimAll = async function reclaimAll() {
    this.reclaimed += 1;
    return [];
  };
  harness.scriptedReaders.push(supervisor);

  await assert.rejects(
    () => harness.bridge.readHistory(harness.identity),
    (error) => error.errorCode === "OMP_HISTORY_READ_FAILED" && /reclaimed/.test(error.message),
  );
  assert.equal(supervisor.reclaimed, 1);
});

test("a live runtime is reused, and a tail read names only the settled live rows it replaced", async () => {
  const harness = readHarness();
  const { bridge, identity, promptRuntimes, readSupervisors } = harness;
  await bridge.prompt({
    sessionId: identity.sessionId,
    content: "hello",
    projectPath: identity.projectPath,
    nativeSessionId: identity.nativeSessionId,
    nativeSessionPath: identity.nativeSessionPath,
    adapterVersion: 1,
    runtimeVersion: "18.3.0",
    userMessageId: "11111111-2222-4333-8444-555555555555",
  });
  const promptRuntime = promptRuntimes[0];
  promptRuntime.push({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  promptRuntime.push({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  promptRuntime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  promptRuntime.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  promptRuntime.push({ type: "tool_execution_start", toolCallId: "call-open", toolName: "bash", args: {} });

  // The admitted prompt's native echo re-keys the optimistic row exactly once,
  // and its row carries the live id (never the renderer's UUID).
  const persisted = harness.envelopes.filter((envelope) => envelope.event.type === "user_message_persisted");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].event.optimisticMessageId, "11111111-2222-4333-8444-555555555555");
  const liveUserRowId = persisted[0].event.message.id;
  const liveAssistantRowId = harness.envelopes.find(
    (envelope) => envelope.event.type === "message_end" && envelope.event.message.role === "assistant",
  ).event.message.id;

  const result = await bridge.readHistory({ ...identity, messageLimit: 1 });
  assert.equal(readSupervisors.length, 0, "a live runtime must be asked, not a second process");
  assert.equal(promptRuntime.commands.filter((command) => command === "get_entries").length, 1);
  assert.deepEqual(result.replacedLiveMessageIds, [liveUserRowId, liveAssistantRowId]);
  // The in-flight tool row is not superseded, and the widened window still
  // covers every superseded row even though the caller asked for one.
  assert.equal(result.replacedLiveMessageIds.includes("call-open"), false);
  assert.equal(result.messageStart, 0);
  assert.equal(result.hasMoreBefore, false);

  // An older page never names live rows: it does not contain their twins.
  const older = await bridge.readHistory({ ...identity, messageBefore: 1, messageLimit: 1 });
  assert.deepEqual(older.replacedLiveMessageIds, []);

  // The turn's terminal settles the open tool row and the optimistic row the
  // prompt announced (a renderer that missed the re-key still holds it), so
  // the next tail read names all three.
  promptRuntime.push({ type: "tool_execution_end", toolCallId: "call-open", toolName: "bash", result: "done" });
  promptRuntime.push({ type: "agent_end", messages: [] });
  const afterTurn = await bridge.readHistory({ ...identity });
  assert.deepEqual(afterTurn.replacedLiveMessageIds, [
    "11111111-2222-4333-8444-555555555555",
    liveUserRowId,
    liveAssistantRowId,
    "call-open",
  ]);
});

test("an in-flight prompt's optimistic row is never superseded, and a prompt without one records nothing", async () => {
  const harness = readHarness();
  const { bridge, identity } = harness;
  await bridge.prompt({
    sessionId: identity.sessionId,
    content: "hello",
    projectPath: identity.projectPath,
    nativeSessionId: identity.nativeSessionId,
    nativeSessionPath: identity.nativeSessionPath,
    userMessageId: "22222222-3333-4444-8555-666666666666",
  });
  // The run is in flight: the optimistic row has no durable twin yet.
  const duringRun = await bridge.readHistory({ ...identity });
  assert.deepEqual(duringRun.replacedLiveMessageIds, []);

  // A second prompt without an optimistic id (the approved-execution entry)
  // records nothing for it; the first run's row is settled by its own terminal.
  const promptRuntime = harness.promptRuntimes[0];
  promptRuntime.push({ type: "agent_end", messages: [] });
  await bridge.prompt({
    sessionId: identity.sessionId,
    content: "execute the plan",
    projectPath: identity.projectPath,
    nativeSessionId: identity.nativeSessionId,
    nativeSessionPath: identity.nativeSessionPath,
  });
  const afterSecond = await bridge.readHistory({ ...identity });
  assert.deepEqual(afterSecond.replacedLiveMessageIds, ["22222222-3333-4444-8555-666666666666"]);
});
