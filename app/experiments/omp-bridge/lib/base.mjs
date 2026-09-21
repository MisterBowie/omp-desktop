/**
 * Shared base for the M1 omp-bridge experiments.
 *
 * Reuses the M0-verified pieces instead of re-implementing them:
 *   - the pinned source launcher (repo path, never the global `omp` link),
 *   - the isolated OMP environment (`PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` /
 *     `OMP_DEV_LAUNCH_DIR`, run-unique, with `OMP_PROFILE`/`PI_PROFILE`/XDG and
 *     credentials stripped),
 *   - the bounded process-group reaper.
 *
 * Only additions for M1 live here: experiment scaffolding and evidence helpers.
 */
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// M0-verified helpers (single source of truth for isolation + reaping).
// These live in the workspace root repo (`docs/validation/`), alongside the
// pinned `upstream/` submodules this experiment suite also depends on.
import {
  resolveRepoRoot,
  findPinnedLauncher,
  verifyPinnedSource,
  buildIsolatedEnv,
  makeConfigDirName,
  prepareRunRoot,
  terminateTree,
} from "../../../../docs/validation/M0-rpc/verify-rpc.mjs";

export {
  resolveRepoRoot,
  findPinnedLauncher,
  verifyPinnedSource,
  buildIsolatedEnv,
  makeConfigDirName,
  prepareRunRoot,
  terminateTree,
};

export const EXPERIMENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where experiment scratch state lives (gitignored, per-worktree). */
export function experimentDataRoot(repoRoot = resolveRepoRoot()) {
  return join(repoRoot, ".dev-data", "m1");
}

/** Remove a config root only when it is one of our own isolated roots. */
export function safeRmConfigRoot(configRoot) {
  if (!configRoot) return;
  const abs = resolve(configRoot);
  const home = resolve(process.env.HOME ?? homedir());
  if (!basename(abs).startsWith(".omp-m0-")) return;
  if (abs === home || !abs.startsWith(home + sep)) return;
  rmSync(abs, { recursive: true, force: true });
}

/** Create a fresh, run-unique scratch directory for one experiment. */
export function makeScratch(label) {
  const root = experimentDataRoot();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${label}-`));
}

/** Minimal assertion + evidence recorder. Every experiment prints one JSON object. */
export function createEvidence(name) {
  const checks = [];
  const evidence = {
    experiment: name,
    startedAt: new Date().toISOString(),
    checks,
    artifacts: {},
    limitations: [],
  };
  return {
    evidence,
    check(description, condition, detail) {
      const ok = Boolean(condition);
      checks.push({ description, ok, ...(detail === undefined ? {} : { detail }) });
      return ok;
    },
    note(key, value) {
      evidence.artifacts[key] = value;
    },
    limit(text) {
      evidence.limitations.push(text);
    },
    finish() {
      evidence.finishedAt = new Date().toISOString();
      evidence.ok = checks.every((c) => c.ok);
      return evidence;
    },
  };
}

/** Sanitize a protocol frame before it is written into a fixture. */
export function sanitizeFrame(frame) {
  const clone = JSON.parse(JSON.stringify(frame));
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (/key|token|secret|password|authorization|credential/i.test(key)) node[key] = "<redacted>";
      else walk(node[key]);
    }
  };
  walk(clone);
  return clone;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export { existsSync, mkdirSync, mkdtempSync, rmSync, join, resolve, tmpdir, homedir, dirname, basename, randomBytes };
