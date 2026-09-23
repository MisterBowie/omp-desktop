import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * R1/R5/R7 regression tests for the OMP session registry, over the product
 * bridge (not a detached pure function): restore-path validation, shutdown
 * observability and three-state rename are all exercised through
 * `createOmpSessionBridge` with a scripted fake runtime.
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

function writeNative(sessionDir, id, name = "s") {
  const file = join(sessionDir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  return file;
}

/** A scripted runtime: request responses are overridable per command. */
class FakeRuntime {
  pid = 4321;
  usable = true;
  commands = [];
  responses = new Map();
  currentPath = null;
  #frames = new Set();
  onFrame(handler) { this.#frames.add(handler); return () => this.#frames.delete(handler); }
  onFailure() { return () => undefined; }
  write() { return true; }
  push(frame) { for (const h of [...this.#frames]) h(frame); }
  async request(command) {
    this.commands.push(command.type);
    const scripted = this.responses.get(command.type);
    if (scripted) return typeof scripted === "function" ? scripted(command) : scripted;
    if (command.type === "prompt") return { success: true };
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "switch_session") { this.currentPath = command.sessionPath; return { success: true, data: { cancelled: false } }; }
    if (command.type === "get_state") return { success: true, data: { sessionId: "native-1", sessionFile: this.currentPath } };
    return { success: true };
  }
}

function fakeSupervisor(runtime, { reclaimThrows = false, reclaimStopped = false } = {}) {
  return {
    started: 0,
    stopped: [],
    workingDirectory: null,
    setWorkingDirectory(path) { this.workingDirectory = path; },
    status() {
      return { engine: "omp", phase: this.started > 0 ? "idle" : "stopped", runtimeVersion: this.started > 0 ? "18.2.7" : null, protocolVersion: this.started > 0 ? 2 : null, reason: this.started > 0 ? null : "not-started", capabilities: {} };
    },
    async start() { this.started += 1; return this.status(); },
    async stop() { this.stopped.push(1); return { stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }; },
    currentRuntime: () => (runtime.usable ? runtime : null),
    async reclaimAll() {
      if (reclaimThrows) throw new Error("reclaim exploded");
      if (reclaimStopped) return [{ stopped: false, reaped: true, cleaned: false, steps: [], errors: ["dir survived"] }];
      return [];
    },
  };
}

function harness(supervisorOptions = {}, bridgeOptions = {}) {
  const sessionDir = makeScratch("omp-fc-sessions-");
  const runtimes = [];
  const supervisors = [];
  const firstRuntime = new FakeRuntime();
  const firstSupervisor = fakeSupervisor(firstRuntime, supervisorOptions);
  runtimes.push(firstRuntime);
  supervisors.push(firstSupervisor);
  let created = 0;
  const createSupervisor = () => {
    if (created === 0) {
      created += 1;
      return firstSupervisor;
    }
    const runtime = new FakeRuntime();
    runtimes.push(runtime);
    const supervisor = fakeSupervisor(runtime, supervisorOptions);
    supervisors.push(supervisor);
    created += 1;
    return supervisor;
  };
  const bridge = createOmpSessionBridge({
    createSupervisor,
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
    ...bridgeOptions,
  });
  return { bridge, sessionDir, runtimes, supervisors };
}

test("R1: refuses a restore whose path is outside the session directory", async () => {
  const { bridge } = harness();
  const project = makeScratch("omp-fc-project-");
  const outside = makeScratch("omp-fc-outside-");
  const file = join(outside, "native.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "native-1" }) + "\n");
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /outside the session directory/.test(error.message),
  );
});

test("R1: refuses a restore whose path is a symlink", async () => {
  const { bridge, sessionDir } = harness();
  const project = makeScratch("omp-fc-project-");
  const real = join(sessionDir, "real.jsonl");
  writeFileSync(real, JSON.stringify({ type: "session", id: "native-1" }) + "\n");
  const link = join(sessionDir, "link.jsonl");
  symlinkSync(real, link);
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: link }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /symbolic link/.test(error.message),
  );
});

test("R1: refuses a restore whose path is a directory or missing", async () => {
  const { bridge, sessionDir } = harness();
  const project = makeScratch("omp-fc-project-");
  const dir = join(sessionDir, "not-a-file");
  mkdirSync(dir);
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: dir }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /not a regular file/.test(error.message),
  );
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: join(sessionDir, "missing.jsonl") }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /does not exist/.test(error.message),
  );
});

test("R1: refuses a restore whose file header id disagrees with the reference", async () => {
  const { bridge, sessionDir } = harness();
  const project = makeScratch("omp-fc-project-");
  const file = join(sessionDir, "wrong.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "other-id" }) + "\n");
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /different native session/.test(error.message),
  );
});

test("R1: refuses a restore with an unsupported adapter or a downgraded runtime version", async () => {
  const { bridge, sessionDir } = harness();
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file, adapterVersion: 99 }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /adapter version/.test(error.message),
  );
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file, runtimeVersion: "99.0.0" }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /newer than the running/.test(error.message),
  );
});

test("R1: refuses a restore when the runtime opens a different native session", async () => {
  const { bridge, sessionDir, runtimes } = harness();
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  // The runtime reports a different id after switch: the bridge must stop it
  // and refuse rather than persist a mismatched reference.
  runtimes[0].responses.set("switch_session", { success: true, data: { cancelled: false } });
  runtimes[0].responses.set("get_state", { success: true, data: { sessionId: "some-other-id", sessionFile: file } });
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /different native session/.test(error.message),
  );
});

test("R5: dispose reports a reclaim that returned stopped:false", async () => {
  const { bridge, sessionDir } = harness({ reclaimStopped: true });
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  await bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file });
  const outcome = await bridge.dispose("test");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0].detail, /reclaim incomplete/);
});

test("R5: dispose continues past a thrown reclaim and reports both sessions", async () => {
  const { bridge, sessionDir } = harness({ reclaimThrows: true });
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  await bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file });
  await bridge.prompt({ sessionId: "s2", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file });
  const outcome = await bridge.dispose("test");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failures.length, 2, "both sessions' reclaims are attempted and reported");
});

test("R7: rename works for a not-yet-prompted session by briefly restoring and cleaning up", async () => {
  const { bridge, sessionDir, supervisors } = harness();
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  const outcome = await bridge.rename("s1", "new name", {
    projectPath: project,
    nativeSessionId: "native-1",
    nativeSessionPath: file,
  });
  assert.equal(outcome.ok, true);
  // The briefly-started runtime must be disposed again (no lingering runtime).
  assert.ok(supervisors[0].started >= 1, "the runtime was started for the rename");
  assert.equal(bridge.status("s1").isRunning, false, "no runtime may linger after a rename");
});

test("F1: refuses a restore whose intermediate directory is a symlink escaping the session dir", async () => {
  const { bridge, sessionDir } = harness();
  const project = makeScratch("omp-fc-project-");
  const outside = makeScratch("omp-fc-outside-");
  const realFile = join(outside, "native-1.jsonl");
  writeFileSync(realFile, JSON.stringify({ type: "session", id: "native-1" }) + "\n");
  // A symlinked intermediate directory: <sessionDir>/link -> <outside>. The
  // final file itself is not a symlink, so a lexical containment check passes;
  // realpath must resolve the link and refuse the escape.
  symlinkSync(outside, join(sessionDir, "link"));
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: join(sessionDir, "link", "native-1.jsonl") }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED",
  );
});

test("F1: refuses a restore whose get_state reports no sessionFile", async () => {
  const { bridge, sessionDir, runtimes } = harness();
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  runtimes[0].responses.set("get_state", { success: true, data: { sessionId: "native-1", sessionFile: null } });
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /different path/.test(error.message),
  );
});

test("F1: refuses a restore whose get_state reports the same id at a different path", async () => {
  const { bridge, sessionDir, runtimes } = harness();
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  const other = writeNative(sessionDir, "native-1-b");
  runtimes[0].responses.set("get_state", { success: true, data: { sessionId: "native-1", sessionFile: other } });
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: project, nativeSessionId: "native-1", nativeSessionPath: file }),
    (error) => error.errorCode === "OMP_RESTORE_FAILED" && /different path/.test(error.message),
  );
});

test("F6: a failed host persist on rename reverts an empty prior title and reports the fork", async () => {
  // A bridge whose host rename always fails: the revert of an empty prior title
  // is impossible (the runtime refuses an empty name), so the rename must report
  // the inconsistency rather than pretend it rolled back.
  const { bridge, sessionDir, runtimes } = harness({}, {
    persistRename: async () => {
      throw new Error("host rename failed");
    },
  });
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  runtimes[0].responses.set("get_state", { success: true, data: { sessionId: "native-1", sessionFile: file, sessionName: "" } });
  runtimes[0].responses.set("set_session_name", (command) => (command.name === "" ? { success: false, error: "empty name refused" } : { success: true }));
  const outcome = await bridge.rename("s1", "new name", {
    projectPath: project,
    nativeSessionId: "native-1",
    nativeSessionPath: file,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.inconsistent, true, "an unrevertable fork must be reported");
  assert.match(outcome.reason ?? "", /could not be reverted/);
});

test("F6: a one-shot rename whose runtime cleanup fails is reported as inconsistent", async () => {
  // disposeSession returns {ok:false} on reclaim failure; the rename must
  // surface that instead of returning a clean success.
  const { bridge, sessionDir } = harness({ reclaimStopped: true });
  const project = makeScratch("omp-fc-project-");
  const file = writeNative(sessionDir, "native-1");
  const outcome = await bridge.rename("s1", "new name", {
    projectPath: project,
    nativeSessionId: "native-1",
    nativeSessionPath: file,
  });
  assert.equal(outcome.ok, false, "a leaked runtime must fail the rename");
  assert.equal(outcome.inconsistent, true);
  assert.match(outcome.reason ?? "", /could not be reclaimed/);
});
