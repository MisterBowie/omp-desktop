import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The bridge's read-only history path (M5/T20-R2, reworked by T20-D repair3).
 *
 * `sessionGet` for an OMP session must show the transcript the runtime wrote,
 * without a turn: no prompt, no provider call, no tool, no transcript write.
 * A session with a live runtime is asked through its own process; a session
 * without one is read from its file *in-process* by the direct reader — no
 * runtime is started for a read, so there is no reader process to own, leak,
 * detach or reclaim. These tests pin the parts a fake runtime can prove
 * deterministically: which path is taken, the identity/format refusals, the
 * complete-JSON tail without its newline, the damaged or unterminated record
 * that is refused rather than skipped, that every failure surfaces as an error
 * rather than an empty page, and that a failed read leaves the transcript
 * bytes untouched. The real pinned runtime is exercised in
 * `omp-history-e2e.test.mjs`.
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

/** sha256 of a file, for proving a read (or a failure) did not rewrite it. */
function fileSha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

/** The direct reader fixture: a v3 journal with the title slot the runtime writes. */
const TITLE_SLOT = { type: "title", v: 1, title: "history", updatedAt: "2026-01-01T00:00:00.000Z", pad: " ".repeat(8) };

function writeNativeSession(path, { id, entries = TRANSCRIPT_ENTRIES, version = 3 }) {
  const lines = [JSON.stringify(TITLE_SLOT), JSON.stringify({ type: "session", id, version, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function readHarness() {
  const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "omp-history-sessions-")));
  const project = makeProject();
  scratch.push(sessionDir);
  const nativeSessionId = "native-id";
  const nativeSessionPath = join(sessionDir, "native-session.jsonl");
  writeNativeSession(nativeSessionPath, { id: nativeSessionId });
  const envelopes = [];
  const supervisors = [];
  const runtimes = [];
  const createRuntime = () => {
    const runtime = new FakeRuntime();
    runtime.state = { sessionId: nativeSessionId, sessionFile: nativeSessionPath, sessionName: "session", isStreaming: false };
    runtime.entriesResponse = {
      success: true,
      data: { entries: TRANSCRIPT_ENTRIES, leafId: TRANSCRIPT_ENTRIES.at(-1).id },
    };
    return runtime;
  };
  const bridge = createOmpSessionBridge({
    createSupervisor: () => {
      const runtime = createRuntime();
      const supervisor = fakeSupervisor(runtime);
      runtimes.push(runtime);
      supervisors.push(supervisor);
      return supervisor;
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
    supervisors,
    runtimes,
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
  const { bridge, project, supervisors } = readHarness();
  const result = await bridge.readHistory({
    sessionId: OMP_SESSION,
    projectPath: project,
    nativeSessionId: null,
    nativeSessionPath: null,
  });
  assert.deepEqual(result.messages, []);
  assert.equal(result.messageCount, 0);
  assert.deepEqual(result.replacedLiveMessageIds, []);
  assert.equal(supervisors.length, 0);
});

test("a cold read reads the file in-process: no runtime is created, no supervisor is asked", async () => {
  const { bridge, identity, supervisors } = readHarness();
  const before = fileSha(identity.nativeSessionPath);
  const result = await bridge.readHistory(identity);
  assert.equal(supervisors.length, 0, "a history read must not start a runtime");
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
  assert.equal(fileSha(identity.nativeSessionPath), before, "a successful read must not modify the file");
});

test("a missing, foreign or unreadable reference fails closed without starting a runtime", async () => {
  const { bridge, identity, sessionDir, supervisors } = readHarness();

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
  await assert.rejects(
    () => bridge.readHistory({ ...identity, nativeSessionPath: join(sessionDir, "missing.jsonl") }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  assert.equal(supervisors.length, 0);
});

test("a corrupt or unsupported transcript fails closed and is left byte-identical", async () => {
  const harness = readHarness();
  const { bridge, identity, nativeSessionPath } = harness;

  // Version 1 has no stable entry ids: explicitly refused, never guessed.
  writeNativeSession(nativeSessionPath, { id: identity.nativeSessionId, version: 1 });
  const v1 = fileSha(nativeSessionPath);
  await assert.rejects(
    () => bridge.readHistory(identity),
    (error) => error.errorCode === "OMP_HISTORY_INVALID" && /version 1/.test(error.message),
  );
  assert.equal(fileSha(nativeSessionPath), v1, "a refused read must not modify the file");

  // A structurally broken entry (a missing id) must not become a partial page.
  writeNativeSession(nativeSessionPath, {
    id: identity.nativeSessionId,
    entries: [{ id: "m1", parentId: null, type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }, { parentId: "m1", type: "message" }],
  });
  const broken = fileSha(nativeSessionPath);
  await assert.rejects(
    () => bridge.readHistory(identity),
    (error) => error.errorCode === "OMP_HISTORY_INVALID",
  );
  assert.equal(fileSha(nativeSessionPath), broken, "a refused read must not modify the file");

  // A file whose header was replaced after the reference was persisted: the
  // direct reader re-checks identity itself (the path validator ran first).
  writeNativeSession(nativeSessionPath, { id: "someone-else", version: 3 });
  await assert.rejects(
    () => bridge.readHistory(identity),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
  assert.equal(harness.supervisors.length, 0, "no failure may start a runtime");
});

test("a complete final record without its newline is shown, and damaged records are refused (R11/R12)", async () => {
  const harness = readHarness();
  const { bridge, identity, nativeSessionPath } = harness;

  // R11: the writer's final newline withheld. The last record is complete
  // JSON, so it must be shown — not dropped as an uncommitted write.
  const terminated = readFileSync(nativeSessionPath, "utf8");
  writeFileSync(nativeSessionPath, terminated.replace(/\n$/, ""), "utf8");
  const noLf = fileSha(nativeSessionPath);
  const read = await bridge.readHistory(identity);
  assert.deepEqual(
    read.messages.map((message) => message.id),
    ["omp:session-omp:entry:m1", "omp:session-omp:entry:m2", "call-1"],
    "the complete final record must be visible without its terminating newline",
  );
  assert.equal(read.messageCount, 3);
  assert.equal(fileSha(nativeSessionPath), noLf, "the read must not add the missing newline");
  assert.equal(harness.supervisors.length, 0);

  // R12: a malformed record is a typed refusal, never a silently shorter
  // history and never an empty page.
  writeFileSync(nativeSessionPath, `${terminated}not json at all\n`, "utf8");
  const malformed = fileSha(nativeSessionPath);
  await assert.rejects(
    () => bridge.readHistory(identity),
    (error) => error.errorCode === "OMP_HISTORY_INVALID" && /record that is not valid JSON/.test(error.message),
  );
  assert.equal(fileSha(nativeSessionPath), malformed, "a refused read must not modify the file");

  // R12: a writer mid-record. The incomplete tail is neither read as a
  // committed record nor silently dropped: the snapshot is refused and the
  // same read succeeds once the record is committed.
  const m4 = JSON.stringify({
    id: "m4",
    parentId: "m3",
    type: "message",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: "after" }], timestamp: 4 },
  });
  writeFileSync(nativeSessionPath, `${terminated}${m4.slice(0, 24)}`, "utf8");
  const midWrite = fileSha(nativeSessionPath);
  await assert.rejects(
    () => bridge.readHistory(identity),
    (error) => error.errorCode === "OMP_HISTORY_INVALID" && /unterminated record/.test(error.message),
  );
  assert.equal(fileSha(nativeSessionPath), midWrite, "a refused read must not truncate or repair the file");
  writeFileSync(nativeSessionPath, `${m4.slice(24)}\n`, { flag: "a" });
  const committed = await bridge.readHistory(identity);
  assert.equal(committed.messageCount, 4);
  assert.equal(committed.messages.at(-1).id, "omp:session-omp:entry:m4");
  assert.equal(committed.messages.at(-1).content, "after");
  assert.equal(harness.supervisors.length, 0, "the whole read path must stay process-free");
});

test("a read admitted after shutdown is refused, and shutdown never starts a reader", async () => {
  const harness = readHarness();
  const disposal = await harness.bridge.dispose("test shutdown");
  assert.equal(disposal.ok, true, JSON.stringify(disposal.failures));
  await assert.rejects(
    () => harness.bridge.readHistory(harness.identity),
    (error) => error.errorCode === "ENGINE_UNAVAILABLE",
  );
  assert.equal(harness.supervisors.length, 0, "no shutdown path may start a runtime for a read");
});

test("an explicit null leaf renders an empty active branch, not the last stored entry", async () => {
  const harness = readHarness();
  await harness.bridge.prompt({
    sessionId: harness.identity.sessionId,
    content: "hello",
    projectPath: harness.identity.projectPath,
    nativeSessionId: harness.identity.nativeSessionId,
    nativeSessionPath: harness.identity.nativeSessionPath,
  });
  // The live path answers `get_entries` with a null leaf (the runtime's own
  // `resetLeaf` reports exactly this); the projection must honour it.
  const promptRuntime = harness.runtimes[0];
  promptRuntime.entriesResponse = {
    success: true,
    data: { entries: TRANSCRIPT_ENTRIES, leafId: null },
  };
  const result = await harness.bridge.readHistory(harness.identity);
  assert.deepEqual(result.messages, []);
  assert.equal(result.messageCount, 0);
  assert.equal(harness.supervisors.length, 1, "the read reused the session's own runtime");
});

test("a live runtime is reused, and a tail read names only the settled live rows it replaced", async () => {
  const harness = readHarness();
  const { bridge, identity, runtimes, supervisors } = harness;
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
  assert.equal(supervisors.length, 1, "the prompt owns the only runtime");
  const promptRuntime = runtimes[0];
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
  assert.equal(supervisors.length, 1, "a live runtime must be asked, not a second process");
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
  const promptRuntime = harness.runtimes[0];
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
