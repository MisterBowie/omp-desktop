#!/usr/bin/env node
/**
 * R1 check (2026-10-03): the original M5 evidence directory must have one name
 * set in three places — the self-excluding SHA256SUMS.txt manifest, the files
 * on disk, and what Git tracks. This walks all three, verifies every digest,
 * and reports the delivered log's identity. Self-exclusion: SHA256SUMS.txt
 * itself is in none of the three sets.
 *
 * Usage: node r1-evidence-integrity.mjs [repo-root]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const repo = process.argv[2] ?? join(import.meta.dirname, "..", "..", "..");
const dir = join(repo, "docs", "validation", "M5-three-platform-packages");
const SELF = "SHA256SUMS.txt";

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// 1. The manifest, self-excluded.
const manifest = [];
for (const line of readFileSync(join(dir, SELF), "utf8").trim().split("\n")) {
  const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
  if (!match) fail(`unparseable manifest line: ${line}`);
  const [, digest, name] = match;
  const path = join(dir, name);
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest) fail(`${name}: sha256 ${actual} != manifest ${digest}`);
  manifest.push({ name, digest, bytes: statSync(path).size });
}
const manifestNames = manifest.map((entry) => entry.name).sort();

// 2. The files on disk, self-excluded.
const actualNames = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== SELF)
  .map((entry) => entry.name)
  .sort();

// 3. What Git tracks in the directory, self-excluded.
const trackedNames = execFileSync("git", ["ls-files", dir], { cwd: repo, encoding: "utf8" })
  .trim()
  .split("\n")
  .map((path) => basename(path))
  .filter((name) => name !== SELF)
  .sort();

if (!same(manifestNames, actualNames)) fail(`manifest != disk:\n  only manifest: ${manifestNames.filter((n) => !actualNames.includes(n))}\n  only disk: ${actualNames.filter((n) => !manifestNames.includes(n))}`);
if (!same(manifestNames, trackedNames)) fail(`manifest != git:\n  only manifest: ${manifestNames.filter((n) => !trackedNames.includes(n))}\n  only git: ${trackedNames.filter((n) => !manifestNames.includes(n))}`);

const log = manifest.find((entry) => entry.name === "linux-dist-build.log");
if (!log) fail("linux-dist-build.log is not in the manifest");
console.log(`manifest (${manifestNames.length}): ${manifestNames.join(", ")}`);
console.log(`disk     (${actualNames.length}): equal to manifest`);
console.log(`git      (${trackedNames.length}): equal to manifest (plus ${SELF}, self-excluded)`);
console.log(`digests  : ${manifest.length}/${manifest.length} OK (sha256sum over the delivered bytes)`);
console.log(`delivered: linux-dist-build.log bytes=${log.bytes} sha256=${log.digest} tracked=true`);
console.log("OK: manifest == disk == git, self-excluding SHA256SUMS.txt");
