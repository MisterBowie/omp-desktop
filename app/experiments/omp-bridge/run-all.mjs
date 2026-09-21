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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PER_EXPERIMENT_TIMEOUT_MS = Number(process.env.M1_EXPERIMENT_TIMEOUT_MS ?? 300_000);

const argv = process.argv.slice(2);
const keep = argv.includes("--keep-artifacts");
const dirFlag = argv.indexOf("--dir");
const SCAN_DIR = dirFlag >= 0 && argv[dirFlag + 1] ? resolve(argv[dirFlag + 1]) : HERE;
const selected = argv.filter((a, i) => !a.startsWith("--") && i !== dirFlag + 1);

const all = readdirSync(SCAN_DIR)
  .filter((f) => /^e\d+-.*\.mjs$/.test(f))
  .sort();
const targets = selected.length > 0 ? all.filter((f) => selected.some((s) => f.startsWith(s))) : all;

/**
 * Decide whether one experiment really passed.
 *
 * A `PASS` line alone is not enough: the process must exit 0, must not have
 * been killed by a signal, and its recorded result file must exist, parse, name
 * the same experiment and itself report `ok: true`. This is what catches an
 * experiment that prints PASS and then dies (or whose assertions were never
 * written to disk).
 */
export function verdictFor({ exitCode, signal, headline, result }) {
  if (signal) return { ok: false, reason: `killed by signal ${signal}` };
  if (exitCode !== 0) return { ok: false, reason: `exit code ${exitCode}` };
  if (!headline) return { ok: false, reason: "no PASS/FAIL line" };
  if (!/^PASS /.test(headline)) return { ok: false, reason: "reported FAIL" };
  if (!result.exists) return { ok: false, reason: "no result file" };
  if (result.parseError) return { ok: false, reason: `result file unreadable: ${result.parseError}` };
  if (result.experiment !== result.expected) return { ok: false, reason: `result file names "${result.experiment}"` };
  if (result.ok !== true) return { ok: false, reason: "result file reports failure" };
  return { ok: true, reason: "exit 0, no signal, PASS, matching valid result" };
}

/** Read the result JSON an experiment writes for itself. */
function readResult(file) {
  const expected = file.replace(/\.mjs$/, "");
  const path = join(SCAN_DIR, "results", `${expected}.json`);
  if (!existsSync(path)) return { exists: false, expected };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { exists: true, expected, experiment: parsed.experiment, ok: parsed.ok };
  } catch (error) {
    return { exists: true, expected, parseError: String(error.message).slice(0, 80) };
  }
}

/** Run one experiment file, streaming nothing but capturing the tail of output. */
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [file, ...(keep ? ["--keep-artifacts"] : [])];
    // Detached: the experiment starts its own OMP processes, so the timeout
    // path must kill the whole group rather than just this script.
    const child = spawn(process.execPath, args, { cwd: SCAN_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    }, PER_EXPERIMENT_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const headline = out.split("\n").find((l) => /^(PASS|FAIL) /.test(l)) ?? null;
      const result = readResult(file);
      const verdict = timedOut
        ? { ok: false, reason: `timed out after ${PER_EXPERIMENT_TIMEOUT_MS} ms` }
        : verdictFor({ exitCode: code, signal, headline, result });
      resolve({
        file,
        exitCode: code,
        signal,
        timedOut,
        ms: Date.now() - started,
        headline,
        verdict,
        result,
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
  console.log(row.verdict.ok ? (row.headline ?? "PASS") : `REJECTED (${row.verdict.reason})${row.headline ? ` — reported: ${row.headline}` : ""}`);
  if (!row.verdict.ok && row.stderrTail) console.log(`    ${row.stderrTail.replace(/\n/g, "\n    ")}`);
}

const summary = {
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  keepArtifacts: keep,
  experiments: rows.map((r) => ({
    file: r.file,
    // Verification scope: exit code, signal, headline and result file must all
    // agree, not just the printed headline.
    passed: r.verdict.ok,
    verdict: r.verdict.reason,
    headline: r.headline,
    exitCode: r.exitCode,
    signal: r.signal ?? null,
    timedOut: r.timedOut,
    resultFile: { exists: Boolean(r.result?.exists), experiment: r.result?.experiment ?? null, ok: r.result?.ok ?? null },
    seconds: Number((r.ms / 1000).toFixed(1)),
    limitations: r.cleanups,
  })),
};
const RESULTS = join(SCAN_DIR, "results");
if (!existsSync(RESULTS)) throw new Error(`missing results dir: ${RESULTS}`);
writeFileSync(join(RESULTS, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

const passed = rows.filter((r) => r.verdict.ok).length;
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
