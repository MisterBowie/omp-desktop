#!/usr/bin/env node
/**
 * T20-A acceptance-matrix lint: every id in the T20-B/C/D matrix of
 * `docs/validation/M5-plan-goal-capability-gates.md` must appear exactly once,
 * and the expected ranges must be complete (B1-B14, C1-C8, D1-D3).
 *
 * The matrix is the contract T20-B/C/D is reviewed against; a duplicated row
 * (or a silently dropped one) makes the review reference ambiguous. This is a
 * documentation lint, not a behavior test: it never asserts product behavior
 * and it is not part of the default `node --test` suite.
 *
 * Usage: node scripts/check-t20-matrix-ids.mjs   -> exit 0 when unique+complete
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(appRoot, "..", "docs", "validation", "M5-plan-goal-capability-gates.md");
const source = readFileSync(docPath, "utf8");

const sections = {
  B: { heading: "### T20-B", count: 14 },
  C: { heading: "### T20-C", count: 8 },
  D: { heading: "### T20-D", count: 3 },
};

const problems = [];
for (const [prefix, { heading, count }] of Object.entries(sections)) {
  const start = source.indexOf(heading);
  if (start < 0) {
    problems.push(`${prefix}: section heading "${heading}" not found`);
    continue;
  }
  const nextHeading = source.indexOf("\n### ", start + heading.length);
  const body = source.slice(start, nextHeading < 0 ? undefined : nextHeading);
  const seen = new Map();
  for (const match of body.matchAll(new RegExp(`\\|\\s*\\*{0,2}(${prefix}\\d+)\\*{0,2}\\s*\\|`, "g"))) {
    seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
  }
  for (let index = 1; index <= count; index += 1) {
    const id = `${prefix}${index}`;
    const times = seen.get(id) ?? 0;
    if (times !== 1) problems.push(`${id}: expected exactly 1 row, found ${times}`);
  }
  for (const [id, times] of seen) {
    const index = Number(id.slice(1));
    if (index < 1 || index > count) problems.push(`${id}: unexpected id (range is ${prefix}1-${prefix}${count})`);
    else if (times !== 1) problems.push(`${id}: expected exactly 1 row, found ${times}`);
  }
}

const uniqueProblems = [...new Set(problems)];
if (uniqueProblems.length > 0) {
  for (const problem of uniqueProblems) console.log(`MATRIX-ID-FAIL ${problem}`);
  console.log(`SUMMARY: ${uniqueProblems.length} problem(s)`);
  process.exit(1);
}
console.log("MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once");
