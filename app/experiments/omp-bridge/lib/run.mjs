/** Experiment runner: uniform evidence capture, artifact paths, and cleanup. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEvidence, EXPERIMENT_ROOT, makeScratch, rmSync } from "./base.mjs";
import { writeModelsConfig } from "./models-config.mjs";

export const RESULTS_DIR = join(EXPERIMENT_ROOT, "results");
export const FIXTURES_DIR = join(EXPERIMENT_ROOT, "fixtures");

export function ensureDirs() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
}

/**
 * Run one experiment. `fn(ctx)` records checks/notes/limits; cleanups registered
 * on `ctx` always run (reverse order) before evidence is written.
 */
export async function runExperiment(name, fn) {
  ensureDirs();
  const recorder = createEvidence(name);
  const cleanups = [];
  const ctx = {
    check: recorder.check,
    note: recorder.note,
    limit: recorder.limit,
    /** Fresh scratch dir; removed at the end unless `ctx.keep` is set. */
    scratch(label) {
      const dir = makeScratch(label);
      ctx.cleanups.push(() => { if (!ctx.keep) rmSync(dir, { recursive: true, force: true }); });
      return dir;
    },
    cleanups,
    keep: process.argv.includes("--keep-artifacts"),
  };
  ctx.onCleanup = (fn) => ctx.cleanups.push(fn);

  try {
    await fn(ctx);
  } catch (e) {
    recorder.check("experiment ran without throwing", false, String(e?.stack ?? e));
  } finally {
    for (const cleanup of [...cleanups].reverse()) {
      try { await cleanup(); } catch { /* cleanup must never mask the result */ }
    }
  }

  const evidence = recorder.finish();
  writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n");
  const passed = evidence.checks.filter((c) => c.ok).length;
  console.log(`${evidence.ok ? "PASS" : "FAIL"} ${name}: ${passed}/${evidence.checks.length} checks`);
  for (const c of evidence.checks) {
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.description}${c.detail === undefined ? "" : ` — ${truncate(c.detail)}`}`);
  }
  for (const l of evidence.limitations) console.log(`  limit: ${l}`);
  return evidence;
}

function truncate(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export function writeFixture(name, data) {
  ensureDirs();
  const path = join(FIXTURES_DIR, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  return path;
}

/**
 * Create a run-unique experiment root with `agent/` (models.yml) and `dev-cwd/`,
 * returning the root and the `provider/model` selector.
 */
export function experimentRoot(ctx, label, { baseUrl = "http://127.0.0.1:9", modelId = "local-model", providerId = "m1fake" } = {}) {
  const root = ctx.scratch(label);
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "dev-cwd"), { recursive: true });
  const selector = writeModelsConfig(join(root, "agent"), { baseUrl, providerId, modelId });
  return { root, runRoot: root, selector, agentDir: join(root, "agent"), launchDir: join(root, "dev-cwd") };
}
