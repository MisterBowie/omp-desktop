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

/**
 * Liveness of a whole process group.
 *
 * `process.kill(-pgid, 0)` fails only when the group has no members left, so
 * this stays true after the group leader exits — the case where gating
 * escalation on the leader's liveness leaks surviving descendants (PI-Desktop's
 * npm-executable.ts sends SIGKILL to the remaining group on settle for exactly
 * this reason).
 */
function groupAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Pids whose process group is `pgid`, from /proc (exact, not name-based). */
function groupMembers(pgid) {
  if (!pgid) return [];
  const members = [];
  let names;
  try { names = readdirSync("/proc"); } catch { return members; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[2]) === pgid) members.push(pid);
    } catch { /* raced with exit */ }
  }
  return members;
}

/**
 * Terminate a whole group: SIGTERM, bounded wait, then SIGKILL **regardless of
 * whether the leader is still alive**, then bounded wait. Returns the survivors.
 */
async function terminateGroup(pgid, { graceMs = 400, killWaitMs = 3_000 } = {}) {
  const sleep = (ms) => {
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, ms);
    return promise;
  };
  if (!groupAlive(pgid)) return [];
  signalQuietly(-pgid, "SIGTERM");
  const graceEnd = Date.now() + graceMs;
  while (Date.now() < graceEnd && groupAlive(pgid)) await sleep(50);
  signalQuietly(-pgid, "SIGKILL");
  const killEnd = Date.now() + killWaitMs;
  while (Date.now() < killEnd && groupAlive(pgid)) await sleep(50);
  return groupMembers(pgid);
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
  keepArtifacts = false,
} = {}) {
  const sleep = (ms) => {
    const { promise, resolve: done } = Promise.withResolvers();
    setTimeout(done, ms);
    return promise;
  };
  const entries = listRuntimes(dataRoot, { runId });
  const result = {
    runtimes: entries.length,
    killedProcesses: [],
    removedRoots: [],
    removedRunRoots: [],
    stillAlive: [],
    unattributed: [],
    // Structured, readable failures. `clean` is false whenever anything here is
    // non-empty, so the suite's verdict can depend on the real outcome instead
    // of on a swallowed exception.
    errors: [],
    artifactsKept: keepArtifacts,
    clean: true,
  };

  // 1. Group termination per registered runtime. Escalation is decided by
  //    *group* liveness, so a leader that exited first cannot spare its
  //    remaining descendants.
  for (const entry of entries) {
    const pgid = entry.pgrp ?? entry.pid;
    if (!groupAlive(pgid)) continue;
    const before = groupMembers(pgid);
    const survivors = await terminateGroup(pgid, { graceMs: 400, killWaitMs: timeoutMs });
    // Report every member that was present before the kill: the survivors (if
    // any) are the ones the caller must still worry about.
    result.killedProcesses.push(...before.filter((pid) => !survivors.includes(pid)));
    if (survivors.length > 0) result.stillAlive.push(...survivors);
  }

  // 2. Secondary safety net for processes that left the group (OMP tools may
  //    setsid themselves): attribute them by this run's isolation roots.
  const owned = sweep
    ? sweepOwnedPids({
      agentDirs: entries.map((e) => e.agentDir).filter(Boolean),
      configDirNames: entries.map((e) => e.configDirName).filter(Boolean),
      exclude: [process.pid, ...ownerPids, ...result.stillAlive],
    })
    : [];
  for (const pid of owned) signalQuietly(pid, "SIGTERM");
  if (owned.length > 0) {
    const sleep = (ms) => {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, ms);
      return promise;
    };
    await sleep(150);
    for (const pid of owned) {
      if (alive(pid)) {
        // The process leads its own group when it called setsid; kill both.
        signalQuietly(-pid, "SIGKILL");
        signalQuietly(pid, "SIGKILL");
      }
      result.killedProcesses.push(pid);
    }
    await sleep(150);
    for (const pid of owned) if (alive(pid)) result.stillAlive.push(pid);
  }

  // 3. Cleanup only what this run owns. A registration is dropped only when the
  //    group is gone AND every removal succeeded, so a failed cleanup stays
  //    retryable instead of losing the only ownership evidence we have.
  const removeOwned = (entry, dir, bucket) => {
    if (!dir) return;
    const abs = resolve(dir);
    try {
      rmSync(abs, { recursive: true, force: true });
      bucket.push(abs);
    } catch (error) {
      result.errors.push({ phase: "remove", path: abs, pid: entry.pid, message: String(error?.message ?? error) });
    }
  };

  /** True when `dir` lives inside `parent` (the run roots are never the parent). */
  const insideOf = (dir, parent) => {
    if (!dir || !parent) return false;
    const abs = resolve(dir);
    const base = resolve(parent);
    return abs !== base && abs.startsWith(`${base}/`);
  };

  for (const entry of entries) {
    const pgid = entry.pgrp ?? entry.pid;
    if (groupAlive(pgid)) {
      result.unattributed.push({ pid: entry.pid, pgid, reason: "group still alive after SIGKILL" });
      result.clean = false;
      continue;
    }
    const errorsBefore = result.errors.length;
    for (const dir of [entry.configRoot, entry.home]) {
      if (insideOf(dir, entry.runRoot)) removeOwned(entry, dir, result.removedRoots);
    }
    // The run root itself is guarded by the experiment data root, not by itself.
    if (!keepArtifacts && insideOf(entry.runRoot, dataRoot)) removeOwned(entry, entry.runRoot, result.removedRunRoots);
    // Keep the registration when this entry's cleanup failed.
    if (result.errors.length === errorsBefore) unregisterRuntime(dataRoot, entry.pid);
  }
  if (result.stillAlive.length > 0) result.clean = false;
  if (result.errors.length > 0) result.clean = false;
  return result;
}
