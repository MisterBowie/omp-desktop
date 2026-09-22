/**
 * Process-group termination, with the semantics M1 measured.
 *
 * The rules this module exists to enforce:
 *
 *   - **Signalling is not reaping.** A group leader that exits does not mean the
 *     group is empty: a descendant that ignores SIGTERM keeps running after its
 *     parent is gone, so termination is decided by *group* liveness, never by
 *     the direct child's exit.
 *   - **Escalate, then verify.** SIGTERM, wait, SIGKILL, wait again; the result
 *     says whether anything remains.
 *   - **Only ever signal a group we started.** Every call takes the group id
 *     that `spawn(..., { detached: true })` produced from this child, so a
 *     recycled pid can never cause an unrelated process to be signalled.
 */
import type { ChildProcess } from "node:child_process";

export type ProcessGroupLiveness = "alive" | "empty" | "unknown";

/** Is any process still in this group? */
export function processGroupLiveness(pgid: number): ProcessGroupLiveness {
  if (!Number.isInteger(pgid) || pgid <= 0) return "unknown";
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means it exists but is not ours to signal: still occupied.
    if (code === "EPERM") return "alive";
    if (code === "ESRCH") return "empty";
    return "unknown";
  }
}

/** Send a signal to the group, falling back to the leader alone. */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
    return;
  } catch {
    /* fall through to the leader */
  }
  try {
    process.kill(pgid, signal);
  } catch {
    /* already gone */
  }
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function waitForGroupEmpty(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processGroupLiveness(pgid) === "empty") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export type TerminateTreeResult = {
  /** No process from this group remains (or the group was already empty). */
  reaped: boolean;
  /** Highest escalation that was used. */
  escalated: "none" | "term" | "kill";
  steps: string[];
};

/** True while this exact pid exists (any process, not only a group leader). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Terminate one process that is not a group leader.
 *
 * A caller's pid may come from a tool event rather than from its own spawn, so
 * it cannot be assumed to head a group. Signalling `-pid` for a member pid hits
 * nothing and would report success while the process keeps running, which is
 * exactly the silent-orphan failure this module exists to prevent.
 */
async function terminateSingleProcess(
  pid: number,
  graceMs: number,
  killGraceMs: number,
): Promise<TerminateTreeResult> {
  const steps = ["not a process group; terminating the process alone"];
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { reaped: true, escalated: "none", steps: [...steps, "already gone"] };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return { reaped: true, escalated: "term", steps: [...steps, "exited after SIGTERM"] };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* raced with exit */
  }
  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (!processAlive(pid)) return { reaped: true, escalated: "kill", steps: [...steps, "exited after SIGKILL"] };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { reaped: false, escalated: "kill", steps: [...steps, "still alive after SIGKILL"] };
}

export type TerminateTreeOptions = {
  /** Time to wait after SIGTERM before escalating, per stage. */
  graceMs?: number;
  /** Wait for the group after SIGKILL. */
  killGraceMs?: number;
};

/**
 * Terminate one process group: TERM, wait, KILL, wait.
 *
 * `child` may be `null` when only the group id is known (a descendant tree the
 * runtime detached); the group check then decides on its own.
 */
export async function terminateProcessTree(
  child: ChildProcess | null,
  pgid: number,
  options: TerminateTreeOptions = {},
): Promise<TerminateTreeResult> {
  const graceMs = options.graceMs ?? 3_000;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const steps: string[] = [];

  if (processGroupLiveness(pgid) === "empty") {
    if (processAlive(pgid)) return terminateSingleProcess(pgid, graceMs, killGraceMs);
    steps.push("group already empty");
    return { reaped: true, escalated: "none", steps };
  }

  signalProcessGroup(pgid, "SIGTERM");
  steps.push("sent SIGTERM to group");
  if (child) await waitForExit(child, graceMs);
  if (await waitForGroupEmpty(pgid, graceMs)) {
    steps.push("group empty after SIGTERM");
    return { reaped: true, escalated: "term", steps };
  }

  // The leader's exit is not the group's exit: keep escalating while anything
  // in the group survives. This is what reclaims a command that ignores TERM.
  signalProcessGroup(pgid, "SIGKILL");
  steps.push("sent SIGKILL to group");
  const reaped = await waitForGroupEmpty(pgid, killGraceMs);
  steps.push(reaped ? "group empty after SIGKILL" : "group still populated after SIGKILL");
  return { reaped, escalated: "kill", steps };
}
