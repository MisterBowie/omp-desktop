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
 *
 * Scratch paths are spelled exactly as `mkdtempSync(tmpdir())` returns them —
 * on macOS `/var/folders/…`, whose canonical form is `/private/var/…` — so a
 * script that mistakes the platform's own root aliases for caller-planted
 * links fails here rather than only on a developer's machine.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptDir = join(here, "..", "..", "..", "scripts");
const scriptPath = join(scriptDir, "omp-patch.mjs");
const { canonicalizeAncestor, isSignalableProcessGroup, isTrustedRootAlias, runReaped } = await import(
  pathToFileURL(scriptPath).href
);
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

function writeManifest(root, { sha, patchBody = GOOD_PATCH, sha256, patchFile = "0001-test.patch", version = "18.2.7", schemaVersion = 1 }) {
  const patchesDir = join(root, "patches", "oh-my-pi");
  mkdirSync(patchesDir, { recursive: true });
  const patchPath = join(patchesDir, patchFile);
  if (!existsSync(patchPath)) writeFileSync(patchPath, patchBody);
  const manifestPath = join(patchesDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion,
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
  // The reported path is canonical: on macOS the caller's `/var/folders/…`
  // spelling resolves to `/private/var/folders/…`, and every write below is
  // made on the canonical path.
  assert.equal(report.tree, realpathSync(out));
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

test("canonicalizes --source, so an --out inside the real checkout is still refused", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });
  // The real checkout named through a symlink: comparing `--source` lexically
  // would miss it and write (then clean up) inside the source itself.
  const sourceLink = join(fixture.root, "source-link");
  symlinkSync(fixture.source, sourceLink);
  const listing = readdirSync(fixture.source).sort();

  const insideReal = runScript(
    ["--apply", "--out", join(fixture.source, "inside"), "--manifest", manifestPath, "--source", sourceLink],
    tmp,
  );
  assert.equal(insideReal.status, 1, insideReal.stderr);
  assert.match(insideReal.stderr, /must not live inside the source checkout/);
  assert.equal(existsSync(join(fixture.source, "inside")), false);
  assert.deepEqual(readdirSync(fixture.source).sort(), listing);
  assert.equal(readFileSync(join(fixture.source, "src", "example.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");

  // The same pair with the output spelled inside the symlinked name: the
  // untrusted-parent rule fires first, and the source stays untouched.
  const insideLink = runScript(
    ["--apply", "--out", join(sourceLink, "inside-link"), "--manifest", manifestPath, "--source", sourceLink],
    tmp,
  );
  assert.equal(insideLink.status, 1, insideLink.stderr);
  assert.match(insideLink.stderr, /must not be reached through a symlink/);
  assert.equal(existsSync(join(fixture.source, "inside-link")), false);

  // An output reached through a link that lands in the checkout is refused
  // before anything is created there either.
  const linkToSource = join(fixture.root, "link-to-source");
  symlinkSync(fixture.source, linkToSource);
  const viaLink = runScript(
    ["--apply", "--out", join(linkToSource, "tree"), "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(viaLink.status, 1, viaLink.stderr);
  assert.match(viaLink.stderr, /must not be reached through a symlink/);
  assert.deepEqual(readdirSync(fixture.source).sort(), listing);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("refuses a target reached through a symlinked parent and never writes or deletes the link target", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  // The dangerous shape: the target itself does not exist, so only the parent
  // link is in the path. Writing (and, on failure, cleaning up) through it would
  // hit the real directory behind the link.
  const protectedDir = join(tmp, "protected");
  mkdirSync(protectedDir);
  writeFileSync(join(protectedDir, "keep.txt"), "keep me\n");
  const link = join(tmp, "link-to-protected");
  symlinkSync(protectedDir, link);

  const viaLink = runScript(
    ["--apply", "--out", join(link, "new-tree"), "--manifest", manifestPath, "--source", fixture.source],
    tmp,
  );
  assert.equal(viaLink.status, 1);
  assert.match(viaLink.stderr, /must not be reached through a symlink/);
  assert.equal(readdirSync(protectedDir).join(","), "keep.txt");
  assert.equal(readFileSync(join(protectedDir, "keep.txt"), "utf8"), "keep me\n");

  // Same shape pointing at the source checkout, with a patch that fails to
  // apply: neither the source nor the link target may be touched, and the
  // failure must not delete anything behind the link.
  const stalePath = writeManifest(fixture.root, { sha: fixture.sha, patchBody: STALE_PATCH, patchFile: "0002-stale.patch" });
  const intoSource = join(tmp, "link-to-source");
  symlinkSync(fixture.source, intoSource);
  const sourceListing = readdirSync(fixture.source).sort();
  const viaSourceLink = runScript(
    ["--apply", "--out", join(intoSource, "tree"), "--manifest", stalePath, "--source", fixture.source],
    tmp,
  );
  assert.equal(viaSourceLink.status, 1);
  assert.match(viaSourceLink.stderr, /must not be reached through a symlink/);
  // Nothing behind the link was created or removed.
  assert.deepEqual(readdirSync(fixture.source).sort(), sourceListing);
  assert.equal(existsSync(join(fixture.source, "tree")), false);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
  assert.deepEqual(readdirSync(protectedDir), ["keep.txt"]);
});

test("trusts only root-owned aliases directly below the filesystem root", () => {
  // macOS reaches `tmpdir()` through `/var -> private/var` (and `/tmp`,
  // `/etc`): root-owned links the platform itself installs as direct children
  // of `/`. Following them is safe — an unprivileged caller cannot create,
  // replace, or delete such an entry — while every other link stays refused.
  const rootOwnedLink = { isSymbolicLink: () => true, uid: 0 };
  const userOwnedLink = { isSymbolicLink: () => true, uid: 1000 };

  assert.equal(isTrustedRootAlias("/var", rootOwnedLink), true);
  assert.equal(isTrustedRootAlias("/tmp", rootOwnedLink), true);
  assert.equal(isTrustedRootAlias("/var", { isSymbolicLink: () => false, uid: 0 }), false, "a real directory is not an alias");
  assert.equal(isTrustedRootAlias("/var", userOwnedLink), false, "only root may own an alias");
  assert.equal(isTrustedRootAlias("/home/runner/work/link", rootOwnedLink), false, "a deeper link is caller-reachable");
  assert.equal(isTrustedRootAlias("/private/var/folders/x/T/link", rootOwnedLink), false);
  assert.equal(
    isTrustedRootAlias("/var", { isSymbolicLink: () => true, uid: undefined }),
    false,
    "an unknown owner must not be trusted",
  );
});

test("canonicalizes the ancestor chain through a trusted alias and still refuses deeper links", () => {
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  // The macOS shape, reproduced below a fixture root: the alias sits at the top
  // of the tree, the link a caller could plant sits deeper inside it.
  const fixtureRoot = join(tmp, "fakeroot");
  const realTree = join(fixtureRoot, "private", "var", "T", "tree");
  mkdirSync(realTree, { recursive: true });
  const alias = join(fixtureRoot, "var");
  symlinkSync(join(fixtureRoot, "private", "var"), alias);

  // The shipped policy trusts only entries directly below the *filesystem*
  // root, which a test user cannot create; the fixture policy adds this tree's
  // alias and keeps the shipped rule for the platform aliases above it (macOS
  // `/var`), so the walk is exercised unchanged on either platform.
  const trustAlias = (componentPath, stats) => isTrustedRootAlias(componentPath, stats) || componentPath === alias;
  assert.equal(canonicalizeAncestor(join(alias, "T", "tree"), trustAlias), realpathSync(realTree));

  const deeper = join(realTree, "link");
  symlinkSync(join(fixtureRoot, "private", "var"), deeper);
  assert.throws(
    () => canonicalizeAncestor(join(deeper, "elsewhere"), trustAlias),
    /must not be reached through a symlink/,
    "a link the caller can plant stays refused even under a permissive fixture policy",
  );
  assert.throws(
    () => canonicalizeAncestor(join(alias, "T", "tree")),
    /must not be reached through a symlink/,
    "the shipped policy refuses an alias it was not told to trust",
  );
});

test("follows the aliases the platform ships directly below the filesystem root", () => {
  // macOS ships `/var`, `/tmp`, and `/etc` as root-owned links into `/private`
  // (so `tmpdir()` is `/var/folders/…`); a usrmerged Linux ships `/bin`,
  // `/lib`, `/sbin`. These are the platform's own doing and must resolve, while
  // everything the walk was told not to trust stays refused — the shipped
  // policy is exercised here against the real filesystem root.
  const aliases = readdirSync("/").filter((entry) => {
    try {
      return lstatSync(join("/", entry)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  assert.ok(aliases.length > 0, "expected this platform to ship a root-level alias to probe with");
  for (const alias of aliases) {
    const componentPath = join("/", alias);
    assert.equal(
      isTrustedRootAlias(componentPath, lstatSync(componentPath)),
      true,
      `${componentPath} is a root-owned link directly below the filesystem root`,
    );
    assert.equal(canonicalizeAncestor(componentPath), realpathSync(componentPath));
  }
  // The shape that failed on macOS: the platform temp directory resolves
  // through its aliases, so the scratch parent must canonicalize, not refuse.
  assert.equal(canonicalizeAncestor(tmpdir()), realpathSync(tmpdir()));
});

test("creates a missing nested target and accepts an existing empty one", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  const nested = join(tmp, "a", "b", "c");
  const created = runScript(
    ["--apply", "--out", nested, "--manifest", manifestPath, "--source", fixture.source, "--json"],
    tmp,
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout.trim()).tree, realpathSync(nested));
  assert.equal(readFileSync(join(nested, "src", "example.ts"), "utf8"), "export const value = 2;\n");

  const empty = join(tmp, "empty-target");
  mkdirSync(empty);
  const accepted = runScript(
    ["--apply", "--out", empty, "--manifest", manifestPath, "--source", fixture.source, "--json"],
    tmp,
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readFileSync(join(empty, "src", "example.ts"), "utf8"), "export const value = 2;\n");
});

test("rejects a flag whose value is missing instead of silently applying to a temp tree", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  for (const flag of ["--out", "--manifest", "--source"]) {
    const result = runScript(["--apply", "--manifest", manifestPath, "--source", fixture.source, flag], tmp);
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${flag} requires a value`));
    assert.deepEqual(leftovers(tmp), []);
  }
});

test("rejects a flag whose value is another flag instead of using it as a path", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha });

  // `--out --json` used to consume the flag as a *path*, create `$PWD/--json`
  // and copy the whole tracked tree into it. A value is a path; a following flag
  // is a missing value (`./-name` spells a path that really starts with a dash).
  for (const [flag, next] of [
    ["--out", "--json"],
    ["--out", "--source"],
    ["--manifest", "--out"],
    ["--source", "--manifest"],
  ]) {
    const stray = resolve(process.cwd(), next);
    const result = runScript(["--apply", "--manifest", manifestPath, "--source", fixture.source, flag, next], tmp);
    assert.equal(result.status, 2, `${flag} ${next}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${flag} requires a value`));
    assert.equal(existsSync(stray), false, `${next} must never be used as a scratch tree`);
    assert.deepEqual(leftovers(tmp), []);
  }
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("rejects an unsupported manifest schema version", () => {
  const fixture = makeSourceFixture();
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const manifestPath = writeManifest(fixture.root, { sha: fixture.sha, schemaVersion: 99 });

  const result = runScript(["--check", "--manifest", manifestPath, "--source", fixture.source], tmp);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported manifest schemaVersion 99/);
  assert.deepEqual(leftovers(tmp), []);
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

test("reaps the whole process group when a verification child times out", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  const pidFile = join(tmp, "grandchild.pid");
  const fixture = join(tmp, "hang.mjs");
  // A verification child that spawns its own long-lived child (the shape of the
  // OMP test fixtures: MCP servers, kernels) and then never exits. A plain
  // spawnSync timeout would kill only the parent and leave the grandchild.
  writeFileSync(
    fixture,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );

  const result = await runReaped(process.execPath, [fixture], { cwd: tmp, env: process.env, timeoutMs: 1_500 });

  assert.equal(result.timedOut, true);
  const grandchildPid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(grandchildPid > 0, "fixture did not report its grandchild");
  let alive = true;
  for (let attempt = 0; attempt < 60 && alive; attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `grandchild ${grandchildPid} survived the reaped timeout`);
});

test("never signals a degenerate process-group target", () => {
  // `process.kill(-pid, …)` negates its argument, so the degenerate targets are
  // catastrophic rather than useless: `-0` would signal this process's own
  // group and `-1` every process the user may signal. Upstream guards the same
  // set before negating (`upstream/oh-my-pi`…/eval/kernel-base.ts,
  // `isSignalableProcessGroup`).
  assert.equal(isSignalableProcessGroup(undefined), false);
  assert.equal(isSignalableProcessGroup(0), false);
  assert.equal(isSignalableProcessGroup(1), false);
  assert.equal(isSignalableProcessGroup(-9), false);
  assert.equal(isSignalableProcessGroup(2.5), false);
  assert.equal(isSignalableProcessGroup(Number.NaN), false);
  assert.equal(isSignalableProcessGroup(4321), true);
});

test("reports a spawn failure at once, with no timer left armed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "omp-patch-tmp-"));
  scratch.push(tmp);
  // Node reports a missing command as an `error` event with `pid === undefined`:
  // there is no process and no group to reap, so the call has to settle
  // immediately instead of waiting the timeout out.
  const timersBefore = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const started = Date.now();
  const result = await runReaped(join(tmp, "no-such-command"), [], { cwd: tmp, env: process.env, timeoutMs: 60_000 });
  const elapsed = Date.now() - started;

  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.error?.code, "ENOENT");
  assert.ok(elapsed < 5_000, `spawn failure settled only after ${elapsed}ms`);
  assert.equal(
    process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length,
    timersBefore,
    "the verification timeout must be cleared when the child cannot be spawned",
  );
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
