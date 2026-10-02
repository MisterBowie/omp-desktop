import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  APP_VERSION,
  OMP_RUNTIME_BASE_SHA,
  OMP_RUNTIME_FORK_COMMIT,
  OMP_RUNTIME_FORK_REPOSITORY,
  OMP_RUNTIME_PATCH_LEVEL,
  OMP_RUNTIME_VERSION,
} from "@pi-desktop/shared";

/**
 * R1/R5/R7 regression tests for the OMP session registry, over the product
 * bridge (not a detached pure function): restore-path validation, shutdown
 * observability and three-state rename are all exercised through
 * `createOmpSessionBridge` with a scripted fake runtime.
 *
 * The packaged-runtime tests at the bottom exercise the same bridge the
 * production wiring builds (`wireOmpSessions`): an unusable bundled resource
 * must surface its `bundled-runtime-invalid` reason and concrete detail through
 * prompt and control-operation refusals, not a generic "gate not found".
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { serveTurnFenceCommand } = await import(
  "../../../packages/omp-runtime/src/session/turn-fence-testkit.ts"
);
const { createOmpRuntimeAdapter } = await import("../electron/main/runtime/omp-runtime.ts");
/** The production name of the packaged executable, so fixtures cannot drift. */
const { bundledBinaryFilename } = await import("../../../packages/omp-runtime/src/bundled.ts");

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
    const fence = serveTurnFenceCommand(command, (frame) => this.push(frame));
    if (fence) return fence;
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
      return { engine: "omp", phase: this.started > 0 ? "idle" : "stopped", runtimeVersion: this.started > 0 ? "18.3.0" : null, protocolVersion: this.started > 0 ? 2 : null, reason: this.started > 0 ? null : "not-started", capabilities: {} };
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

/**
 * A packaged resource tree exactly as `scripts/omp-sidecar.mjs` lays it out,
 * with the digests the provenance manifest must agree with.
 *
 * The executable name comes from the production helper, not a literal: the
 * verifier requires `omp.exe` on Windows, so a fixture that always wrote `omp`
 * would turn every packaged case into "the Windows binary is missing" instead
 * of the tamper it names.
 */
function writePackagedRuntime(resourcesPath) {
  const dir = join(resourcesPath, "omp-runtime");
  const filename = bundledBinaryFilename(process.platform);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  const binary = join(dir, filename);
  writeFileSync(binary, "#!/bin/sh\necho omp/18.3.0\n", { mode: 0o755 });
  chmodSync(binary, 0o755);
  const gate = join(dir, "extensions", "omp-desktop-gate.js");
  writeFileSync(gate, "// fixture gate\nexport const gate = true;\n");
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const manifestPath = join(dir, "provenance.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "omp-desktop.bundled-sidecar/3",
      fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, commit: OMP_RUNTIME_FORK_COMMIT },
      upstreamBase: { sha: OMP_RUNTIME_BASE_SHA, version: OMP_RUNTIME_VERSION },
      patchLevel: OMP_RUNTIME_PATCH_LEVEL,
      capabilities: ["rpc-host-tool-concurrency"],
      ompVersion: OMP_RUNTIME_VERSION,
      desktopVersion: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      binary: { filename, bytes: readFileSync(binary).length, sha256: digest(binary) },
      extensions: [
        { path: "extensions/omp-desktop-gate.js", bytes: readFileSync(gate).length, sha256: digest(gate) },
      ],
      build: { tool: "bun", bytecode: true },
    }),
  );
  return { dir, binary, gate, manifestPath };
}

/**
 * The bridge the production wiring builds, with the adapter resolving the
 * bundled runtime exactly as `wireOmpSessions` does.
 */
function packagedBridge(resourcesPath, bridgeOptions = {}) {
  const adapter = createOmpRuntimeAdapter({
    dataRoot: makeScratch("omp-fc-data-"),
    isPackaged: true,
    resourcesPath,
    appPath: "/repo/app",
    env: {},
    supervisorFactory: () => fakeSupervisor(new FakeRuntime()),
  });
  const bridge = createOmpSessionBridge({
    createSupervisor: () => fakeSupervisor(new FakeRuntime()),
    launcher: adapter.launcher,
    launcherError: adapter.launcherError,
    isPackaged: true,
    resourcesPath,
    appPath: "/repo/app",
    sessionDir: makeScratch("omp-fc-packaged-"),
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
    ...bridgeOptions,
  });
  return { adapter, bridge };
}

const packagedCases = [
  {
    name: "a missing binary",
    tamper: (layout) => rmSync(layout.binary),
    detail: /missing the bundled omp/,
  },
  {
    name: "a tampered binary",
    tamper: (layout) => {
      writeFileSync(layout.binary, "#!/bin/sh\nexit 1\n");
      chmodSync(layout.binary, 0o755);
    },
    detail: /binary is|SHA-256/,
  },
  {
    name: "a tampered manifest",
    tamper: (layout) => {
      const value = JSON.parse(readFileSync(layout.manifestPath, "utf8"));
      value.binary.sha256 = "b".repeat(64);
      writeFileSync(layout.manifestPath, JSON.stringify(value));
    },
    detail: /SHA-256/,
  },
  {
    name: "a tampered gate",
    // Same length, one flipped byte: the refusal under test is the digest, not
    // the byte count.
    tamper: (layout) => {
      const swapped = Buffer.from(readFileSync(layout.gate));
      swapped[0] = swapped[0] ^ 0xff;
      writeFileSync(layout.gate, swapped);
    },
    detail: /extension .* does not match the provenance manifest/,
  },
];

for (const scenario of packagedCases) {
  test(`P3: a packaged prompt reports the bundled-runtime-invalid reason for ${scenario.name}`, async () => {
    const resources = makeScratch("omp-fc-res-");
    const layout = writePackagedRuntime(resources);
    // A development gate exists at the app path: a packaged refusal must never
    // fall back to it.
    const appPath = makeScratch("omp-fc-app-");
    mkdirSync(join(appPath, "packages", "omp-runtime", "extensions"), { recursive: true });
    writeFileSync(
      join(appPath, "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
      "// dev gate\n",
    );
    scenario.tamper(layout);
    const { bridge } = packagedBridge(resources, { appPath });
    await assert.rejects(
      () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: makeScratch("omp-fc-project-") }),
      (error) => {
        assert.equal(error.errorCode, "bundled-runtime-invalid", error.message);
        assert.match(error.message, /bundled-runtime-invalid/);
        assert.match(error.message, scenario.detail);
        return true;
      },
    );
  });

  test(`P3: a packaged control operation reports the same reason for ${scenario.name}`, async () => {
    const resources = makeScratch("omp-fc-res-");
    const layout = writePackagedRuntime(resources);
    scenario.tamper(layout);
    const { bridge } = packagedBridge(resources);
    await assert.rejects(
      () => bridge.rename("s1", "new name", { projectPath: makeScratch("omp-fc-project-") }),
      (error) => {
        assert.equal(error.errorCode, "bundled-runtime-invalid", error.message);
        assert.match(error.message, scenario.detail);
        return true;
      },
    );
  });
}

test("P3: a packaged build resolves the platform's own executable name", async () => {
  // The bundled runtime on Windows is `omp.exe`; the fixture must therefore lay
  // out — and the manifest must declare — the name the verifier looks for, or
  // every packaged case would silently be testing "omp.exe is missing" instead
  // of the tamper it names. The host platform is simulated because the verifier
  // reads the real one.
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const resources = makeScratch("omp-fc-res-");
    const layout = writePackagedRuntime(resources);
    assert.equal(basename(layout.binary), "omp.exe", "the fixture must write the Windows name");
    assert.equal(
      JSON.parse(readFileSync(layout.manifestPath, "utf8")).binary.filename,
      "omp.exe",
      "the manifest must declare the Windows name",
    );
    const { adapter } = packagedBridge(resources);
    assert.ok(adapter.launcher, `the Windows-named bundled runtime must resolve: ${adapter.launcherError}`);
    assert.equal(basename(adapter.launcher), "omp.exe");
    assert.equal(adapter.launcherError, null);
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
});

test("P3: a packaged launcher refusal carries the adapter's concrete reason", async () => {
  // The gate verifies, but the adapter refused the runtime for a reason of its
  // own; the bridge must not flatten that into a generic launcher message.
  const resources = makeScratch("omp-fc-res-");
  writePackagedRuntime(resources);
  const reason =
    "bundled-runtime-invalid: the bundled OMP runtime is not usable (the bundled omp is not executable)";
  const bridge = createOmpSessionBridge({
    createSupervisor: () => fakeSupervisor(new FakeRuntime()),
    launcher: null,
    launcherError: reason,
    isPackaged: true,
    resourcesPath: resources,
    appPath: "/repo/app",
    sessionDir: makeScratch("omp-fc-packaged-"),
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
  });
  await assert.rejects(
    () => bridge.prompt({ sessionId: "s1", content: "hi", projectPath: makeScratch("omp-fc-project-") }),
    (error) => {
      assert.equal(error.errorCode, "bundled-runtime-invalid");
      assert.match(error.message, /not executable/);
      return true;
    },
  );
});
