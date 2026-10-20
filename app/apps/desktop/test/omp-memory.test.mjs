import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createOmpMemoryService } = await import("../electron/main/runtime/omp-memory.ts");
const { registerMemoryIpc } = await import("../electron/main/ipc/memory-ipc.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { IPC, DEFAULT_OMP_MEMORY } = await import("@pi-desktop/shared");
const { ompMemoryDirectory } = await import("@pi-desktop/omp-runtime");
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-memory-service-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  let settings = { ...DEFAULT_OMP_MEMORY };
  const calls = [];
  let fail = false;
  let nativeActive = true;
  let busy = false;
  const bridge = createOmpSessionBridge({
    launcher: null,
    appPath: here,
    isPackaged: false,
    createSupervisor() {
      throw new Error("must not prompt");
    },
    emitAgentEvent() {},
  });
  const memory = createOmpMemoryService({
    dataRoot: root,
    host: () => ({
      call: async (method, value) => {
        if (method === "session.executionRoot")
          return { path: join(root, value.sessionId === "temporary" ? "scratch" : "worktree") };
        if (method === "memory.settings.get") return settings;
        if (method === "memory.settings.set") {
          settings = value;
          return value;
        }
        throw new Error(method);
      },
    }),
    sessions: {
      withIdleRuntimes: (operation) => {
        if (busy) throw Object.assign(new Error("busy"), { errorCode: "CONFLICT" });
        return bridge.withIdleRuntimes(operation);
      },
    },
    createSupervisor: (options) => ({
      async start() {
        calls.push(await options.memory());
        return { phase: "idle" };
      },
      currentRuntime: () => ({
        request: async (command) => {
          calls.push(command);
          return fail
            ? { success: false }
            : {
                success: true,
                data:
                  command.action === "status"
                    ? { active: nativeActive }
                    : command.action === "clear"
                      ? { cleared: true }
                      : { items: [{ id: "fact", content: "Saved project convention" }], total: 1 },
              };
        },
      }),
      async stop() {
        calls.push("stop");
        return { reaped: true, cleaned: true };
      },
      async reclaimAll() {
        calls.push("reclaim");
      },
    }),
  });
  t.after(() => memory.dispose());
  const handlers = new Map();
  registerMemoryIpc({ handle: (name, fn) => handlers.set(name, fn) }, memory);
  return {
    root,
    calls,
    bridge,
    memory,
    handlers,
    setFail: (value) => (fail = value),
    setActive: (value) => (nativeActive = value),
    setBusy: (value) => (busy = value),
  };
}
test("settings IPC persists independent flags without deleting memory; browsing and confirmed clear use native RPC", async (t) => {
  const h = setup(t);
  const projectPath = join(h.root, "project");
  const dir = ompMemoryDirectory(h.root, projectPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.db"), "owned fixture");
  assert.deepEqual(await h.handlers.get(IPC.invoke.ompMemorySettingsGet)(), DEFAULT_OMP_MEMORY);
  await h.handlers.get(IPC.invoke.ompMemorySettingsSet)({ autoSave: true, autoRead: false });
  assert.deepEqual(await h.handlers.get(IPC.invoke.ompMemorySettingsGet)(), {
    autoSave: true,
    autoRead: false,
  });
  await h.handlers.get(IPC.invoke.ompMemorySettingsSet)({ autoSave: false, autoRead: false });
  assert.equal(existsSync(join(dir, "memory.db")), true);
  const page = await h.handlers.get(IPC.invoke.ompMemoryQuery)({ projectPath });
  assert.equal(page.items[0].content, "Saved project convention");
  await assert.rejects(
    async () => h.handlers.get(IPC.invoke.ompMemoryClear)({ projectPath }),
    /confirmation/,
  );
  await h.handlers.get(IPC.invoke.ompMemoryClear)({ projectPath, confirmed: true });
  assert.ok(h.calls.some((call) => call.action === "clear"));
  assert.ok(
    h.calls
      .filter((call) => call?.management)
      .every((call) => call.autoSave === false && call.autoRead === false),
  );
  assert.equal(h.calls.filter((call) => call === "stop").length, 3);
});
test("busy sessions reject changes; failures reclaim the native helper without false success", async (t) => {
  const h = setup(t);
  h.setBusy(true);
  await assert.rejects(async () => h.memory.setSettings({ autoSave: true, autoRead: true }), /busy/);
  assert.deepEqual(await h.memory.getSettings(), DEFAULT_OMP_MEMORY);
  h.setBusy(false);
  h.setActive(false);
  await assert.rejects(async () => h.memory.setSettings({ autoSave: true, autoRead: true }), /not available/);
  assert.deepEqual(await h.memory.getSettings(), DEFAULT_OMP_MEMORY);
  h.setActive(true);
  h.setFail(true);
  const projectPath = join(h.root, "project");
  const dir = ompMemoryDirectory(h.root, projectPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.db"), "owned fixture");
  await assert.rejects(h.memory.query({ projectPath, query: "marker" }), /Native memory operation failed/);
  assert.equal(h.calls.at(-1), "stop");
});
test("maintenance defers queued prompts while retaining a reusable bridge", async (t) => {
  const h = setup(t);
  let release;
  const hold = new Promise((resolve) => (release = resolve));
  const maintenance = h.bridge.withIdleRuntimes(() => hold);
  let settled = false;
  const prompt = h.bridge.prompt({ sessionId: "new", projectPath: h.root, content: "hello" });
  prompt.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Promise.resolve();
  assert.equal(settled, false);

  release();
  await maintenance;
  await assert.rejects(prompt, /launcher|runtime|engine/i);
  await h.bridge.withIdleRuntimes(async () => {});
});
test("empty projects never launch a native process; path and query validation fail before launch", async (t) => {
  const h = setup(t);
  assert.deepEqual(await h.memory.query({ projectPath: join(h.root, "other") }), {
    items: [],
    total: 0,
    offset: 0,
  });
  assert.throws(() => h.memory.query({ projectPath: "relative" }));
  assert.throws(() => h.memory.query({ projectPath: h.root, query: "x".repeat(2001) }));
  assert.equal(h.calls.length, 0);
});

test("worktree and temporary scope ids resolve through the host execution root", async (t) => {
  const h = setup(t);
  for (const sessionId of ["worktree", "temporary"]) {
    const path = join(h.root, sessionId === "temporary" ? "scratch" : "worktree");
    const directory = ompMemoryDirectory(h.root, path);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "memory.db"), "owned fixture");
    assert.equal((await h.memory.query({ sessionId })).items.length, 1);
    assert.ok(h.calls.some((call) => call?.dbPath === join(directory, "memory.db")));
    await h.memory.clear({ sessionId, confirmed: true });
  }
  await assert.rejects(
    h.memory.query({ sessionId: "worktree", projectPath: h.root }),
    /Invalid memory scope/,
  );
});
