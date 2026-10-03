#!/usr/bin/env node
/**
 * Verify the M5/T20-D-Enter evidence manifests against the files on disk.
 *
 * Read-only. For both repair rounds (`repair-20261003-*` and
 * `repair2-20261003-*`) it checks, for every `SHA256SUMS.txt` found in the
 * tree:
 *
 *   - each listed digest matches the file's actual SHA-256;
 *   - each listed path is Git-tracked;
 *   - the manifest does not list itself;
 *
 * and, per covered tree:
 *
 *   - the top-level manifest covers exactly the files under its own tree
 *     except itself (file-set totality, nested manifests included).
 *
 * The covered-set rule is documented in `../README.md`. Prints one JSON report
 * to stdout; exits non-zero when anything mismatches.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "..");
const repo = resolve(dir, "../../..");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function tracked(relPath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: repo,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const manifestPaths = [];
for (const prefix of ["repair-20261003-", "repair2-20261003-"]) {
  for (const path of readdirSync(dir)) {
    if (!path.startsWith(prefix) || path === `${prefix}SHA256SUMS.txt`) continue;
    const full = join(dir, path);
    if (!statSync(full).isDirectory()) continue;
    for (const file of walkFiles(full)) {
      if (file.endsWith("SHA256SUMS.txt")) manifestPaths.push(file);
    }
  }
  manifestPaths.push(join(dir, `${prefix}SHA256SUMS.txt`));
}
manifestPaths.sort();

const report = { manifests: [], trees: [], mismatches: [] };
for (const manifestPath of manifestPaths) {
  if (!existsSync(manifestPath)) {
    report.mismatches.push({ manifest: relative(dir, manifestPath), error: "manifest missing" });
    continue;
  }
  const manifestDir = dirname(manifestPath);
  const manifestRel = relative(dir, manifestPath);
  const entry = { manifest: manifestRel, entries: 0, mismatches: [], selfListed: false };
  const lines = readFileSync(manifestPath, "utf8").split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      entry.mismatches.push({ line, error: "malformed line" });
      continue;
    }
    const [, expected, name] = match;
    entry.entries += 1;
    const target = resolve(manifestDir, name);
    const targetRel = relative(repo, target);
    if (target === manifestPath) {
      entry.selfListed = true;
      entry.mismatches.push({ file: name, error: "manifest lists itself" });
      continue;
    }
    if (!existsSync(target)) {
      entry.mismatches.push({ file: name, error: "missing file" });
      continue;
    }
    const actual = sha256(target);
    if (actual !== expected) {
      entry.mismatches.push({ file: name, expected, actual, error: "digest mismatch" });
      continue;
    }
    if (!tracked(targetRel.split("\\").join("/"))) {
      entry.mismatches.push({ file: name, error: "not Git-tracked" });
    }
  }
  report.manifests.push(entry);
  if (entry.mismatches.length > 0 || entry.selfListed) {
    report.mismatches.push(...entry.mismatches.map((m) => ({ manifest: manifestRel, ...m })));
  }
}

for (const prefix of ["repair-20261003-", "repair2-20261003-"]) {
  const topRel = `${prefix}SHA256SUMS.txt`;
  const top = join(dir, topRel);
  const tree = { manifest: topRel, files: 0, uncovered: [], extra: [] };
  if (!existsSync(top)) {
    report.mismatches.push({ manifest: topRel, error: "top manifest missing" });
    report.trees.push(tree);
    continue;
  }
  const actual = new Set();
  for (const path of readdirSync(dir)) {
    if (!path.startsWith(prefix) || path === topRel) continue;
    const full = join(dir, path);
    if (statSync(full).isDirectory()) {
      for (const file of walkFiles(full)) actual.add(relative(dir, file));
    } else if (statSync(full).isFile()) {
      actual.add(path);
    }
  }
  const listed = new Set(
    readFileSync(top, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => /^[0-9a-f]{64} {2}(.+)$/.exec(line)?.[1])
      .filter((name) => typeof name === "string"),
  );
  for (const file of actual) if (!listed.has(file)) tree.uncovered.push(file);
  for (const file of listed) if (!actual.has(file)) tree.extra.push(file);
  tree.files = actual.size;
  if (tree.uncovered.length > 0 || tree.extra.length > 0) {
    report.mismatches.push({ manifest: topRel, uncovered: tree.uncovered, extra: tree.extra });
  }
  report.trees.push(tree);
}

report.passed = report.mismatches.length === 0;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
