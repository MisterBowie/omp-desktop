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
import { randomBytes } from "node:crypto";
import { reapRunResources } from "./lib/runtime-registry.mjs";
import { parseArgs, verdictFor } from "./lib/suite-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DATA_ROOT = join(HERE, "..", "..", "..", ".dev-data", "m1");
const PER_EXPERIMENT_TIMEOUT_MS = Number(process.env.M1_EXPERIMENT_TIMEOUT_MS ?? 300_000);
// Every experiment must stamp its result with this id; a file left over from an
// earlier run cannot satisfy the check.
const RUN_ID = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

const argv = process.argv.slice(2);

/** Parse flags and experiment selectors without positional drift. */
const { selectors: selected, dir: SCAN_DIR, keep } = parseArgs(argv, HERE);

const all = readdirSync(SCAN_DIR)
  .filter((f) => /^e\d+-.*\.mjs$/.test(f))
  .sort();
const targets = selected.length > 0 ? all.filter((f) => selected.some((s) => f.startsWith(s))) : all;

/**
 * Read the result JSON an experiment writes for itself. The run id is part of
 * the check: a file left over from an earlier suite run cannot satisfy it.
 */
function readResult(file, expectedRunId) {
  const expected = file.replace(/\.mjs$/, "");
  const path = join(SCAN_DIR, "results", `${expected}.json`);
  if (!existsSync(path)) return { exists: false, expected, expectedRunId };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { exists: true, expected, expectedRunId, experiment: parsed.experiment, ok: parsed.ok, runId: parsed.runId ?? null };
  } catch (error) {
    return { exists: true, expected, expectedRunId, parseError: String(error.message).slice(0, 80) };
  }
}

/** Run one experiment file, streaming nothing but capturing the tail of output. */
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [file, ...(keep ? ["--keep-artifacts"] : [])];
    // Detached: the experiment starts its own OMP processes, so the timeout
    // path must kill the whole group rather than just this script.
    const child = spawn(process.execPath, args, {
      cwd: SCAN_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, M1_RUN_ID: RUN_ID },
    });
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
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      const headline = out.split("\n").find((l) => /^(PASS|FAIL) /.test(l)) ?? null;
      const result = readResult(file, RUN_ID);
      // Reclaim anything this experiment left behind, including detached
      // runtimes it started (its own `finally` may never have run).
      const reaped = await reapRunResources({
        dataRoot: EXPERIMENT_DATA_ROOT,
        runId: RUN_ID,
        ownerPids: [child.pid],
        // Keep the scratch roots only when the caller asked for artifacts.
        keepArtifacts: keep,
      }).catch((error) => ({ error: String(error?.message ?? error) }));
      const verdict = timedOut
        ? { ok: false, reason: `timed out after ${PER_EXPERIMENT_TIMEOUT_MS} ms` }
        : verdictFor({ exitCode: code, signal, headline, result, expectedRunId: RUN_ID });
      resolve({
        file,
        exitCode: code,
        signal,
        timedOut,
        ms: Date.now() - started,
        headline,
        verdict,
        result,
        reaped,
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
  if (row.reaped && (row.reaped.stillAlive?.length || row.reaped.unattributed?.length || row.reaped.error)) {
    console.log(`    cleanup: ${JSON.stringify(row.reaped)}`);
  }
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
    cleanup: r.reaped ? { clean: r.reaped.clean ?? null, stillAlive: r.reaped.stillAlive ?? [], unattributed: r.reaped.unattributed ?? [] } : null,
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
