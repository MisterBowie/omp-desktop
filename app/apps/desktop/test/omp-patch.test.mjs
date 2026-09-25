/**
 * `scripts/omp-patch.mjs` probes: the OMP patch set must only ever be applied
 * to a scratch copy of the exact pinned source, and every failure path must
 * refuse loudly and leave nothing behind.
 *
 * The probes run against fixture repositories — a tiny git repo that mimics the
 * pinned checkout layout plus a manifest that points at it — so they assert the
 * script's own contract without cloning or touching `upstream/oh-my-pi`. The
 * real patch set is exercised by `node scripts/omp-patch.mjs --check` and by the
 * T20 feasibility spike (`--patched`), both recorded in
 * `docs/validation/M5-omp-transition-patch.md`.
 *
 * Every expectation below fails on a script that silently rewrote a checksum,
 * applied to a moved base, followed a symlink, overwrote a user directory, or
 * left a half-applied tree (or its temporary root) after an error.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "..", "..", "scripts", "omp-patch.mjs");
const appRoot = join(here, "..", "..", "..");

/** Every temporary directory this file creates, removed in `after`. */
const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});

const GOOD_PATCH = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

const STALE_PATCH = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-export const value = 99;
+export const value = 100;
`;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

/** A minimal stand-in for the pinned OMP checkout, committed and clean. */
function makeSourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "omp-patch-fixture-"));
  scratch.push(root);
  const source = join(root, "source");
  mkdirSync(join(source, "packages", "coding-agent", "scripts"), { recursive: true });
  mkdirSync(join(source, "packages", "utils"), { recursive: true });
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "packages", "coding-agent", "scripts", "omp"), "#!/usr/bin/env node\n");
  writeFileSync(join(source, "packages", "utils", "package.json"), JSON.stringify({ version: "18.2.7" }));
  writeFileSync(join(source, "src", "example.ts"), "export const value = 1;\n");
  // A workspace package plus the hoisted relative symlink a build payload
  // carries; `.gitignore` keeps the payload out of the tracked tree.
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  mkdirSync(join(source, "packages", "example"), { recursive: true });
  writeFileSync(join(source, "packages", "example", "package.json"), JSON.stringify({ name: "@fixture/example" }));
  mkdirSync(join(source, "node_modules", "@fixture"), { recursive: true });
  symlinkSync("../../packages/example", join(source, "node_modules", "@fixture", "example"));
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"]);
  git(source, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture"]);
  return { root, source, sha: git(source, ["rev-parse", "HEAD"]) };
}

function writeManifest(root, { sha, patchBody = GOOD_PATCH, sha256, patchFile = "0001-test.patch", version = "18.2.7" }) {
  const patchesDir = join(root, "patches", "oh-my-pi");
  mkdirSync(patchesDir, { recursive: true });
  const patchPath = join(patchesDir, patchFile);
  if (!existsSync(patchPath)) writeFileSync(patchPath, patchBody);
  const manifestPath = join(patchesDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      patchLevel: `${sha.slice(0, 7)}+test.1`,
      base: { sha, version },
      patch: {
        file: patchFile,
        sha256: sha256 ?? createHash("sha256").update(readFileSync(patchPath)).digest("hex"),
      },
      capabilities: ["test-capability"],
    }),
  );
  return manifestPath;
}

/** Run the script with an isolated TMPDIR so leftovers are detectable. */
function runScript(args, tmp) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp, MY_API_KEY: "canary-value-should-never-print" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Scratch roots the script created under this test's TMPDIR. */
function leftovers(tmp) {
  return readdirSync(tmp).filter((entry) => entry.startsWith("omp-patch-"));
}

test("check applies the patch set to a scratch copy and leaves nothing behind", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source, "--json"], tmp);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.patchLevel, `${fixture.sha.slice(0, 7)}+test.1`);
  assert.equal(report.baseSha, fixture.sha);
  assert.equal(report.tree, null);
  assert.deepEqual(leftovers(tmp), []);
  // The source checkout is never modified by a check run.
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
  assert.equal(readFileSync(join(fixture.source, "src", "example.ts"), "utf8"), "export const value = 1;\n");
});

test("apply writes the patched tree to the requested directory only", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const out = join(tmp, "prepared");
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const result = runScript(["--apply", "--out", out, "--manifest", manifestPath, "--source", fixture.source, "--json"], tmp);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.tree, out);
  assert.equal(readFileSync(join(out, "src", "example.ts"), "utf8"), "export const value = 2;\n");
  // The source is untouched: the patch lives only in the scratch copy.
  assert.equal(readFileSync(join(fixture.source, "src", "example.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("copies the build payload with workspace symlinks left relative to the tree", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const out = join(tmp, "prepared");
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const result = runScript(
    ["--apply", "--out", out, "--prepare-build", "--manifest", manifestPath, "--source", fixture.source, "--json"],
    tmp,
  );

  assert.equal(result.status, 0, result.stderr);
  const link = join(out, "node_modules", "@fixture", "example");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "payload symlink must stay a symlink");
  // Verbatim, not rewritten to an absolute path into the source checkout: a
  // rewritten link would make the tree resolve the UNPATCHED workspace.
  assert.equal(readlinkSync(link), "../../packages/example");
  assert.equal(readFileSync(join(out, "packages", "example", "package.json"), "utf8"), JSON.stringify({ name: "@fixture/example" }));
});

test("refuses a source whose HEAD is not the manifest base", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: "0".repeat(40) });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /source HEAD is .*, manifest patches 0{40}/);
  assert.deepEqual(leftovers(tmp), []);
});

test("refuses a source whose version is not the manifest version", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha, version: "18.2.6" });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /source version is 18\.2\.7, manifest expects 18\.2\.6/);
});

test("refuses a patch whose checksum does not match the manifest", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha, sha256: "a".repeat(64) });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /patch checksum mismatch/);
  assert.deepEqual(leftovers(tmp), []);
});

test("refuses a patch that does not apply to the base", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const out = join(tmp, "prepared");
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha, patchBody: STALE_PATCH });

  const result = runScript(["--apply", "--out", out, "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /git apply --check .* exited 1/);
  // A failed apply never leaves a half-applied tree behind, not even at --out.
  assert.equal(existsSync(out), false);
  assert.deepEqual(leftovers(tmp), []);
});

test("refuses an existing non-empty target and a symlinked target", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const occupied = join(tmp, "occupied");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "user-file.txt"), "keep me\n");
  const occupiedResult = runScript(
    ["--apply", "--out", occupied, "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(occupiedResult.status, 1);
  assert.match(occupiedResult.stderr, /exists and is not empty/);
  assert.equal(readFileSync(join(occupied, "user-file.txt"), "utf8"), "keep me\n");

  const realTarget = join(tmp, "real-target");
  mkdirSync(realTarget);
  const linkTarget = join(tmp, "linked-target");
  symlinkSync(realTarget, linkTarget);
  const linkedResult = runScript(
    ["--apply", "--out", linkTarget, "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(linkedResult.status, 1);
  assert.match(linkedResult.stderr, /must not be a symlink/);
  assert.equal(lstatSync(linkTarget).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(realTarget), []);
});

test("refuses a target inside the source checkout or holding the repository", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const insideSource = join(fixture.source, "scratch");
  const insideResult = runScript(
    ["--apply", "--out", insideSource, "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(insideResult.status, 1);
  assert.match(insideResult.stderr, /must not live inside the source checkout/);
  assert.equal(existsSync(insideSource), false);

  const overAppRoot = runScript(["--apply", "--out", appRoot, "--manifest", manifestPath, "--source", fixture.source], tmp);
  assert.equal(overAppRoot.status, 1);
  assert.match(overAppRoot.stderr, /must not be /);

  const overRepoRoot = runScript(
    ["--apply", "--out", resolve(appRoot, "..", ".."), "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(overRepoRoot.status, 1);
  assert.match(overRepoRoot.stderr, /must not contain /);
});

test("refuses a manifest whose patch escapes the patch directory", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  writeFileSync(join(fixture.root, "evil.patch"), GOOD_PATCH);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha, patchFile: "../evil.patch" });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /patch file must be inside/);
});

test("rejects unusable argument combinations without touching anything", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const checkWithOut = runScript(
    ["--check", "--out", join(tmp, "nope"), "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(checkWithOut.status, 2);
  assert.match(checkWithOut.stderr, /--check takes no --out/);

  const verifyWithoutPayload = runScript(
    ["--apply", "--out", join(tmp, "nope"), "--verify", "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(verifyWithoutPayload.status, 2);
  assert.match(verifyWithoutPayload.stderr, /--verify needs --prepare-build/);

  const unknown = runScript(["--frobnicate"], tmp);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --frobnicate/);
  assert.deepEqual(leftovers(tmp), []);
});

test("never prints inherited credential values", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("canary-value-should-never-print"), false);
  assert.equal(result.stderr.includes("canary-value-should-never-print"), false);
});
