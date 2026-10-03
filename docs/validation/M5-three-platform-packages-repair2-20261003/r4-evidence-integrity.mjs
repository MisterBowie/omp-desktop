#!/usr/bin/env node
/**
 * R4 integrity check (2026-10-03): this evidence directory must have one name
 * set in three places — the self-excluding `SHA256SUMS.txt` manifest, the files
 * on disk, and what Git tracks — and every digest must match the delivered
 * bytes. Self-exclusion covers the two derived meta files: `SHA256SUMS.txt`
 * (the manifest) and `r4-evidence-integrity.txt` (this check's own report).
 *
 * Usage: node r4-evidence-integrity.mjs [repo-root]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const repo = process.argv[2] ?? join(import.meta.dirname, "..", "..", "..");
const dir = join(repo, "docs", "validation", "M5-three-platform-packages-repair2-20261003");
const SELF = ["SHA256SUMS.txt", "r4-evidence-integrity.txt"];

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// 1. The manifest, self-excluded.
const manifest = [];
for (const line of readFileSync(join(dir, SELF[0]), "utf8").trim().split("\n")) {
  const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
  if (!match) fail(`unparseable manifest line: ${line}`);
  const [, digest, name] = match;
  if (SELF.includes(name)) fail(`the manifest must not list a derived meta file: ${name}`);
  const bytes = readFileSync(join(dir, name));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest) fail(`${name}: sha256 ${actual} != manifest ${digest}`);
  manifest.push({ name, digest, bytes: statSync(join(dir, name)).size });
}
const manifestNames = manifest.map((entry) => entry.name).sort();

// 2. The files on disk, self-excluded.
const actualNames = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !SELF.includes(entry.name))
  .map((entry) => entry.name)
  .sort();

// 3. What Git tracks in the directory, self-excluded.
const trackedNames = execFileSync("git", ["ls-files", dir], { cwd: repo, encoding: "utf8" })
  .trim()
  .split("\n")
  .map((path) => basename(path))
  .filter((name) => !SELF.includes(name))
  .sort();

if (!same(manifestNames, actualNames)) {
  fail(
    `manifest != disk:\n  only manifest: ${manifestNames.filter((n) => !actualNames.includes(n))}\n  only disk: ${actualNames.filter((n) => !manifestNames.includes(n))}`,
  );
}
if (!same(manifestNames, trackedNames)) {
  fail(
    `manifest != git:\n  only manifest: ${manifestNames.filter((n) => !trackedNames.includes(n))}\n  only git: ${trackedNames.filter((n) => !manifestNames.includes(n))}`,
  );
}

console.log(`manifest (${manifestNames.length}): ${manifestNames.join(", ")}`);
console.log(`disk     (${actualNames.length}): equal to manifest`);
console.log(`git      (${trackedNames.length}): equal to manifest`);
console.log(`digests  : ${manifest.length}/${manifest.length} OK (sha256 over the delivered bytes)`);
console.log(`self-excluded: ${SELF.join(", ")}`);
console.log("OK: manifest == disk == git, self-excluding the two derived meta files");
