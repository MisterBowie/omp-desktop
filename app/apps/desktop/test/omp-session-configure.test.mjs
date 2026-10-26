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
const { serveTurnFenceCommand } = await import(
  "../../../packages/omp-runtime/src/session/turn-fence-testkit.ts"
);

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
  /** The level the runtime reports from `get_state` (OMP's own default when unset). */
  thinkingLevel = undefined;
  /** Every level `set_thinking_level` asked for, in order. */
  levels = [];
  responses = new Map();
  #frames = new Set();
  onFrame(h) { this.#frames.add(h); return () => this.#frames.delete(h); }
  onFailure() { return () => undefined; }
  write() { return true; }
  push(f) { for (const h of [...this.#frames]) h(f); }
  async request(command) {
    const fence = serveTurnFenceCommand(command, (frame) => this.push(frame));
    if (fence) return fence;
    this.commands.push(command.type);
    if (command.type === "set_thinking_level") this.levels.push(command.level);
    const scripted = this.responses.get(command.type);
    if (scripted) return typeof scripted === "function" ? scripted(command) : scripted;
    if (command.type === "prompt") return { success: true };
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "switch_session") { this.currentPath = command.sessionPath; return { success: true, data: { cancelled: false } }; }
    if (command.type === "get_state") return { success: true, data: { sessionId: "native-1", sessionFile: this.currentPath, thinkingLevel: this.thinkingLevel } };
    if (command.type === "set_thinking_level") { this.thinkingLevel = command.level; return { success: true }; }
    return { success: true };
  }
}

function harness({ persistImpl, reclaimResult = { ok: true, failures: [] }, resolveThinkingLevel } = {}) {
  const sessionDir = makeScratch("omp-cfg-sessions-");
  const runtime = new FakeRuntime();
  const supervisor = {
    started: 0,
    reclaims: 0,
    setWorkingDirectory() {},
    status() { return { engine: "omp", phase: this.started > 0 ? "idle" : "stopped", runtimeVersion: this.started > 0 ? "18.3.0" : null, protocolVersion: 2, reason: null, capabilities: {} }; },
    async start() { this.started += 1; return this.status(); },
    async stop() { return { stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }; },
    currentRuntime: () => runtime,
    async reclaimAll() { this.reclaims += 1; return reclaimResult.ok ? [] : [{ stopped: false, reaped: true, cleaned: false, steps: [], errors: ["dir survived"] }]; },
  };
  const hostCalls = [];
  const logs = [];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    emitAgentEvent: () => undefined,
    logger: { app: (scope, level, message, meta) => logs.push({ scope, level, message, meta }) },
    persistConfig: async (info) => {
      hostCalls.push({ kind: "persistConfig", info });
      if (persistImpl) await persistImpl(info);
    },
    ...(resolveThinkingLevel ? { resolveThinkingLevel } : {}),
  });
  return { bridge, sessionDir, runtime, supervisor, hostCalls, logs };
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

/**
 * The production resolver's shape for one binding whose ladder lacks `off`:
 * no level and `omit` send nothing, `off` runs at the nearest enabled `low`.
 */
const clampOffToLow = async ({ thinkingLevel }) =>
  !thinkingLevel || thinkingLevel === "omit" ? null : thinkingLevel === "off" ? "low" : thinkingLevel;

function promptInput(project, overrides = {}) {
  return { sessionId: "s1", content: "hi", projectPath: project, providerId: "p", modelId: "m", ...overrides };
}

test("a fresh runtime is put on the session's resolved thinking level before the prompt", async () => {
  const asked = [];
  const { bridge, sessionDir, runtime } = harness({
    resolveThinkingLevel: async (binding) => { asked.push(binding); return clampOffToLow(binding); },
  });
  runtime.responses.set("new_session", () => {
    runtime.currentPath = writeNative(sessionDir, "native-1");
    return { success: true, data: { cancelled: false } };
  });
  await bridge.prompt(promptInput(makeScratch("omp-cfg-project-"), { thinkingLevel: "off" }));
  assert.deepEqual(asked, [{ providerId: "p", modelId: "m", thinkingLevel: "off" }]);
  assert.deepEqual(runtime.levels, ["low"], "the runtime runs at the level the composer shows, not its own default");
  assert.deepEqual(
    runtime.commands.filter((type) => ["new_session", "set_thinking_level", "prompt"].includes(type)),
    ["new_session", "set_thinking_level", "prompt"],
  );
});

test("a restored runtime already at the session's level, or a session on omit, gets no thinking command", async () => {
  for (const [thinkingLevel, reported] of [["high", "high"], ["omit", "high"], [undefined, "high"]]) {
    const { bridge, sessionDir, runtime } = harness({ resolveThinkingLevel: clampOffToLow });
    runtime.thinkingLevel = reported;
    const file = writeNative(sessionDir, "native-1");
    await bridge.prompt(promptInput(makeScratch("omp-cfg-project-"), { thinkingLevel, nativeSessionId: "native-1", nativeSessionPath: file }));
    assert.deepEqual(runtime.levels, [], `${thinkingLevel}: nothing to apply`);
    assert.ok(runtime.commands.includes("prompt"));
  }
});

test("a refused or unresolvable thinking level is logged and the prompt still runs", async () => {
  for (const failure of ["not applied", "unresolved"]) {
    const { bridge, sessionDir, runtime, logs } = harness({
      resolveThinkingLevel: failure === "unresolved" ? async () => { throw new Error("host unavailable"); } : clampOffToLow,
    });
    if (failure === "not applied") runtime.responses.set("set_thinking_level", { success: false, error: "level rejected" });
    const file = writeNative(sessionDir, "native-1");
    await bridge.prompt(promptInput(makeScratch("omp-cfg-project-"), { thinkingLevel: "medium", nativeSessionId: "native-1", nativeSessionPath: file }));
    assert.ok(runtime.commands.includes("prompt"), `${failure}: the send is not failed by the thinking level`);
    const warnings = logs.filter((entry) => entry.level === "warn" && entry.message.startsWith("thinking level"));
    assert.deepEqual(warnings.map((entry) => entry.message), [`thinking level ${failure}`]);
  }
});

test("a running session receives the clamped level while the host keeps the chosen one", async () => {
  const { bridge, sessionDir, runtime, hostCalls } = harness({ resolveThinkingLevel: clampOffToLow });
  await seed(bridge, sessionDir, runtime);
  const outcome = await bridge.configure("s1", { thinkingLevel: "off" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(runtime.levels, ["low"]);
  assert.equal(hostCalls.at(-1).info.thinkingLevel, "off");
});

test("choosing omit on a running session persists it without a runtime command", async () => {
  const { bridge, sessionDir, runtime, hostCalls } = harness({ resolveThinkingLevel: clampOffToLow });
  await seed(bridge, sessionDir, runtime);
  const outcome = await bridge.configure("s1", { thinkingLevel: "omit" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(runtime.levels, [], "OMP has no omit level; the running level stays until the next runtime");
  assert.equal(hostCalls.at(-1).info.thinkingLevel, "omit");
});
