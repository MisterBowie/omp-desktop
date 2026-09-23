import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * H1: registry ownership. A failed reclaim must not orphan the supervisor: the
 * entry is retained so a later dispose retries the same supervisor, and a
 * subsequent prompt cannot start a second runtime for the same session.
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
  #frames = new Set();
  onFrame(h) { this.#frames.add(h); return () => this.#frames.delete(h); }
  onFailure() { return () => undefined; }
  write() { return true; }
  push(f) { for (const h of [...this.#frames]) h(f); }
  async request(command) {
    this.commands.push(command.type);
    if (command.type === "prompt") return { success: true };
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "switch_session") { this.currentPath = command.sessionPath; return { success: true, data: { cancelled: false } }; }
    if (command.type === "get_state") return { success: true, data: { sessionId: "native-1", sessionFile: this.currentPath } };
    return { success: true };
  }
}

/** A supervisor whose reclaim fails the first `failuresFirst` times, then succeeds. */
function makeHarness({ failFirstReclaims = 0 }) {
  const sessionDir = makeScratch("omp-own-sessions-");
  const runtime = new FakeRuntime();
  let reclaims = 0;
  let reclaimed = true;
  const supervisor = {
    started: 0,
    setWorkingDirectory() {
      // The real supervisor refuses to re-point (or start) a runtime it still
      // owns after a failed reclaim; model that so a second prompt fails.
      if (this.started > 0 && !reclaimed) throw new Error("the runtime is running; stop it before changing its working directory");
    },
    status() { return { engine: "omp", phase: this.started > 0 ? "idle" : "stopped", runtimeVersion: this.started > 0 ? "18.2.7" : null, protocolVersion: 2, reason: null, capabilities: {} }; },
    async start() {
      if (!reclaimed) throw new Error("a previous runtime directory could not be reclaimed");
      this.started += 1;
      return this.status();
    },
    async stop() { return { stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }; },
    currentRuntime: () => (reclaimed ? runtime : null),
    async reclaimAll() {
      reclaims += 1;
      if (reclaims <= failFirstReclaims) {
        reclaimed = false;
        return [{ stopped: false, reaped: true, cleaned: false, steps: [], errors: ["run dir survived"] }];
      }
      reclaimed = true;
      return [];
    },
  };
  const createdSupervisors = [];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => {
      createdSupervisors.push(supervisor);
      return supervisor;
    },
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
  });
  return { bridge, sessionDir, runtime, supervisor, createdSupervisors, reclaims: () => reclaims };
}

function writeNative(sessionDir, id) {
  const file = join(sessionDir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  return file;
}

test("H1: a failed reclaim retains the entry and a second dispose retries the same supervisor", async () => {
  const { bridge, sessionDir, runtime, createdSupervisors, reclaims } = makeHarness({ failFirstReclaims: 1 });
  const project = makeScratch("omp-own-project-");
  const file = writeNative(sessionDir, "native-1");
  await bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file });
  runtime.push({ type: "agent_end", messages: [] });

  const first = await bridge.disposeSession("s1", "test");
  assert.equal(first.ok, false, "the first reclaim must fail");

  // The entry was retained, so the second dispose retries the SAME supervisor
  // (not a fresh one) and succeeds.
  const second = await bridge.disposeSession("s1", "retry");
  assert.equal(second.ok, true, "the second reclaim must succeed");
  assert.equal(createdSupervisors.length, 1, "no second supervisor may be created");
  assert.equal(reclaims(), 2, "both reclaims hit the same supervisor");
});

test("H1: a prompt after a failed reclaim does not create a second runtime", async () => {
  const { bridge, sessionDir, runtime, createdSupervisors } = makeHarness({ failFirstReclaims: 1 });
  const project = makeScratch("omp-own-project-");
  const file = writeNative(sessionDir, "native-1");
  await bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file });
  runtime.push({ type: "agent_end", messages: [] });

  const first = await bridge.disposeSession("s1", "test");
  assert.equal(first.ok, false);

  // A second prompt for the same session must not mint a second supervisor; it
  // must fail because the retained supervisor still owns an unreclaimed runtime.
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file }),
  );
  assert.equal(createdSupervisors.length, 1, "the prompt must reuse the retained supervisor, not create a second");
});
