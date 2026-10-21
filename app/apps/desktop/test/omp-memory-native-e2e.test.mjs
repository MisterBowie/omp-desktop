/** Real native processes and a local scripted provider; never a paid model. */
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, ompMemoryDirectory } = await import(
  "@pi-desktop/omp-runtime"
);
const { createOmpMemoryService } = await import("../electron/main/runtime/omp-memory.ts");

test("native Mnemopi persists across processes, isolates projects, obeys switches and clears without restoring old history", {
  skip: !process.env.OMP_MEMORY_TEST_RUNTIME && "requires OMP_MEMORY_TEST_RUNTIME",
  // The released Windows fixture took 81.3s across serial native process lifecycles.
  // Allow scheduling margin without changing runtime request or readiness deadlines.
  timeout: process.platform === "win32" ? 180000 : 90000,
}, async (t) => {
  const began = performance.now();
  const trace = async (stage, operation) => {
    // Fixed stage names and elapsed times only; never emit paths or memory text.
    const mark = (event) => console.log("MEMORY_NATIVE_STAGE " + JSON.stringify({
      stage, event, elapsedMs: Math.round(performance.now() - began),
    }));
    mark("begin");
    try { return await operation(); } finally { mark("end"); }
  };
  let promptNumber = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-memory-native-e2e-")));
  const project = join(root, "project");
  mkdirSync(project);
  const other = join(root, "worktree");
  mkdirSync(other);
  const provider = await FakeProvider.start();
  const supervisors = [];
  const stop = (supervisor) => trace("stop-" + (supervisors.indexOf(supervisor) + 1),
    () => supervisor.stop({ abortBash: false }));
  t.after(async () => {
    for (const supervisor of supervisors) await stop(supervisor);
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function start(path, autoSave, autoRead, normal = true) {
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot: root,
      cwd: path,
      launcherPath: process.env.OMP_MEMORY_TEST_RUNTIME,
      sessionDir: ensureSessionStateDir(root),
      desktopStateRequired: false,
      memory: async () => ({
        dbPath: join(ompMemoryDirectory(root, path), "memory.db"),
        autoSave,
        autoRead,
        management: !normal,
        modelSelector: "m1fake/local-model",
      }),
      prepareRun: (paths) => writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl }),
    });
    supervisors.push(supervisor);
    await trace("start-" + supervisors.length, () => supervisor.start());
    const runtime = supervisor.currentRuntime();
    assert.ok(runtime);
    const state = await runtime.request({ type: "get_state" });
    assert.equal(state.data.memoryRpcVersion, 1);
    assert.equal(state.data.memoryMaintenanceSafe, true);
    const status = await runtime.request({ type: "memory", action: "status" });
    assert.equal(status.data.active, autoSave || autoRead || !normal);
    return { supervisor, runtime };
  }
  async function ask(runtime, text) {
    let detach;
    const end = new Promise((resolve) => {
      detach = runtime.onFrame((frame) => {
        if (frame.type === "agent_end" && frame.isTerminal !== false) {
          detach();
          resolve();
        }
      });
    });
    try {
      await trace("prompt-" + (++promptNumber), async () => {
        const accepted = await runtime.request({ type: "prompt", message: text });
        assert.equal(accepted.success, true);
        await end;
      });
    } finally {
      detach?.();
    }
  }
  t.diagnostic("MEMORY_PHASE initial-auto-save");
  const first = await start(project, true, false);
  if (process.platform !== "win32") {
    const bash = first.runtime.request({ type: "bash", command: "sleep 10" });
    const active = await first.runtime.request({ type: "get_state" });
    assert.equal(active.data.memoryMaintenanceSafe, false, "a user Bash command prevents memory maintenance");
    await first.runtime.request({ type: "abort_bash" });
    await bash;
  }

  for (let i = 0; i < 4; i++)
    await ask(first.runtime, "项目数据库使用 atlas-memory-saved-marker，后续会话应记住。turn " + i);
  const page = await first.runtime.request({ type: "memory", action: "list" });
  assert.equal(page.success, true);
  assert.ok(page.data.total > 0);
  assert.match(JSON.stringify(page.data.items), /atlas-memory-saved-marker/);
  await stop(first.supervisor);
  t.diagnostic("MEMORY_PHASE cross-process-recall");
  const read = await start(project, false, true, true);
  await ask(read.runtime, "atlas-memory-saved-marker database");
  const recalled = provider.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)
    .body.messages;
  assert.match(
    JSON.stringify(recalled.filter((message) => message.role === "system" || message.role === "developer")),
    /atlas-memory-saved-marker/,
  );
  await stop(read.supervisor);
  t.diagnostic("MEMORY_PHASE shutdown-partial-save");
  const partialPath = join(root, "partial-project");
  mkdirSync(partialPath);
  const partial = await start(partialPath, true, false);
  await ask(partial.runtime, "Remember single-turn-shutdown-marker");
  assert.equal((await partial.runtime.request({ type: "memory", action: "list" })).data.total, 0);
  await stop(partial.supervisor);
  t.diagnostic("MEMORY_PHASE restore-partial-save");
  const restoredPartial = await start(partialPath, false, true);
  assert.match(
    JSON.stringify((await restoredPartial.runtime.request({ type: "memory", action: "list" })).data.items),
    /single-turn-shutdown-marker/,
  );
  await stop(restoredPartial.supervisor);
  const isolated = await start(other, false, true);
  assert.equal((await isolated.runtime.request({ type: "memory", action: "list" })).data.total, 0);
  await stop(isolated.supervisor);
  // Management keeps the backend available for listing preserved records while
  // both automatic flags are off. Normal disabled chats do not open Mnemopi.
  const disabled = await start(project, false, false, false);
  t.diagnostic("MEMORY_PHASE isolated-worktree");
  t.diagnostic("MEMORY_PHASE disabled-snapshot");
  await ask(disabled.runtime, "atlas-memory-saved-marker database");
  const absent = provider.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)
    .body.messages;
  assert.doesNotMatch(
    JSON.stringify(absent.filter((message) => message.role === "system" || message.role === "developer")),
    /atlas-memory-saved-marker/,
  );
  assert.equal(
    (await disabled.runtime.request({ type: "memory", action: "list" })).data.total,
    page.data.total,
  );
  await stop(disabled.supervisor);
  t.diagnostic("MEMORY_PHASE management-clear");
  let settings = { autoSave: false, autoRead: false };
  const service = createOmpMemoryService({
    dataRoot: root,
    host: () => ({ call: async (method, value) => (method.endsWith("get") ? settings : (settings = value)) }),
    sessions: { withIdleRuntimes: async (operation) => operation() },
    createSupervisor: (options) =>
      new OmpRuntimeSupervisor({
        dataRoot: root,
        launcherPath: process.env.OMP_MEMORY_TEST_RUNTIME,
        ...options,
      }),
  });
  try {
    assert.deepEqual(await trace("settings", () => service.setSettings({ autoSave: true, autoRead: true })), {
      autoSave: true,
      autoRead: true,
    });
    assert.ok((await trace("list", () => service.query({ projectPath: project }))).total > 0);
    assert.ok((await trace("search", () => service.query({ projectPath: project, query: "数据库" }))).items.length > 0);
    assert.deepEqual(await trace("clear", () => service.clear({ projectPath: project, confirmed: true })), { cleared: true });
    assert.equal((await trace("empty", () => service.query({ projectPath: project }))).total, 0);
  } finally {
    await service.dispose();
  }
});
