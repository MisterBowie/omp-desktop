/**
 * The bundled-sidecar build entry's refusals, and the desktop pins it must
 * agree with.
 *
 * The build entry decides which OMP source tree may become the shipped runtime.
 * These tests hold it to that: a checkout from the wrong remote, at the wrong
 * commit, with a dirty tree, with a version or file set that disagrees with the
 * controlled patch manifest, or whose patch is not the applied one, must be
 * refused before any compiler runs. The synthetic fixtures are tiny git
 * repositories, so nothing here needs the real fork checkout or a build.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..", "..");
const sidecarScript = join(appRoot, "scripts", "omp-sidecar.mjs");
const patchScript = join(appRoot, "scripts", "omp-patch.mjs");
const manifestPath = join(appRoot, "patches", "oh-my-pi", "manifest.json");

register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { validateForkCheckout, normalizeRepositoryUrl: scriptNormalize } = await import(
  pathToFileURL(sidecarScript)
);
const { loadManifest } = await import(pathToFileURL(patchScript));
const { normalizeRepositoryUrl: packageNormalize } = await import(
  "../../../packages/omp-runtime/src/bundled.ts"
);

const FIXTURE_VERSION = "9.9.9";
const created = [];

function scratch(label) {
  const root = mkdtempSync(join(tmpdir(), `omp-sidecar-${label}-`));
  created.push(root);
  return root;
}

process.on("exit", () => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitRaw(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout ?? "";
}

function git(args, cwd) {
  return gitRaw(args, cwd).trim();
}

/**
 * A minimal OMP-shaped checkout whose HEAD is `base + one patch`, with a
 * manifest that describes exactly that. Returns `{ root, manifest, patchPath }`.
 */
function fixtureRepo({ remote = "git@github.com:MisterBowie/oh-my-pi.git" } = {}) {
  const root = scratch("repo");
  git(["init", "-q"], root);
  git(["config", "user.email", "fixture@example.invalid"], root);
  git(["config", "user.name", "Fixture"], root);
  git(["remote", "add", "origin", remote], root);
  mkdirSync(join(root, "packages", "utils"), { recursive: true });
  mkdirSync(join(root, "packages", "coding-agent", "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "packages", "utils", "package.json"), JSON.stringify({ version: FIXTURE_VERSION }));
  writeFileSync(join(root, "packages", "coding-agent", "scripts", "build-binary.ts"), "// fixture build entry\n");
  writeFileSync(join(root, "src", "tool.ts"), "export const value = 'base';\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  const baseSha = git(["rev-parse", "HEAD"], root);

  writeFileSync(join(root, "src", "tool.ts"), "export const value = 'patched';\n");
  git(["commit", "-q", "-am", "patch"], root);
  const headSha = git(["rev-parse", "HEAD"], root);

  const patchDir = scratch("patch");
  const patchPath = join(patchDir, "0001-fixture.patch");
  writeFileSync(patchPath, gitRaw(["diff", baseSha, headSha], root));

  const manifest = {
    fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, branch: "fixture", commit: headSha },
    base: { sha: baseSha, version: FIXTURE_VERSION },
    files: ["src/tool.ts"],
  };
  return { root, manifest, patchDir, patchPath, baseSha, headSha };
}

/**
 * The same fixture as a manifest the CLI can load: the patch next to
 * `manifest.json`, with its checksum and byte count, so `--check` exercises the
 * real manifest validation rather than a mock.
 */
function writeFixtureManifest(fixture, mutate = () => {}) {
  const dir = scratch("manifest");
  const patchFile = "0001-fixture.patch";
  cpSync(fixture.patchPath, join(dir, patchFile));
  const manifest = {
    schemaVersion: 1,
    patchLevel: `${fixture.baseSha.slice(0, 7)}+fixture.1`,
    base: { sha: fixture.baseSha, version: FIXTURE_VERSION },
    fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, branch: "fixture", commit: fixture.headSha },
    patch: {
      file: patchFile,
      sha256: createHash("sha256").update(readFileSync(join(dir, patchFile))).digest("hex"),
      bytes: statSync(join(dir, patchFile)).size,
    },
    capabilities: ["fixture-capability"],
    files: ["src/tool.ts"],
  };
  mutate(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return join(dir, "manifest.json");
}

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
    [sidecarScript, "--check", "--source", good.root, "--manifest", writeFixtureManifest(good, (m) => {
      m.fork.commit = "f".repeat(40);
    })],
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
