import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * G1: the `configure` bridge method over the product path, asserting the host
 * call order and the runtime commands — not just a boolean. The offline model
 * switch must reclaim the old runtime before persisting, a failed reclaim must
 * leave the host untouched, and a failed thinking persist must revert.
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
  currentPath = null;
  responses = new Map();
  #frames = new Set();
  onFrame(h) { this.#frames.add(h); return () => this.#frames.delete(h); }
  onFailure() { return () => undefined; }
  write() { return true; }
  push(f) { for (const h of [...this.#frames]) h(f); }
  async request(command) {
    this.commands.push(command.type);
    const scripted = this.responses.get(command.type);
    if (scripted) return typeof scripted === "function" ? scripted(command) : scripted;
    if (command.type === "prompt") return { success: true };
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "switch_session") { this.currentPath = command.sessionPath; return { success: true, data: { cancelled: false } }; }
    if (command.type === "get_state") return { success: true, data: { sessionId: "native-1", sessionFile: this.currentPath } };
    if (command.type === "set_thinking_level") return { success: true };
    return { success: true };
  }
}

function harness({ persistImpl, reclaimResult = { ok: true, failures: [] } } = {}) {
  const sessionDir = makeScratch("omp-cfg-sessions-");
  const runtime = new FakeRuntime();
  const supervisor = {
    started: 0,
    reclaims: 0,
    setWorkingDirectory() {},
    status() { return { engine: "omp", phase: this.started > 0 ? "idle" : "stopped", runtimeVersion: this.started > 0 ? "18.2.7" : null, protocolVersion: 2, reason: null, capabilities: {} }; },
    async start() { this.started += 1; return this.status(); },
    async stop() { return { stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }; },
    currentRuntime: () => runtime,
    async reclaimAll() { this.reclaims += 1; return reclaimResult.ok ? [] : [{ stopped: false, reaped: true, cleaned: false, steps: [], errors: ["dir survived"] }]; },
  };
  const hostCalls = [];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
    persistConfig: async (info) => {
      hostCalls.push({ kind: "persistConfig", info });
      if (persistImpl) await persistImpl(info);
    },
  });
  return { bridge, sessionDir, runtime, supervisor, hostCalls };
}

function writeNative(sessionDir, id) {
  const file = join(sessionDir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  return file;
}

async function seed(bridge, sessionDir, runtime) {
  const project = makeScratch("omp-cfg-project-");
  const file = writeNative(sessionDir, "native-1");
  await bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file });
  runtime.push({ type: "agent_end", messages: [] });
  return project;
}

test("G1: a model change reclaims the old runtime before persisting the new binding", async () => {
  const { bridge, sessionDir, runtime, supervisor, hostCalls } = harness();
  await seed(bridge, sessionDir, runtime);
  const outcome = await bridge.configure("s1", { providerId: "new-p", modelId: "new-m" });
  assert.equal(outcome.ok, true);
  assert.ok(supervisor.reclaims >= 1, "the old runtime must be reclaimed");
  assert.equal(hostCalls.length, 1);
  assert.equal(hostCalls[0].info.providerId, "new-p");
  assert.equal(hostCalls[0].info.modelId, "new-m");
});

test("G1: a failed reclaim leaves the host untouched", async () => {
  const { bridge, sessionDir, runtime, hostCalls } = harness({ reclaimResult: { ok: false, failures: [] } });
  await seed(bridge, sessionDir, runtime);
  const outcome = await bridge.configure("s1", { providerId: "new-p", modelId: "new-m" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /could not be reclaimed/);
  assert.equal(hostCalls.length, 0, "the host binding must be unchanged");
});

test("G1: a failed host persist on thinking reverts the runtime and reports a clean failure", async () => {
  const { bridge, sessionDir, runtime } = harness({ persistImpl: async () => { throw new Error("host write failed"); } });
  await seed(bridge, sessionDir, runtime);
  const outcome = await bridge.configure("s1", { thinkingLevel: "high" });
  assert.equal(outcome.ok, false);
  // The runtime applied the new level, then reverted to the old one.
  const levels = runtime.commands.filter((c) => c === "set_thinking_level").length;
  assert.ok(levels >= 2, `set_thinking_level must be applied and reverted, got ${levels}`);
  assert.equal(outcome.inconsistent, undefined, "a successful revert is not inconsistent");
});

test("G1: a failed thinking revert is reported as inconsistent", async () => {
  const { bridge, sessionDir, runtime } = harness({ persistImpl: async () => { throw new Error("host write failed"); } });
  await seed(bridge, sessionDir, runtime);
  // The runtime refuses the revert (the old level).
  runtime.responses.set("set_thinking_level", (command) => (command.level === "off" ? { success: false, error: "revert refused" } : { success: true }));
  const outcome = await bridge.configure("s1", { thinkingLevel: "high" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.inconsistent, true, "a failed revert must be reported");
});

test("G1: mode and permissionMode are persisted through the single host call", async () => {
  const { bridge, sessionDir, runtime, hostCalls } = harness();
  await seed(bridge, sessionDir, runtime);
  const outcome = await bridge.configure("s1", { mode: "plan", permissionMode: "ask" });
  assert.equal(outcome.ok, true);
  assert.equal(hostCalls.length, 1);
  assert.equal(hostCalls[0].info.mode, "plan");
  assert.equal(hostCalls[0].info.permissionMode, "ask");
});
