/**
 * The packaged-runtime acceptance entry's refusals (M6/T21-A).
 *
 * `scripts/verify-packaged-runtime.mjs` is the entry a reviewer or release job
 * runs against a real electron-builder output. Its contract is that it never
 * invents a runtime and never verifies an implicit path: a missing argument, a
 * tree that is not packaged Resources, a tampered manifest/binary/gate, or a
 * runtime built for another target must all exit non-zero.
 *
 * The always-on cases use synthetic trees, so they need no build. The cases
 * that need a real sidecar (digest tampering, wrong target architecture) are
 * opt-in through `OMP_T21_RESOURCES` — the same variable the acceptance run
 * uses. Without it they skip, which is not a pass: the entry itself still exits
 * non-zero when invoked with no path, and the always-on cases below cover that.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..", "..");
const entry = join(appRoot, "scripts", "verify-packaged-runtime.mjs");
const entryModule = await import(pathToFileURL(entry).href);

const created = [];
function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `omp-packaged-runtime-${label}-`));
  created.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function runEntry(args) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

test("the entry never verifies an implicit path", () => {
  const run = runEntry([]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--resources .* is required/);
  assert.doesNotMatch(run.stdout, /PACKAGED-RUNTIME-OK/);

  const unknown = runEntry(["--resources", scratch("unknown"), "--frobnicate"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --frobnicate/);
});

test("a missing, non-directory, or non-packaged resources path is refused", () => {
  const missing = runEntry(["--resources", join(scratch("missing"), "nowhere")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not exist/);

  const file = join(scratch("file"), "resources");
  writeFileSync(file, "not a directory\n");
  const notDirectory = runEntry(["--resources", file]);
  assert.equal(notDirectory.status, 2);
  assert.match(notDirectory.stderr, /not a directory/);

  const empty = runEntry(["--resources", scratch("empty")]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /has no omp-runtime\//);
  assert.doesNotMatch(empty.stdout, /PACKAGED-RUNTIME-OK/);
});

/**
 * A supervisor-shaped double for the entry's failure paths.
 *
 * The acceptance needs a constructor, `start()`, `reclaimAll()` and — for
 * ownership reporting — `runRoot()`/`pendingCleanup`. The doubles let the
 * regression drive "the runtime never starts" and "a run cannot be reclaimed"
 * deterministically, without a real unkillable process.
 */
function fakeSupervisor(behaviour = {}) {
  return class FakeSupervisor {
    constructor(options) {
      this.options = options;
      this.kept = [];
      behaviour.construct?.(this, options);
    }
    runRoot() {
      return this.kept.length > 0 ? this.kept[0].runRoot : null;
    }
    get pendingCleanup() {
      return this.kept;
    }
    async start() {
      if (behaviour.start) return behaviour.start(this);
      return { phase: "idle", runtimeVersion: "18.3.0", protocolVersion: 2 };
    }
    async reclaimAll() {
      if (behaviour.reclaimAll) return behaviour.reclaimAll(this);
      return [];
    }
  };
}

/** The failure the compiled runtime raises before `ready` for an unloadable gate. */
function gateStartFailure(path) {
  return Object.assign(new Error("OMP runtime exited (code 1, signal null)"), {
    code: "not-started",
    detail: `error: Trusted extension must be an existing module file: ${path}\n      at <anonymous> (/$bunfs/root/omp:1:15)\n`,
  });
}

function gateControlOptions(root, missingGatePath) {
  return {
    dataRoot: join(root, "gate-control"),
    launcherPath: join(root, "omp"),
    expectedRuntimeVersion: "18.3.0",
    missingGatePath,
    emptyPathDir: root,
  };
}

test("the gate control accepts only the refusal that names the missing gate", async () => {
  const root = scratch("gate-control");
  const missing = join(root, "does-not-exist.js");

  // The runtime's own refusal, naming exactly the missing path, is the one
  // observation that proves the gate argument is load-bearing.
  await entryModule.expectGateRefusal(
    fakeSupervisor({
      start: () => {
        throw gateStartFailure(missing);
      },
    }),
    gateControlOptions(root, missing),
  );

  // A refusal naming another file proves nothing about this gate.
  await assert.rejects(
    entryModule.expectGateRefusal(
      fakeSupervisor({
        start: () => {
          throw gateStartFailure(join(root, "another-file.js"));
        },
      }),
      gateControlOptions(root, missing),
    ),
    /not rejected by the missing gate/,
  );

  // Neither does an unrelated start failure: a timeout must not be mistaken
  // for the gate being load-bearing.
  await assert.rejects(
    entryModule.expectGateRefusal(
      fakeSupervisor({
        start: () => {
          throw Object.assign(new Error("the runtime did not become ready"), {
            code: "ready-timeout",
            detail: "no ready frame arrived",
          });
        },
      }),
      gateControlOptions(root, missing),
    ),
    /not rejected by the missing gate/,
  );

  // And a runtime that starts with the missing gate disproves the control.
  await assert.rejects(
    entryModule.expectGateRefusal(fakeSupervisor(), gateControlOptions(root, missing)),
    /accepted the non-existent trusted extension/,
  );
});

test("a gate control run that cannot be reclaimed is reported with its ownership", async () => {
  const root = scratch("gate-control-retained");
  const missing = join(root, "does-not-exist.js");
  const runRoot = join(root, "gate-control", "omp-runtime", "run-stuck");
  const RetainedSupervisor = fakeSupervisor({
    start: () => {
      throw gateStartFailure(missing);
    },
    reclaimAll(self) {
      self.kept.push({ runRoot, pid: 4242, pgid: 4242, reaped: true });
      return [{ stopped: false, reaped: true, cleaned: false, steps: [], errors: [`could not remove ${runRoot}`] }];
    },
  });

  await assert.rejects(
    entryModule.expectGateRefusal(RetainedSupervisor, gateControlOptions(root, missing)),
    (error) => {
      assert.match(error.message, /could not be reclaimed/);
      assert.match(error.message, /run-stuck/);
      assert.equal(
        error.acceptanceRetention?.ownership?.some((line) => line.includes("run-stuck")),
        true,
        "the retained ownership must travel on the error",
      );
      return true;
    },
  );
  assert.equal(existsSync(root), true, "the control root must be retained for a retry");
});

test("the acceptance root survives a reclamation that cannot complete", async () => {
  const root = scratch("release-incomplete");
  const runRoot = join(root, "data", "omp-runtime", "run-stuck");
  const IncompleteSupervisor = fakeSupervisor({
    reclaimAll(self) {
      self.kept.push({ runRoot, pid: 7, pgid: 7, reaped: true });
      return [{ stopped: false, reaped: true, cleaned: false, steps: [], errors: [`could not remove ${runRoot}`] }];
    },
  });
  const release = await entryModule.releaseAcceptanceRoot(new IncompleteSupervisor({}), root);
  assert.equal(release.ok, false);
  assert.equal(release.retainedRoot, root);
  assert.match(release.reason, /reclamation is incomplete/);
  assert.match(release.ownership.join(" "), /run-stuck/);
  assert.equal(existsSync(root), true, "an incomplete reclamation must not delete the root");

  const ThrowingSupervisor = fakeSupervisor({
    reclaimAll() {
      throw new Error("process tree termination failed");
    },
  });
  const thrown = await entryModule.releaseAcceptanceRoot(new ThrowingSupervisor({}), root);
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /reclaimAll threw/);
  assert.equal(existsSync(root), true, "a thrown reclamation must not delete the root");
});

test("a complete reclamation removes the acceptance root", async () => {
  const root = scratch("release-clean");
  const CleanSupervisor = fakeSupervisor();
  const release = await entryModule.releaseAcceptanceRoot(new CleanSupervisor({}), root);
  assert.equal(release.ok, true);
  assert.equal(existsSync(root), false);
});

test("an ownership held by an earlier step withholds the acceptance root", async () => {
  const root = scratch("release-held");
  const CleanSupervisor = fakeSupervisor();
  const release = await entryModule.releaseAcceptanceRoot(new CleanSupervisor({}), root, {
    heldReason: "the gate-load control retained its run root",
    heldOwnership: [`${join(root, "run-stuck")} (pid 9, pgid 9, process group reaped: true)`],
  });
  assert.equal(release.ok, false);
  assert.equal(release.retainedRoot, root);
  assert.equal(existsSync(root), true);
  assert.equal(
    release.ownership.some((line) => line.includes("run-stuck")),
    true,
  );
});

const ARTIFACT_ROOT = process.env.OMP_T21_RESOURCES ?? null;
const skipWithoutArtifact = ARTIFACT_ROOT
  ? false
  : "set OMP_T21_RESOURCES to a real electron-builder Resources directory to run the tamper cases";

/**
 * Hard-link a file, falling back to a copy when the scratch root is on another
 * filesystem (hard links are same-filesystem only).
 */
function linkOrCopy(from, to) {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * A copy of the real runtime directory in which one file can be altered.
 *
 * The binary is hard-linked (same filesystem here) so the 280 MB file is not
 * copied per case — a case that alters the binary must remove the link and copy
 * before writing, or it would write through to the artifact. The gate is a
 * private copy (a few KB) for the same reason: a mutation must never reach the
 * resources under test. Every mutation goes through the real entry, which must
 * refuse the result.
 */
function runtimeFixture(label, mutate) {
  const root = scratch(label);
  const source = join(ARTIFACT_ROOT, "omp-runtime");
  const target = join(root, "omp-runtime");
  mkdirSync(join(target, "extensions"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, "provenance.json"), "utf8"));
  const binaryName = manifest.binary.filename;
  const manifestPath = join(target, "provenance.json");
  writeFileSync(manifestPath, readFileSync(join(source, "provenance.json")));
  copyFileSync(
    join(source, "extensions", "omp-desktop-gate.js"),
    join(target, "extensions", "omp-desktop-gate.js"),
  );
  linkOrCopy(join(source, binaryName), join(target, binaryName));
  mutate({ root, target, manifestPath, manifest, binaryName, source });
  return root;
}

function rewriteManifest(path, mutate) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("accepts the real packaged runtime resources", { skip: skipWithoutArtifact }, () => {
  const run = runEntry(["--resources", ARTIFACT_ROOT, "--verify-only", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mode, "verify");
  // The identity the entry reports must be the manifest's own claim, re-proven
  // against the bytes on disk by the production verifier.
  const manifest = JSON.parse(
    readFileSync(join(ARTIFACT_ROOT, "omp-runtime", "provenance.json"), "utf8"),
  );
  assert.equal(report.binary.sha256, manifest.binary.sha256);
  assert.equal(report.binary.bytes, manifest.binary.bytes);
  assert.equal(report.provenance.ompVersion, manifest.ompVersion);
  assert.equal(report.provenance.platform, process.platform);
  assert.equal(report.provenance.arch, process.arch);
});

test("refuses a swapped tool gate", { skip: skipWithoutArtifact }, () => {
  const root = runtimeFixture("swapped-gate", ({ target, source }) => {
    const gate = readFileSync(join(source, "extensions", "omp-desktop-gate.js"));
    const swapped = Buffer.from(gate);
    swapped[0] ^= 0xff;
    writeFileSync(join(target, "extensions", "omp-desktop-gate.js"), swapped);
  });
  const run = runEntry(["--resources", root, "--verify-only"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /extension .* does not match the provenance manifest/);
  assert.doesNotMatch(run.stdout, /PACKAGED-RUNTIME-OK/);
});

test("refuses a binary whose bytes no longer match the manifest", { skip: skipWithoutArtifact }, () => {
  const root = runtimeFixture("tampered-binary", ({ target, binaryName, source }) => {
    const binary = join(target, binaryName);
    rmSync(binary);
    // A real content change, not a manifest edit: the digest comparison is what
    // must catch it. Only the last byte is touched, so the 280 MB binary is
    // never buffered in memory.
    copyFileSync(join(source, binaryName), binary);
    const fd = openSync(binary, "r+");
    try {
      const last = Buffer.alloc(1);
      const size = statSync(binary).size;
      readSync(fd, last, 0, 1, size - 1);
      last[0] ^= 0xff;
      writeSync(fd, last, 0, 1, size - 1);
    } finally {
      closeSync(fd);
    }
  });
  const run = runEntry(["--resources", root, "--verify-only"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /binary SHA-256 does not match the provenance manifest/);
});

test("refuses a resources tree with no runtime binary", { skip: skipWithoutArtifact }, () => {
  const root = runtimeFixture("missing-binary", ({ target, binaryName }) => {
    rmSync(join(target, binaryName));
  });
  const run = runEntry(["--resources", root, "--verify-only"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing the bundled omp/);
});

test("refuses a runtime built for another platform or architecture", { skip: skipWithoutArtifact }, () => {
  const otherPlatform = runtimeFixture("wrong-platform", ({ manifestPath }) => {
    rewriteManifest(manifestPath, (manifest) => {
      manifest.platform = process.platform === "darwin" ? "win32" : "darwin";
    });
  });
  const platformRun = runEntry(["--resources", otherPlatform, "--verify-only"]);
  assert.equal(platformRun.status, 1);
  assert.match(platformRun.stderr, /provenance platform is .*, this host is/);

  const otherArch = runtimeFixture("wrong-arch", ({ manifestPath }) => {
    rewriteManifest(manifestPath, (manifest) => {
      manifest.arch = process.arch === "arm64" ? "x64" : "arm64";
    });
  });
  const archRun = runEntry(["--resources", otherArch, "--verify-only"]);
  assert.equal(archRun.status, 1);
  assert.match(archRun.stderr, /provenance arch is .*, this host is/);
});

test("refuses a manifest that is not the pinned one", { skip: skipWithoutArtifact }, () => {
  const wrongPatch = runtimeFixture("wrong-patch-level", ({ manifestPath }) => {
    rewriteManifest(manifestPath, (manifest) => {
      manifest.patchLevel = `${manifest.patchLevel}-forged`;
    });
  });
  const patchRun = runEntry(["--resources", wrongPatch, "--verify-only"]);
  assert.equal(patchRun.status, 1);
  assert.match(patchRun.stderr, /provenance patch level is .*, this build pins/);

  const wrongSchema = runtimeFixture("wrong-schema", ({ manifestPath }) => {
    rewriteManifest(manifestPath, (manifest) => {
      manifest.schema = "omp-desktop.bundled-sidecar/2";
    });
  });
  const schemaRun = runEntry(["--resources", wrongSchema, "--verify-only"]);
  assert.equal(schemaRun.status, 1);
  assert.match(schemaRun.stderr, /provenance schema is .*, expected/);
});

/** The launching variables `runAcceptance` overrides; each must be restored. */
const INHERITED_KEYS = [
  "NODE_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OMP_PROFILE",
  "PI_DESKTOP_DATA_DIR",
  "ANTHROPIC_API_KEY",
];

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("a failed acceptance retains an unreclaimable root and restores the environment", { skip: skipWithoutArtifact }, async () => {
  const snapshot = snapshotEnv(INHERITED_KEYS);
  let acceptRoot = null;
  const foreignRunRoot = join(tmpdir(), "omp-t21-repair-retained-run");
  const RetainedSupervisor = fakeSupervisor({
    construct(self, options) {
      acceptRoot = dirname(options.dataRoot);
    },
    start: () => {
      throw new Error("the runtime never became usable");
    },
    reclaimAll(self) {
      self.kept.push({ runRoot: foreignRunRoot, pid: 4711, pgid: 4711, reaped: true });
      return [
        { stopped: false, reaped: true, cleaned: false, steps: [], errors: [`could not remove ${foreignRunRoot}`] },
      ];
    },
  });
  process.env.NODE_PATH = "/sentinel/node-path";
  process.env.ANTHROPIC_API_KEY = "sentinel-key";
  const expectedEnv = snapshotEnv(INHERITED_KEYS);
  try {
    await assert.rejects(
      entryModule.runAcceptance(ARTIFACT_ROOT, { supervisorClass: RetainedSupervisor }),
      (error) => {
        assert.match(error.message, /the runtime never became usable/);
        assert.match(error.message, /retained at/);
        assert.match(error.message, /omp-t21-repair-retained-run/);
        return true;
      },
    );
    assert.equal(existsSync(acceptRoot), true, "an unreclaimable run must keep the acceptance root");
    for (const key of INHERITED_KEYS) {
      const value = expectedEnv.get(key);
      if (value === undefined) assert.equal(Object.hasOwn(process.env, key), false, `${key} must be restored`);
      else assert.equal(process.env[key], value, `${key} must be restored`);
    }
  } finally {
    restoreEnv(snapshot);
    if (acceptRoot) rmSync(acceptRoot, { recursive: true, force: true });
  }
});

test("a failed acceptance deletes only a root whose runs were all reclaimed", { skip: skipWithoutArtifact }, async () => {
  const snapshot = snapshotEnv(INHERITED_KEYS);
  let acceptRoot = null;
  const CleanSupervisor = fakeSupervisor({
    construct(self, options) {
      acceptRoot = dirname(options.dataRoot);
    },
    start: () => {
      throw new Error("the runtime never became usable");
    },
  });
  const expectedEnv = snapshotEnv(INHERITED_KEYS);
  try {
    await assert.rejects(entryModule.runAcceptance(ARTIFACT_ROOT, { supervisorClass: CleanSupervisor }));
    assert.equal(existsSync(acceptRoot), false, "a clean reclamation disposes of the scratch root");
    for (const key of INHERITED_KEYS) {
      const value = expectedEnv.get(key);
      if (value === undefined) assert.equal(Object.hasOwn(process.env, key), false, `${key} must be restored`);
      else assert.equal(process.env[key], value, `${key} must be restored`);
    }
  } finally {
    restoreEnv(snapshot);
    if (acceptRoot) rmSync(acceptRoot, { recursive: true, force: true });
  }
});
