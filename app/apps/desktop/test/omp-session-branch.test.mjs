import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * R2: the product branch path — the renderer's selected point maps to a real
 * OMP entry (never the first), and a failed bind is compensated. Exercised
 * through `createOmpSessionBridge.branch`, which the `sessionFork` IPC calls.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});
function makeScratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

class FakeRuntime {
  pid = 4321;
  usable = true;
  commands = [];
  responses = new Map();
  #frames = new Set();
  onFrame(h) { this.#frames.add(h); return () => this.#frames.delete(h); }
  onFailure() { return () => undefined; }
  write() { return true; }
  push(frame) { for (const h of [...this.#frames]) h(frame); }
  async request(command) {
    this.commands.push(command.type);
    const scripted = this.responses.get(command.type);
    if (scripted) return typeof scripted === "function" ? scripted(command) : scripted;
    if (command.type === "prompt") return { success: true };
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "get_state") return { success: true, data: { sessionId: "native-1", sessionFile: null } };
    if (command.type === "switch_session") return { success: true, data: { cancelled: false } };
    if (command.type === "get_branch_messages") return { success: true, data: { messages: [] } };
    if (command.type === "branch") return { success: true, data: { cancelled: false } };
    return { success: true };
  }
}

function harness(options = {}) {
  const sessionDir = makeScratch("omp-branch-sessions-");
  const runtime = new FakeRuntime();
  const supervisor = {
    started: 0,
    setWorkingDirectory() {},
    status() { return { engine: "omp", phase: this.started > 0 ? "idle" : "stopped", runtimeVersion: this.started > 0 ? "18.2.7" : null, protocolVersion: 2, reason: null, capabilities: {} }; },
    async start() { this.started += 1; return this.status(); },
    async stop() { return { stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }; },
    currentRuntime: () => runtime,
    async reclaimAll() { return []; },
  };
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
    ...options,
  });
  return { bridge, sessionDir, runtime, supervisor };
}

function writeNative(sessionDir, id) {
  const file = join(sessionDir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  return file;
}

/** Seed a session with two prompts so `get_branch_messages` has two entries. */
async function seedSession(bridge, sessionDir, runtime) {
  const project = makeScratch("omp-branch-project-");
  const file = writeNative(sessionDir, "native-1");
  await bridge.prompt({ sessionId: "s1", content: "first", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file, userMessageId: "u-1" });
  runtime.push({ type: "agent_end", messages: [] });
  await bridge.prompt({ sessionId: "s1", content: "second", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file, userMessageId: "u-2" });
  runtime.push({ type: "agent_end", messages: [] });
}

test("R2: sidebar fork branches at the latest entry, not the first", async () => {
  const calls = [];
  const { bridge, sessionDir, runtime } = harness({
    createBranchSession: async (info) => {
      calls.push(info);
      return "child-1";
    },
  });
  await seedSession(bridge, sessionDir, runtime);
  runtime.responses.set("get_branch_messages", {
    success: true,
    data: { messages: [{ entryId: "e1", text: "first" }, { entryId: "e2", text: "second" }] },
  });
  runtime.responses.set("branch", { success: true, data: { cancelled: false } });
  runtime.responses.set("get_state", { success: true, data: { sessionId: "native-2", sessionFile: writeNative(sessionDir, "native-2") } });
  const result = await bridge.branch("s1");
  assert.equal(result.sessionId, "child-1");
  // The branch must target the second entry (the head), never the first.
  const branchCommand = runtime.commands.filter((c) => c === "branch").length;
  assert.equal(branchCommand, 1);
  assert.equal(calls[0].parentSessionId, "s1");
});

test("R2: assistant-message branch maps the selected turn to its entry", async () => {
  const { bridge, sessionDir, runtime } = harness({
    createBranchSession: async () => "child-2",
  });
  await seedSession(bridge, sessionDir, runtime);
  // omp:s1:2 names the second turn's assistant; branch must map to the second
  // user entry, not the first.
  const branchRequests = [];
  const original = runtime.responses.get.bind(runtime.responses);
  runtime.responses.set("get_branch_messages", {
    success: true,
    data: { messages: [{ entryId: "e1", text: "first" }, { entryId: "e2", text: "second" }] },
  });
  runtime.responses.set("branch", (command) => {
    branchRequests.push(command.entryId);
    return { success: true, data: { cancelled: false } };
  });
  runtime.responses.set("get_state", { success: true, data: { sessionId: "native-2", sessionFile: writeNative(sessionDir, "native-2") } });
  await bridge.branch("s1", "omp:s1:2");
  assert.deepEqual(branchRequests, ["e2"], "the selected turn maps to its entry, not the first");
  void original;
});

test("R2: a selected message with no known branch point is refused", async () => {
  const { bridge, sessionDir, runtime } = harness({
    createBranchSession: async () => "child-3",
  });
  await seedSession(bridge, sessionDir, runtime);
  runtime.responses.set("get_branch_messages", {
    success: true,
    data: { messages: [{ entryId: "e1", text: "first" }] },
  });
  await assert.rejects(
    () => bridge.branch("s1", "omp:s1:99"),
    (error) => error.errorCode === "OMP_BRANCH_FAILED",
  );
});

test("R2: a failed bind is compensated (persistBranchCleanup called)", async () => {
  const cleaned = [];
  const { bridge, sessionDir, runtime } = harness({
    createBranchSession: async () => {
      throw Object.assign(new Error("bind failed"), { errorCode: "OMP_BRANCH_FAILED" });
    },
    persistBranchCleanup: async (info) => cleaned.push(info),
  });
  await seedSession(bridge, sessionDir, runtime);
  runtime.responses.set("get_branch_messages", {
    success: true,
    data: { messages: [{ entryId: "e1", text: "first" }, { entryId: "e2", text: "second" }] },
  });
  runtime.responses.set("branch", { success: true, data: { cancelled: false } });
  const childFile = writeNative(sessionDir, "native-2");
  runtime.responses.set("get_state", { success: true, data: { sessionId: "native-2", sessionFile: childFile } });
  await assert.rejects(
    () => bridge.branch("s1"),
    (error) => error.errorCode === "OMP_BRANCH_FAILED",
  );
  assert.equal(cleaned.length, 1, "the orphan native file must be cleaned up");
  assert.equal(cleaned[0].nativeSessionPath, childFile);
});
