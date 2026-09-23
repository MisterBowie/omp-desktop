/**
 * Shared, cross-platform helpers for the real-runtime E2E fixtures (session,
 * persistence and subagent): shell argument quoting and process liveness.
 *
 * The runtime's child environment is deliberately closed (see
 * `packages/omp-runtime/src/isolation.ts`): `node` is not on PATH and macOS has
 * no `/proc`. These helpers keep the fixtures honest on both Linux and macOS
 * without depending on a global Node install and without treating an unreadable
 * process table as "gone".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Quote one argument for POSIX sh.
 *
 * Tokens made only of shell-safe characters pass through unchanged; anything
 * else is single-quoted with an embedded single quote escaped as `'\''`.
 */
export function shellQuote(arg) {
  const value = String(arg);
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `process.kill(pid, 0)`: ESRCH means gone, EPERM means alive but foreign. */
function signalAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    if (error && error.code === "EPERM") return true;
    throw error;
  }
}

/**
 * Is this pid a live process (and not a zombie)?
 *
 * On Linux a killed-but-unreaped child stays observable as a zombie (`Z`/`X`)
 * that `kill(pid, 0)` still reports alive, so consult `/proc/<pid>/stat` first
 * when it exists. On platforms without `/proc` the signal check is the only
 * authority; the pid is known-owned, so a missing `/proc` is never read as
 * "gone".
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (existsSync("/proc")) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (state === "Z" || state === "X") return false;
      return true;
    } catch {
      // The entry vanished between the exists check and the read: fall through.
    }
  }
  return signalAlive(pid);
}

/**
 * Is any process command line carrying `marker`?
 *
 * Uses POSIX `ps` with BSD flags `-ax` (valid on both Linux and macOS), so the
 * check has a real answer on every platform. If the process table cannot be
 * read at all, `execFileSync` throws rather than returning false: a missing
 * source of truth fails the assertion loudly instead of passing a cleanup check
 * vacuously.
 */
export function commandLineAlive(marker) {
  const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return output.includes(marker);
}
