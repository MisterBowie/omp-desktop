#!/usr/bin/env node
/**
 * Run every M1 bridge experiment in order and summarise the result.
 *
 *   node run-all.mjs                       # all experiments
 *   node run-all.mjs e04 e05               # a subset
 *   node run-all.mjs --keep-artifacts      # keep scratch dirs for inspection
 *
 * Each experiment is a separate process with its own isolated config/agent
 * roots; no paid model is contacted (every run uses a local fake provider).
 * Exits non-zero when any experiment fails, so it is safe to use as a gate.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const PER_EXPERIMENT_TIMEOUT_MS = 300_000;

const argv = process.argv.slice(2);
const keep = argv.includes("--keep-artifacts");
const selected = argv.filter((a) => !a.startsWith("--"));

const all = readdirSync(HERE)
  .filter((f) => /^e\d+-.*\.mjs$/.test(f))
  .sort();
const targets = selected.length > 0 ? all.filter((f) => selected.some((s) => f.startsWith(s))) : all;

/** Run one experiment file, streaming nothing but capturing the tail of output. */
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [file, ...(keep ? ["--keep-artifacts"] : [])];
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), PER_EXPERIMENT_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const headline = out.split("\n").find((l) => /^(PASS|FAIL) /.test(l)) ?? null;
      resolve({
        file,
        exitCode: code,
        signal,
        ms: Date.now() - started,
        headline,
        cleanups: out.split("\n").filter((l) => l.startsWith("  limit: ")).map((l) => l.replace(/^  limit: /, "")),
        stderrTail: err ? err.trim().split("\n").slice(-3).join("\n") : null,
      });
    });
  });
}

const rows = [];
for (const file of targets) {
  process.stdout.write(`running ${file} ... `);
  const row = await run(file);
  rows.push(row);
  console.log(row.headline ?? `NO RESULT (exit ${row.exitCode}${row.signal ? `, ${row.signal}` : ""})`);
  if (!row.headline && row.stderrTail) console.log(`    ${row.stderrTail.replace(/\n/g, "\n    ")}`);
}

const summary = {
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  keepArtifacts: keep,
  experiments: rows.map((r) => ({
    file: r.file,
    passed: /^PASS/.test(r.headline ?? ""),
    headline: r.headline,
    exitCode: r.exitCode,
    seconds: Number((r.ms / 1000).toFixed(1)),
    limitations: r.cleanups,
  })),
};
if (!existsSync(RESULTS)) throw new Error(`missing results dir: ${RESULTS}`);
writeFileSync(join(RESULTS, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

const passed = rows.filter((r) => /^PASS/.test(r.headline ?? "")).length;
const totals = rows.map((r) => {
  const m = /: (\d+)\/(\d+) checks/.exec(r.headline ?? "");
  return m ? { ok: Number(m[1]), total: Number(m[2]) } : { ok: 0, total: 0 };
});
const checks = totals.reduce((acc, t) => ({ ok: acc.ok + t.ok, total: acc.total + t.total }), { ok: 0, total: 0 });

console.log("");
console.log(`experiments: ${passed}/${rows.length} passed | checks: ${checks.ok}/${checks.total}`);
console.log(`total time: ${(rows.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s`);
console.log(`summary: ${join(RESULTS, "summary.json")}`);

process.exit(passed === rows.length ? 0 : 1);
