/**
 * Process ownership and safe signaling for the Linux UI acceptance harnesses.
 *
 * A harness that restarts the real application must reclaim exactly the
 * processes it started and must never signal anything else. Ownership here
 * rests only on evidence that is unique to *this* run:
 *
 *   - the process is a recorded spawn root or a ppid descendant of one, and
 *     still carries the start time it had when it was recorded (a recycled pid
 *     is a different process);
 *   - or the process carries the run's unique scratch root in one argv element
 *     or one environment value, which is how a detached OMP runtime that
 *     survived reparenting stays attributable to the run.
 *
 * A shared source or build path (the patched OMP tree, the checkout) is
 * deliberately *not* an ownership signal: the harness's own launcher, a
 * concurrent task that merely references the same tree, and every ancestor of
 * the harness must never be collected or signaled. Identity is matched on path
 * element boundaries, not as a substring, so `/tmp/run-2` never matches
 * `/tmp/run`.
 *
 * Signal plans obey the same rule on the process-group level: a group is
 * signaled as a group only when every live member of it is owned; when owned
 * and unrelated processes share a group (or the group is our own or an
 * ancestor's), only the owned members are signaled, individually.
 */
import { readdirSync, readFileSync } from "node:fs";

import { isSignalableProcessGroup } from "../omp-patch.mjs";

const DEFAULT_PROC_ROOT = "/proc";
/** Environment blocks larger than this are matched on their first slice only. */
const MAX_ENVIRON_BYTES = 256 * 1024;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The stable identity fields of one process (`/proc/<pid>/stat`). */
function readStatIdentity(pid, procRoot) {
  let statText;
  try {
    statText = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const open = statText.indexOf("(");
  const close = statText.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  return {
    pid,
    comm: statText.slice(open + 1, close),
    state: fields[0] ?? "",
    ppid: Number(fields[1] ?? 0),
    pgid: Number(fields[2] ?? 0),
    starttime: fields[19] ?? "",
  };
}

function readArgv(pid, procRoot) {
  try {
    return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    // Kernel threads and exited races have no readable command line.
    return [];
  }
}

/** The identity of a single pid (`/proc/<pid>/stat` only), or `null`. */
export function readProcessIdentity(pid, procRoot = DEFAULT_PROC_ROOT) {
  if (process.platform !== "linux") return null;
  return readStatIdentity(pid, procRoot);
}

/** One `/proc` snapshot: identity, argv and a lazily read environment. */
export function readProcessTable(procRoot = DEFAULT_PROC_ROOT) {
  const entries = new Map();
  if (process.platform !== "linux") return entries;
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const identity = readStatIdentity(pid, procRoot);
    if (!identity) continue;
    const argv = readArgv(pid, procRoot);
    entries.set(pid, {
      ...identity,
      argv,
      cmdline: argv.join(" "),
      environ: undefined,
    });
  }
  return entries;
}

/**
 * The environment of `entry` as `KEY=VALUE` strings, read once per entry.
 * `null` means the process is gone or its environment is unreadable (another
 * user, a kernel thread); callers treat that as "no evidence".
 */
export function processEnvironment(entry, procRoot = DEFAULT_PROC_ROOT) {
  if (Array.isArray(entry.environ)) return entry.environ;
  if (entry.environ === null) return null;
  let text;
  try {
    text = readFileSync(`${procRoot}/${entry.pid}/environ`, "utf8").slice(0, MAX_ENVIRON_BYTES);
  } catch {
    entry.environ = null;
    return null;
  }
  entry.environ = text.split("\0").filter(Boolean);
  return entry.environ;
}

/** True when `candidate` is `root` itself or sits below it. */
export function pathBoundaryMatches(candidate, roots) {
  if (typeof candidate !== "string") return false;
  for (const root of roots ?? []) {
    if (typeof root !== "string") continue;
    const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
    // `/` or an empty root would match everything and is never an identity.
    if (normalized.length < 2) continue;
    if (candidate === normalized || candidate.startsWith(`${normalized}/`)) return true;
  }
  return false;
}

/** True when an argv element names the run's own tree (`--key=<path>` too). */
export function argvIdentifiesRun(argv, roots) {
  for (const arg of argv ?? []) {
    if (pathBoundaryMatches(arg, roots)) return true;
    const equals = typeof arg === "string" ? arg.indexOf("=") : -1;
    if (equals > 0 && pathBoundaryMatches(arg.slice(equals + 1), roots)) return true;
  }
  return false;
}

/** True when an environment value names the run's own tree. */
export function environmentIdentifiesRun(environ, roots) {
  for (const pair of environ ?? []) {
    const equals = typeof pair === "string" ? pair.indexOf("=") : -1;
    if (equals <= 0) continue;
    if (pathBoundaryMatches(pair.slice(equals + 1), roots)) return true;
  }
  return false;
}

/** Every live ancestor of `pid`, nearest first. */
export function ancestorPids(table, pid) {
  const ancestors = [];
  const visited = new Set([pid]);
  let current = table.get(pid)?.ppid ?? 0;
  while (current > 1 && !visited.has(current)) {
    const entry = table.get(current);
    if (!entry) break;
    visited.add(current);
    ancestors.push(current);
    current = entry.ppid;
  }
  return ancestors;
}

/** True while the pid still exists with the recorded identity (start time). */
export function sameProcess(entry, procRoot = DEFAULT_PROC_ROOT) {
  if (process.platform !== "linux") return false;
  const current = readStatIdentity(entry.pid, procRoot);
  return current !== null && String(current.starttime) === String(entry.starttime);
}

/**
 * The processes this run owns, per the rules in the module header.
 *
 * `roots` are spawn records (`{ pid, starttime }`); a root whose pid vanished
 * or whose start time changed contributes nothing. `runRoots` are the run's
 * unique scratch paths; they are the only path identity accepted. The harness
 * itself and all of its ancestors are always excluded.
 */
export function collectOwnedProcesses({ table, selfPid, roots = [], runRoots = [] }) {
  if (!(table instanceof Map) || table.size === 0) {
    return { supported: false, processes: [], protectedAncestors: [], ignored: [] };
  }
  const protectedPids = new Set([selfPid, ...ancestorPids(table, selfPid)]);
  const childrenOf = new Map();
  for (const entry of table.values()) {
    const list = childrenOf.get(entry.ppid) ?? [];
    list.push(entry.pid);
    childrenOf.set(entry.ppid, list);
  }
  const owned = new Map();
  const ignored = [];
  const acceptedRoots = new Set();
  for (const root of roots) {
    if (!root || typeof root.pid !== "number" || root.pid <= 1) continue;
    const entry = table.get(root.pid);
    if (!entry) {
      ignored.push({ pid: root.pid, reason: "root-gone" });
      continue;
    }
    if (root.starttime != null && String(root.starttime) !== String(entry.starttime)) {
      ignored.push({
        pid: root.pid,
        reason: "root-reused",
        starttime: entry.starttime,
        recordedStarttime: String(root.starttime),
      });
      continue;
    }
    acceptedRoots.add(root.pid);
  }
  const queue = [...acceptedRoots];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (owned.has(pid)) continue;
    const entry = table.get(pid);
    if (!entry) continue;
    if (protectedPids.has(pid)) {
      ignored.push({ pid, comm: entry.comm, reason: "ancestor" });
      continue;
    }
    owned.set(pid, { ...entry, ownership: acceptedRoots.has(pid) ? "root" : "descendant" });
    for (const childPid of childrenOf.get(pid) ?? []) queue.push(childPid);
  }
  if (runRoots.length > 0) {
    for (const entry of table.values()) {
      if (owned.has(entry.pid) || entry.pid <= 1) continue;
      const byArgv = argvIdentifiesRun(entry.argv, runRoots);
      const byEnvironment = byArgv ? false : environmentIdentifiesRun(processEnvironment(entry), runRoots);
      if (!byArgv && !byEnvironment) continue;
      if (protectedPids.has(entry.pid)) {
        // The launcher above us may pass the run root through; it is still us.
        ignored.push({ pid: entry.pid, comm: entry.comm, reason: "ancestor-run-root" });
        continue;
      }
      owned.set(entry.pid, {
        ...entry,
        ownership: byArgv ? "argv-run-root" : "environ-run-root",
      });
    }
  }
  return {
    supported: true,
    processes: [...owned.values()].sort((a, b) => a.pid - b.pid),
    protectedAncestors: ancestorPids(table, selfPid)
      .map((pid) => table.get(pid))
      .filter(Boolean),
    ignored,
  };
}

/**
 * Decide how to signal `owned` against a fresh table.
 *
 * Only processes that still exist with their recorded start time are targets;
 * everything else is reported as `stale`. A process group is a group target
 * only when every live member is an owned live target and the group is neither
 * ours, nor an ancestor's, nor explicitly excluded: a mixed group is signaled
 * member by member so an unrelated process in it is never hit.
 *
 * `onlyGroups` narrows a stage to the given process groups (the first stage of
 * a restart tears down the Electron group and leaves detached survivors to the
 * escalation). The purity test always uses the full `owned` set, so narrowing
 * cannot promote a mixed group to a group signal.
 */
export function planSignalTargets({
  table,
  owned = [],
  selfPid,
  excludedPids = [],
  excludedGroups = [],
  onlyGroups = null,
}) {
  if (!(table instanceof Map) || table.size === 0) {
    return { groups: [], pids: [], mixedGroups: [], protectedTargets: [], stale: [] };
  }
  const selfEntry = table.get(selfPid);
  const selfGroup = selfEntry ? selfEntry.pgid : null;
  const ancestors = ancestorPids(table, selfPid);
  const ancestorGroups = new Set(ancestors.map((pid) => table.get(pid)?.pgid).filter((pgid) => typeof pgid === "number"));
  const protectedPids = new Set([selfPid, ...ancestors, ...excludedPids]);
  const excluded = new Set(excludedGroups);
  const live = [];
  const protectedTargets = [];
  const stale = [];
  for (const entry of owned) {
    const current = table.get(entry.pid);
    if (!current || String(current.starttime) !== String(entry.starttime)) {
      stale.push({
        pid: entry.pid,
        comm: entry.comm ?? null,
        reason: current ? "pid-reused" : "gone",
        starttime: current ? current.starttime : null,
        recordedStarttime: String(entry.starttime ?? ""),
      });
      continue;
    }
    if (protectedPids.has(current.pid)) {
      protectedTargets.push({ pid: current.pid, comm: current.comm, reason: "self-or-ancestor" });
      continue;
    }
    live.push(current);
  }
  const ownedPids = new Set(live.map((entry) => entry.pid));
  const liveByGroup = new Map();
  for (const entry of table.values()) {
    const list = liveByGroup.get(entry.pgid) ?? [];
    list.push(entry);
    liveByGroup.set(entry.pgid, list);
  }
  const ownedByGroup = new Map();
  for (const entry of live) {
    const list = ownedByGroup.get(entry.pgid) ?? [];
    list.push(entry);
    ownedByGroup.set(entry.pgid, list);
  }
  const groups = [];
  const pids = [];
  const mixedGroups = [];
  // `onlyGroups` restricts which groups this stage targets; the purity of a
  // targeted group is still judged against the whole owned set, so narrowing a
  // stage can never turn a mixed group into a group-wide signal.
  const restricted = onlyGroups ? new Set(onlyGroups) : null;
  for (const [pgid, members] of ownedByGroup) {
    if (restricted && !restricted.has(pgid)) continue;
    const fallback = () => {
      for (const member of members) pids.push(member.pid);
    };
    if (excluded.has(pgid)) {
      protectedTargets.push({ pgid, reason: "excluded-group" });
      fallback();
      continue;
    }
    if (selfGroup !== null && pgid === selfGroup) {
      protectedTargets.push({ pgid, reason: "own-group" });
      fallback();
      continue;
    }
    if (ancestorGroups.has(pgid)) {
      protectedTargets.push({ pgid, reason: "ancestor-group" });
      fallback();
      continue;
    }
    if (!isSignalableProcessGroup(pgid)) {
      fallback();
      continue;
    }
    const foreign = (liveByGroup.get(pgid) ?? []).filter((entry) => !ownedPids.has(entry.pid));
    if (foreign.length === 0) {
      groups.push(pgid);
      continue;
    }
    mixedGroups.push({
      pgid,
      ownedPids: members.map((entry) => entry.pid),
      foreignPids: foreign.map((entry) => entry.pid),
    });
    fallback();
  }
  return {
    groups: groups.sort((a, b) => a - b),
    pids: [...new Set(pids)].sort((a, b) => a - b),
    mixedGroups,
    protectedTargets,
    stale,
  };
}

/** Apply a plan; a vanished target (`ESRCH`) is a no-op, anything else is reported. */
export function signalProcessPlan(plan, signal, { kill = process.kill } = {}) {
  const results = [];
  const send = (target, kind) => {
    try {
      kill(target, signal);
      results.push({ target, kind, signal, ok: true });
    } catch (error) {
      results.push({
        target,
        kind,
        signal,
        ok: false,
        gone: error?.code === "ESRCH",
        code: error?.code ?? null,
        message: errorText(error),
      });
    }
  };
  for (const pgid of plan.groups) send(-pgid, "group");
  for (const pid of plan.pids) send(pid, "pid");
  return results;
}
