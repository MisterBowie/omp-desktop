/**
 * The bundled-sidecar build entry's refusals, and the desktop pins it must
 * agree with.
 *
 * The build entry decides which OMP source tree may become the shipped runtime.
 * These tests hold it to that: a checkout from the wrong remote, at the wrong
 * commit, with a dirty tree, with a version or file set that disagrees with the
 * controlled patch manifest, or whose patch is not the applied one, must be
 * refused before any compiler runs. The synthetic fixtures are tiny git
 * repositories, so nothing here needs the real fork checkout; the one test that
 * runs a build uses the fixture's tiny stand-in binary and bundles the real
 * tool gate with the real Bun.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OMP_RUNTIME_BASE_SHA,
  OMP_RUNTIME_FORK_COMMIT,
  OMP_RUNTIME_FORK_REPOSITORY,
  OMP_RUNTIME_PATCH_LEVEL,
  OMP_RUNTIME_VERSION,
} from "@pi-desktop/shared";

import {
  FIXTURE_VERSION,
  cleanupScratch,
  fixtureRepo,
  git,
  scratch,
  writeFixtureManifest,
} from "./helpers/omp-fork-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..", "..");
const sidecarScript = join(appRoot, "scripts", "omp-sidecar.mjs");
const patchScript = join(appRoot, "scripts", "omp-patch.mjs");
const manifestPath = join(appRoot, "patches", "oh-my-pi", "manifest.json");

register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { validateForkCheckout, normalizeRepositoryUrl: scriptNormalize, buildBinaryArgs, SIDECAR_BYTECODE } =
  await import(pathToFileURL(sidecarScript));
const { bunBinary, loadManifest } = await import(pathToFileURL(patchScript));
const { normalizeRepositoryUrl: packageNormalize } = await import(
  "../../../packages/omp-runtime/src/bundled.ts"
);

process.on("exit", cleanupScratch);

test("the build entry passes an explicit bytecode mode the fork accepts", () => {
  // The release contract, not an incidental default: the sidecar build names the
  // compile mode instead of inheriting one, and `build.bytecode` in the
  // provenance states it, so the two can never disagree silently. The fork's
  // build entry rejects every other spelling (see its own test), which is what
  // makes a drift here a build failure rather than a different artifact.
  assert.deepEqual(buildBinaryArgs(true), ["scripts/build-binary.ts", "--bytecode"]);
  assert.deepEqual(buildBinaryArgs(false), ["scripts/build-binary.ts", "--no-bytecode"]);
  assert.equal(SIDECAR_BYTECODE, true);
});

test("the desktop pins agree with the controlled patch manifest", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(OMP_RUNTIME_BASE_SHA, manifest.base.sha);
  assert.equal(OMP_RUNTIME_VERSION, manifest.base.version);
  assert.equal(OMP_RUNTIME_PATCH_LEVEL, manifest.patchLevel);
  assert.equal(OMP_RUNTIME_FORK_REPOSITORY, manifest.fork.repository);
  assert.equal(OMP_RUNTIME_FORK_COMMIT, manifest.fork.commit);
  assert.match(manifest.fork.commit, /^[0-9a-f]{40}$/);
});

test("the build entry and the runtime package normalize remotes identically", () => {
  const spellings = [
    "https://github.com/MisterBowie/oh-my-pi",
    "https://github.com/MisterBowie/oh-my-pi.git",
    "git@github.com:MisterBowie/oh-my-pi.git",
    "ssh://git@github.com/MisterBowie/oh-my-pi.git",
    "https://github.com/can1357/oh-my-pi",
    "not a url",
  ];
  for (const spelling of spellings) {
    assert.equal(scriptNormalize(spelling), packageNormalize(spelling), spelling);
  }
  assert.equal(scriptNormalize("git@github.com:MisterBowie/oh-my-pi.git"), "github.com/misterbowie/oh-my-pi");
});

test("a checkout whose HEAD is the manifest's fork commit and patch verifies", () => {
  const { root, manifest, patchPath, headSha } = fixtureRepo();
  const info = validateForkCheckout(root, manifest, patchPath);
  assert.equal(info.head, headSha);
  assert.equal(info.version, FIXTURE_VERSION);
  assert.equal(info.remote, "github.com/misterbowie/oh-my-pi");
});

test("an SSH remote is accepted for an HTTPS manifest entry", () => {
  const { root, manifest, patchPath } = fixtureRepo({ remote: "git@github.com:MisterBowie/oh-my-pi.git" });
  assert.doesNotThrow(() => validateForkCheckout(root, manifest, patchPath));
});

test("the wrong remote, commit, cleanliness, version, file set, or patch is refused", () => {
  const cases = [
    {
      name: "remote",
      build: () => fixtureRepo({ remote: "https://github.com/can1357/oh-my-pi.git" }),
      expect: /origin is github\.com\/can1357\/oh-my-pi/,
    },
    {
      name: "commit",
      build: () => {
        const fixture = fixtureRepo();
        git(["checkout", "-q", fixture.baseSha], fixture.root);
        return fixture;
      },
      expect: /HEAD is .*, the manifest pins fork commit/,
    },
    {
      name: "dirty tree",
      build: () => {
        const fixture = fixtureRepo();
        writeFileSync(join(fixture.root, "src", "tool.ts"), "export const value = 'dirty';\n");
        return fixture;
      },
      expect: /uncommitted changes/,
    },
    {
      name: "version",
      build: () => fixtureRepo(),
      mutate: (fixture) => {
        fixture.manifest.base.version = "1.0.0";
      },
      expect: /source version is 9\.9\.9/,
    },
    {
      name: "file set",
      build: () => fixtureRepo(),
      mutate: (fixture) => {
        fixture.manifest.files = [];
      },
      expect: /differs from base .* in 1 file\(s\), the manifest declares 0/,
    },
    {
      name: "patch",
      build: () => fixtureRepo(),
      mutate: (fixture) => {
        writeFileSync(fixture.patchPath, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
      },
      expect: /git apply --check --reverse/,
    },
  ];
  for (const scenario of cases) {
    const fixture = scenario.build();
    scenario.mutate?.(fixture);
    assert.throws(
      () => validateForkCheckout(fixture.root, fixture.manifest, fixture.patchPath),
      scenario.expect,
      `expected ${scenario.name} to be refused`,
    );
  }
});

test("--check runs the same gate as a process, exiting non-zero on refusal", () => {
  const good = fixtureRepo();
  const goodManifest = writeFixtureManifest(good);
  const goodRun = spawnSync(
    process.execPath,
    [sidecarScript, "--check", "--source", good.root, "--manifest", goodManifest, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(goodRun.status, 0, goodRun.stderr);
  assert.equal(JSON.parse(goodRun.stdout).forkCommit, good.headSha);

  const wrongRemote = fixtureRepo({ remote: "https://github.com/can1357/oh-my-pi.git" });
  const wrongRemoteManifest = writeFixtureManifest(wrongRemote);
  const refused = spawnSync(
    process.execPath,
    [sidecarScript, "--check", "--source", wrongRemote.root, "--manifest", wrongRemoteManifest],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /OMP-SIDECAR-FAIL .*origin is github\.com\/can1357/);

  // The same gate rejects a checkout whose HEAD is not the manifest's commit.
  const wrongCommit = spawnSync(
    process.execPath,
    [
      sidecarScript,
      "--check",
      "--source",
      good.root,
      "--manifest",
      writeFixtureManifest(good, (m) => {
        m.fork.commit = "f".repeat(40);
      }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stderr, /the manifest pins fork commit f{40}/);
});

test("the patch manifest refuses a malformed fork block", () => {
  const fixture = fixtureRepo();
  assert.doesNotThrow(() => loadManifest(writeFixtureManifest(fixture)));
  assert.throws(
    () => loadManifest(writeFixtureManifest(fixture, (m) => delete m.fork)),
    /manifest field fork\.repository is missing/,
  );
  assert.throws(
    () => loadManifest(writeFixtureManifest(fixture, (m) => (m.fork.commit = "not-a-sha"))),
    /fork\.commit is not a full commit id/,
  );
  assert.throws(
    () => loadManifest(writeFixtureManifest(fixture, (m) => (m.fork.tree = "short"))),
    /fork\.tree is not a full tree id/,
  );
});

/**
 * Outcome determinism for the one compile in this build that goes through a
 * bundler: Bun writes each module's path comment relative to the build cwd, so
 * the gate's bytes — and its provenance digest — must not depend on the
 * transient `mkdtemp` run root, whose depth follows `TMPDIR`. Two real builds
 * under run roots of different depth must land on identical gate bytes and an
 * identical provenance manifest; the heavy binary is the fixture's stand-in,
 * the gate bundle is the real one.
 */
const bunProbe = spawnSync(bunBinary(), ["--version"], { encoding: "utf8" });

test(
  "the tool gate bundle is identical under temporary roots of different depth",
  {
    skip:
      bunProbe.status === 0
        ? false
        : `Bun is required to bundle the tool gate (install Bun 1.4.2 or set BUN_BINARY): ${(bunProbe.error?.message ?? bunProbe.stderr ?? "").trim()}`,
    timeout: 180_000,
  },
  () => {
    const fixture = fixtureRepo();
    const manifestPath = writeFixtureManifest(fixture);
    const root = scratch("depth");
    const shallowTmp = join(root, "shallow");
    const deepTmp = join(root, "deep", "one", "two", "three");
    mkdirSync(shallowTmp, { recursive: true });
    mkdirSync(deepTmp, { recursive: true });

    const buildUnder = (tmp, label) => {
      const out = join(root, label);
      const run = spawnSync(
        process.execPath,
        [sidecarScript, "--build", "--source", fixture.root, "--manifest", manifestPath, "--out", out, "--json"],
        { encoding: "utf8", env: { ...process.env, TMPDIR: tmp } },
      );
      assert.equal(run.status, 0, `${label}: ${run.stderr}`);
      return {
        provenance: JSON.parse(run.stdout),
        gate: readFileSync(join(out, "extensions", "omp-desktop-gate.js")),
      };
    };

    const shallow = buildUnder(shallowTmp, "shallow");
    const deep = buildUnder(deepTmp, "deep");
    assert.deepEqual(deep.gate, shallow.gate, "the gate bundle must not depend on the run root");
    assert.deepEqual(
      deep.provenance,
      shallow.provenance,
      "the provenance manifest must not depend on the run root",
    );
    // The gate is loaded from Resources, where nothing can resolve a relative
    // import beside it: the bundle must stay self-contained.
    assert.doesNotMatch(shallow.gate.toString("utf8"), /(?:from|import)\s*\(?\s*["'][.]{1,2}\//);
  },
);
