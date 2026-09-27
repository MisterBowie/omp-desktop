/**
 * The release gate (M5/T20-R4B, ADR 0307).
 *
 * Two guarantees are tested here. First, every packaging command must run the
 * sidecar preflight between the runtime bundling step and electron-builder, so
 * a release cannot ship a missing, stale or foreign runtime. Second, the
 * preflight itself fails closed: a cross-target release may only proceed with
 * an artifact staged for exactly that platform and architecture that verifies
 * against the controlled manifest being released — the host binary is never
 * reused for another platform, and a tampered artifact stops the release.
 *
 * The fixtures are tiny git repositories and stand-in artifacts; no compiler and
 * no electron-builder run here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_VERSION,
  cleanupScratch,
  fixtureRepo,
  scratch,
  stageArtifact,
  writeFixtureManifest,
} from "./helpers/omp-fork-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..", "..");
const sidecarScript = join(appRoot, "scripts", "omp-sidecar.mjs");
const packageJson = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

/** A platform that is never the host, so the cross-target path is exercised. */
const CROSS_PLATFORM = process.platform === "win32" ? "darwin" : "win32";

process.on("exit", cleanupScratch);

function runPreflight(args) {
  return spawnSync(process.execPath, [sidecarScript, "--preflight", ...args], { encoding: "utf8" });
}

/** A fixture checkout, its manifest, and the staged-artifact options for it. */
function releaseFixture() {
  const fixture = fixtureRepo();
  const manifestPath = writeFixtureManifest(fixture);
  return {
    fixture,
    manifestPath,
    artifactOptions: {
      platform: CROSS_PLATFORM,
      arch: "x64",
      patchLevel: `${fixture.baseSha.slice(0, 7)}+fixture.1`,
      baseSha: fixture.baseSha,
      forkCommit: fixture.headSha,
      ompVersion: FIXTURE_VERSION,
    },
  };
}

function preflightArgs({ fixture, manifestPath }, out) {
  return [
    "--platform",
    CROSS_PLATFORM,
    "--arch",
    "x64",
    "--out",
    out,
    "--source",
    fixture.root,
    "--manifest",
    manifestPath,
  ];
}

test("every release command runs the sidecar preflight before electron-builder", () => {
  const steps = {
    pack: "verify:sidecar",
    dist: "verify:sidecar",
    "dist:mac": "verify:sidecar:mac",
    "dist:win": "verify:sidecar:win",
    "dist:linux": "verify:sidecar:linux",
  };
  for (const [script, step] of Object.entries(steps)) {
    const command = packageJson.scripts[script];
    assert.ok(command, `${script} must exist`);
    const preflight = command.indexOf(`pnpm run ${step} &&`);
    assert.ok(preflight > 0, `${script} must run ${step}`);
    assert.ok(
      command.indexOf("bundle:runtime") < preflight,
      `${script}: the preflight must follow bundle:runtime`,
    );
    assert.ok(
      preflight < command.indexOf("electron-builder"),
      `${script}: the preflight must precede electron-builder`,
    );
  }
  // The steps themselves are the preflight, with the target each release builds.
  assert.equal(packageJson.scripts["verify:sidecar"], "node ../../scripts/omp-sidecar.mjs --preflight");
  assert.equal(
    packageJson.scripts["verify:sidecar:mac"],
    "node ../../scripts/omp-sidecar.mjs --preflight --platform darwin",
  );
  assert.equal(
    packageJson.scripts["verify:sidecar:win"],
    "node ../../scripts/omp-sidecar.mjs --preflight --platform win32 --arch x64",
  );
  assert.equal(
    packageJson.scripts["verify:sidecar:linux"],
    "node ../../scripts/omp-sidecar.mjs --preflight --platform linux --arch x64",
  );
});

test("the preflight admits a staged cross-target artifact built from the same control", () => {
  const release = releaseFixture();
  const out = join(scratch("staged"), "omp-runtime");
  stageArtifact(out, release.artifactOptions);

  const run = runPreflight([...preflightArgs(release, out), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).fork.commit, release.fixture.headSha);
});

test("the preflight refuses a missing, tampered or foreign staged artifact", () => {
  const release = releaseFixture();
  const call = (out) => runPreflight(preflightArgs(release, out));

  // Missing artifact entirely.
  const empty = join(scratch("empty"), "omp-runtime");
  mkdirSync(empty, { recursive: true });
  const missing = call(empty);
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /does not match the controlled manifest|not usable/);

  // Tampered binary digest in the manifest.
  const tamperedManifest = join(scratch("tampered-manifest"), "omp-runtime");
  const stagedManifest = stageArtifact(tamperedManifest, release.artifactOptions);
  const value = JSON.parse(readFileSync(join(tamperedManifest, "provenance.json"), "utf8"));
  value.binary.sha256 = "b".repeat(64);
  writeFileSync(join(tamperedManifest, "provenance.json"), JSON.stringify(value));
  const tamperedDigest = call(tamperedManifest);
  assert.equal(tamperedDigest.status, 1);
  assert.match(tamperedDigest.stderr, /does not match the controlled manifest/);

  // Tampered gate.
  const tamperedGate = join(scratch("tampered-gate"), "omp-runtime");
  const stagedGate = stageArtifact(tamperedGate, release.artifactOptions);
  writeFileSync(stagedGate.gate, `${readFileSync(stagedGate.gate, "utf8")}\n// extra\n`);
  const gateRun = call(tamperedGate);
  assert.equal(gateRun.status, 1);
  assert.match(gateRun.stderr, /extension .*|bytes/);

  // Artifact from a different control: same platform and shape, other patch level.
  const foreign = join(scratch("foreign"), "omp-runtime");
  stageArtifact(foreign, { ...release.artifactOptions, patchLevel: "0000000+other.9" });
  const foreignRun = call(foreign);
  assert.equal(foreignRun.status, 1);
  assert.match(foreignRun.stderr, /patch level|does not match the controlled manifest/);

  // Untouched artifact plus a dirty checkout: the control itself is validated.
  const dirtyOut = join(scratch("dirty"), "omp-runtime");
  stageArtifact(dirtyOut, release.artifactOptions);
  writeFileSync(join(release.fixture.root, "src", "tool.ts"), "export const value = 'dirty';\n");
  const dirtyRun = call(dirtyOut);
  assert.equal(dirtyRun.status, 1);
  assert.match(dirtyRun.stderr, /uncommitted changes/);

  // Staged artifact is untouched by the failures above.
  const stagedManifestSha = JSON.parse(
    readFileSync(join(tamperedManifest, "provenance.json"), "utf8"),
  ).binary.sha256;
  assert.equal(stagedManifestSha, "b".repeat(64));
});

test("a cross-target release cannot reuse the host binary", () => {
  const release = releaseFixture();
  const out = join(scratch("host-binary"), "omp-runtime");
  // Stage the *host* binary name and platform in the runtime directory the
  // cross-target release would consume.
  stageArtifact(out, { ...release.artifactOptions, platform: process.platform });

  const wrongPlatform = runPreflight(preflightArgs(release, out));
  assert.equal(wrongPlatform.status, 1);
  assert.match(wrongPlatform.stderr, /platform|does not match the controlled manifest/);

  // A cross-target release without an explicit architecture is refused rather
  // than defaulting to the host's.
  const noArch = runPreflight([
    "--platform",
    CROSS_PLATFORM,
    "--out",
    out,
    "--source",
    release.fixture.root,
    "--manifest",
    release.manifestPath,
  ]);
  assert.equal(noArch.status, 1);
  assert.match(noArch.stderr, /--arch is required/);
});
