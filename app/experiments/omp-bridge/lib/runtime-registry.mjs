/**
 * Runtime registry + bounded reaper for the M1 experiment suite.
 *
 * Why this exists: each experiment starts its own OMP runtime with
 * `detached: true`, so the runtime lives in its own process group. When the
 * suite's timeout kills a stuck experiment, that experiment's `finally` never
 * runs, and its runtime children and isolated directories would be left behind.
 * Killing the experiment's process group cannot reach a detached runtime.
 *
 * Attribution is exact and never name-based: every process this suite starts
 * inherits the run's unique isolation roots (`PI_CONFIG_DIR`,
 * `PI_CODING_AGENT_DIR`), so a process belongs to this run iff its environment
 * references one of those roots. That is what the sweep matches — a user's own
 * OMP (with its own `~/.omp`) can never match.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REGISTRY_DIR_NAME = ".runtimes";

/** Where the registry lives for a given experiment data root. */
function registryDir(dataRoot) {
  return join(dataRoot, REGISTRY_DIR_NAME);
}

function entryPath(dataRoot, pid) {
  return join(registryDir(dataRoot), `${pid}.json`);
}

/** Record a runtime this run started. Best-effort: never breaks the caller. */
export function registerRuntime(dataRoot, entry) {
  try {
    mkdirSync(registryDir(dataRoot), { recursive: true });
    writeFileSync(
      entryPath(dataRoot, entry.pid),
      `${JSON.stringify({ ...entry, registeredAt: Date.now() })}\n`,
    );
  } catch { /* registry is a safety net */ }
}

/** Forget a runtime that stopped cleanly. */
export function unregisterRuntime(dataRoot, pid) {
  try {
    rmSync(entryPath(dataRoot, pid), { force: true });
  } catch { /* already gone */ }
}

/** All registry entries for a run id (or every entry when omitted). */
export function listRuntimes(dataRoot, { runId } = {}) {
  const dir = registryDir(dataRoot);
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!runId || parsed.runId === runId) entries.push(parsed);
    } catch { /* skip corrupt entries */ }
  }
  return entries;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalQuietly(pid, signal) {
  try { process.kill(pid, signal); } catch { /* gone */ }
}

/**
 * Processes whose environment references this run's isolation roots.
 * That is the run's own footprint, including tools the runtime spawned into
 * their own sessions (which a process-group kill cannot reach).
 */
export function sweepOwnedPids({ agentDirs = [], configDirNames = [], exclude = [] } = {}) {
  const wanted = [...agentDirs.map((d) => `PI_CODING_AGENT_DIR=${d}`), ...configDirNames.map((c) => `PI_CONFIG_DIR=${c}`)];
  if (wanted.length === 0) return [];
  const excluded = new Set(exclude);
  const found = [];
  let names;
  try { names = readdirSync("/proc"); } catch { return []; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (excluded.has(pid)) continue;
    let environ;
    try { environ = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { continue; }
    const parts = environ.split("\0");
    if (wanted.some((w) => parts.includes(w))) found.push(pid);
  }
  return found;
}

/**
 * Reclaim everything this run owns: registered runtime groups, any process
 * whose environment references the run's isolation roots, and the isolated
 * directories. Bounded: SIGTERM, then SIGKILL, then give up and report.
 */
export async function reapRunResources({
  dataRoot,
  runId,
  ownerPids = [],
  timeoutMs = 2_000,
  sweep = true,
} = {}) {
  const sleep = (ms) => {
    const { promise, resolve: done } = Promise.withResolvers();
    setTimeout(done, ms);
    return promise;
  };
  const entries = listRuntimes(dataRoot, { runId });
  const result = { runtimes: entries.length, killedProcesses: [], removedRoots: [], stillAlive: [] };

  // 1. Bounded termination of every registered runtime group (and the pid).
  for (const entry of entries) {
    if (!entry.pid) continue;
    if (alive(entry.pid) || alive(entry.pgrp)) {
      if (entry.pgrp) signalQuietly(-entry.pgrp, "SIGTERM");
      signalQuietly(entry.pid, "SIGTERM");
    }
  }
  await sleep(150);
  for (const entry of entries) {
    if (alive(entry.pid)) {
      if (entry.pgrp) signalQuietly(-entry.pgrp, "SIGKILL");
      signalQuietly(entry.pid, "SIGKILL");
    }
  }

  // 2. Environment-attributed sweep for this run's leftover processes,
  //    including tools the runtime detached into their own sessions.
  const owned = sweep
    ? sweepOwnedPids({
      agentDirs: entries.map((e) => e.agentDir).filter(Boolean),
      configDirNames: entries.map((e) => e.configDirName).filter(Boolean),
      exclude: [process.pid, ...ownerPids],
    })
    : [];
  for (const pid of owned) {
    signalQuietly(pid, "SIGTERM");
  }
  await sleep(150);
  for (const pid of owned) {
    if (alive(pid)) signalQuietly(pid, "SIGKILL");
    result.killedProcesses.push(pid);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stragglers = [...entries.map((e) => e.pid), ...owned].filter(alive);
    if (stragglers.length === 0 || Date.now() > deadline) {
      result.stillAlive = stragglers;
      break;
    }
    await sleep(100);
  }

  // 3. Isolated directories: only paths inside the run root are removed.
  for (const entry of entries) {
    for (const dir of [entry.configRoot, entry.home]) {
      if (!dir) continue;
      const abs = resolve(dir);
      if (!abs.includes(`${resolve(entry.runRoot ?? "")}/`)) continue;
      rmSync(abs, { recursive: true, force: true });
      result.removedRoots.push(abs);
    }
    unregisterRuntime(dataRoot, entry.pid);
  }
  return result;
}
