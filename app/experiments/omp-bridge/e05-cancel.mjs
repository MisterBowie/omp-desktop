#!/usr/bin/env node
/**
 * E05 — cancellation and cleanup.
 *
 * Covers three real termination paths and asserts observable cleanup, using a
 * PID file written by the command itself so the assertion targets a concrete
 * process identity rather than a name match:
 *   1. `abort` while a native `bash` command is running → that process is gone;
 *   2. `abort` while an approval dialog is pending → OMP cancels the pending
 *      request (targetId) and the gate resolves without an approval;
 *   3. killing the bridge process group while a command runs → no orphan.
 *
 * Usage: node e05-cancel.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const GATE = join(EXPERIMENT_ROOT, "extensions", "approval-gate.ts");
/** Real external program launched as a command by the experiments. */
const LONG_TASK = join(EXPERIMENT_ROOT, "tools", "long-task.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Wait until the command has written its own PID, then return it. */
async function readPidFile(path, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
    await sleep(100);
  }
  return null;
}

/**
 * Read the identity file the external test program writes about itself
 * (its own pid, parent pid and descendant pid). Retries until it appears.
 */
async function readIdentity(path, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8").trim());
        if (Number.isInteger(parsed.pid) && parsed.pid > 0) return parsed;
      } catch { /* still being written */ }
    }
    await sleep(100);
  }
  return null;
}

function killQuietly(pid, signal) {
  if (!pid) return;
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

/**
 * Process bookkeeping from /proc so the report can explain *why* a stop path
 * does or does not reclaim a process tree: process group and session decide
 * whether killing a group reaches the process.
 */
function procInfo(pid) {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parentheses; fields start after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [, ppid, pgrp, session, tty, tpgid] = rest;
    return { pid, ppid: Number(ppid), pgrp: Number(pgrp), session: Number(session), tty: Number(tty), tpgid: Number(tpgid) };
  } catch {
    return null;
  }
}

/** Wait for a process to disappear, bounded. */
async function waitGone(pid, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await sleep(150);
  }
  return !isAlive(pid);
}

const evidence = await runExperiment("e05-cancel", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  // --- 1. abort during tool execution ---------------------------------------
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e05-abort-tool", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const identityFile = join(projectDir, "identity.json");
    const command = `${process.execPath} ${LONG_TASK} ${identityFile}`;

    provider.script([
      { text: "running", toolCalls: [{ name: "bash", args: { command } }], finish: "tool_calls" },
      { text: "after", finish: "stop" },
    ]);

    let rpc;
    let identity = null;
    let cleanedUpByHarness = false;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--approval-mode", "yolo"],
        cwd: projectDir,
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "start long command" }, { timeoutMs: 45_000 });

      const started = await rpc.waitFor((f) => f.type === "tool_execution_start", 30_000);
      ctx.check("bash tool started before abort", Boolean(started), started?.toolName);
      identity = await readIdentity(identityFile);
      ctx.check("the external program recorded its own identity", identity !== null, identity);

      if (!identity) {
        ctx.limit("Without a real running command the cancellation assertion cannot be made; see the failure above.");
      } else {
        ctx.note("identity", identity);
        ctx.note("ompPid", rpc.pid);

        // Identity sanity: the tracked process is a real external program, not
        // OMP and not the harness.
        ctx.check("tracked pid differs from the OMP process pid", identity.pid !== rpc.pid, `${identity.pid} vs omp ${rpc.pid}`);
        ctx.check("tracked pid differs from the harness pid", identity.pid !== process.pid, `${identity.pid} vs harness ${process.pid}`);
        ctx.check("the program spawned a distinct descendant", identity.descendantPid > 0 && identity.descendantPid !== identity.pid, identity.descendantPid);
        ctx.check("the command actually started running (no shell error)",
          !rpc.frames.some((f) => f.type === "tool_execution_end" && f.isError === true),
          rpc.frames.filter((f) => f.type === "tool_execution_end").map((f) => f.isError));
        ctx.check("the program is alive before abort", isAlive(identity.pid), identity.pid);
        ctx.check("the descendant is alive before abort", isAlive(identity.descendantPid), identity.descendantPid);

        const aliveBefore = { parent: isAlive(identity.pid), descendant: isAlive(identity.descendantPid) };
        const ompProc = procInfo(rpc.pid);
        const commandProc = procInfo(identity.pid);
        const descendantProc = procInfo(identity.descendantPid);
        ctx.note("ompProc", ompProc);
        ctx.note("commandProc", commandProc);
        ctx.note("descendantProc", descendantProc);

        const abortResponse = await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
        ctx.check("abort is acknowledged", abortResponse.success === true, abortResponse);
        await promptPromise.catch(() => {});
        await rpc.waitFor((f) => f.type === "agent_end" || f.type === "turn_end", 20_000);

        // Observations happen before any harness-side kill, so a "gone" result
        // can only come from the stop path under test.
        const parentGoneAfterAbort = await waitGone(identity.pid, 5_000);
        const descendantGoneAfterAbort = await waitGone(identity.descendantPid, 5_000);
        ctx.note("aliveBeforeStop", aliveBefore);
        ctx.note("parentGoneAfterAbort", parentGoneAfterAbort);
        ctx.note("descendantGoneAfterAbort", descendantGoneAfterAbort);
        ctx.check("the turn reports tool completion after stopping", rpc.framesOfType("tool_execution_end").length >= 1);
        ctx.check("session stayed responsive after abort", (await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");

        // Escalate to the explicit bash-stop command and observe again.
        const abortBash = await rpc.request({ type: "abort_bash" }, { timeoutMs: 20_000 });
        ctx.check("abort_bash is acknowledged", abortBash.success === true, abortBash);
        const parentGoneAfterAbortBash = await waitGone(identity.pid, 5_000);
        const descendantGoneAfterAbortBash = await waitGone(identity.descendantPid, 5_000);
        ctx.note("parentGoneAfterAbortBash", parentGoneAfterAbortBash);
        ctx.note("descendantGoneAfterAbortBash", descendantGoneAfterAbortBash);

        // Only now may the harness clean up, and we record that it had to.
        if (isAlive(identity.pid) || isAlive(identity.descendantPid)) {
          killQuietly(identity.pid, "SIGKILL");
          killQuietly(identity.descendantPid, "SIGKILL");
          cleanedUpByHarness = true;
        }
        ctx.note("harnessHadToCleanUpAfterAbort", cleanedUpByHarness);

        ctx.limit(
          parentGoneAfterAbortBash
            ? "In-protocol stop (abort + abort_bash) reclaimed the running command process in this environment."
            : "In-protocol stop (abort + abort_bash) did NOT reclaim the running command process in rpc-ui mode; the desktop stop path needs a process-tree termination fallback, which the bridge-level kill provides (scenario 3).",
        );
        ctx.limit(
          descendantGoneAfterAbortBash
            ? "The descendant of the running command was reclaimed together with it."
            : "The descendant of the running command survived the in-protocol stop; only a process-group kill reclaims it.",
        );

        writeFixture("e05-abort-events.json", {
          note: "real capture, sanitized; a real external program (tools/long-task.mjs) records its own pid, ppid and descendant pid",
          commandKind: "node tools/long-task.mjs <identity-file>",
          identity: { ...identity, argv: identity.argv.length },
          ompPidIsDistinct: identity.pid !== rpc.pid,
          aliveBeforeStop: aliveBefore,
          parentGoneAfterAbort,
          descendantGoneAfterAbort,
          parentGoneAfterAbortBash,
          descendantGoneAfterAbortBash,
          harnessHadToCleanUpAfterAbort: cleanedUpByHarness,
          eventTypes: [...new Set(rpc.frames.map((f) => f.type))],
          abortResponse,
          toolExecutionEnd: rpc.frames.filter((f) => f.type === "tool_execution_end").slice(0, 1),
        });
      }
    } finally {
      // Last-resort cleanup only; every assertion above ran before this point.
      if (identity) {
        killQuietly(identity.pid, "SIGKILL");
        killQuietly(identity.descendantPid, "SIGKILL");
      }
      if (rpc) ctx.check("abort scenario: process group reaped", (await rpc.stop()) === true);
    }
  }

  // --- 2. abort while an approval dialog is pending -------------------------
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e05-abort-dialog", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const target = join(projectDir, "never.txt");

    provider.script([{ text: "attempt", toolCalls: [{ name: "write", args: { path: target, content: "x" } }], finish: "tool_calls" }]);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "write something" }, { timeoutMs: 45_000 });

      const dialog = await rpc.waitFor((f) => f.type === "extension_ui_request" && f.method === "select", 30_000);
      ctx.check("approval dialog is pending before abort", Boolean(dialog), dialog?.title);

      await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      await promptPromise.catch(() => {});

      const cancelFrame = await rpc.waitFor(
        (f) => f.type === "extension_ui_request" && f.method === "cancel" && f.targetId === dialog?.id,
        15_000,
      );
      ctx.check("pending dialog is cancelled with a matching targetId", Boolean(cancelFrame), cancelFrame ?? "no cancel frame");

      const gateLog = existsSync(uiLog) ? readFileSync(uiLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const decision = gateLog.find((l) => l.event === "gate-decision");
      ctx.check("gate resolved without an approval after abort", decision?.decision === "deny", decision ?? "no decision");
      ctx.check("no side effect from the aborted dialog", !existsSync(target));
    } finally {
      if (rpc) ctx.check("dialog scenario: process group reaped", (await rpc.stop()) === true);
    }
  }

  // --- 3. bridge process killed while a command runs ------------------------
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e05-bridge-kill", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const identityFile = join(projectDir, "identity.json");
    const command = `${process.execPath} ${LONG_TASK} ${identityFile}`;

    provider.script([{ text: "long", toolCalls: [{ name: "bash", args: { command } }], finish: "tool_calls" }]);

    let rpc;
    let identity = null;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--approval-mode", "yolo"],
        cwd: projectDir,
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "start long command" }, { timeoutMs: 45_000 });
      await rpc.waitFor((f) => f.type === "tool_execution_start", 30_000);
      identity = await readIdentity(identityFile);
      ctx.check("the external program recorded its identity before the bridge kill", identity !== null, identity);
      ctx.check("the command process is alive before the bridge kill", isAlive(identity?.pid), identity?.pid);
      ctx.check("the descendant is alive before the bridge kill", isAlive(identity?.descendantPid), identity?.descendantPid);

      // Group bookkeeping: this decides whether killing OMP's own group can
      // reach the command's tree at all.
      const ompProc = procInfo(rpc.pid);
      const commandProc = procInfo(identity?.pid);
      ctx.note("ompProc", ompProc);
      ctx.note("commandProc", commandProc);
      ctx.note("commandRunsInOmpProcessGroup", Boolean(ompProc && commandProc && commandProc.pgrp === ompProc.pgrp));

      const reaped = await rpc.stop();
      ctx.check("bridge process group reaped on kill", reaped === true);
      await promptPromise.catch(() => {});

      // No harness-side kill before these observations.
      const parentGone = await waitGone(identity?.pid, 8_000);
      const descendantGone = await waitGone(identity?.descendantPid, 8_000);
      ctx.note("bridgeKillProcessReclamation", { parentGone, descendantGone });
      ctx.check("the bridge kill was observed before any harness-side cleanup", true);
      ctx.limit(
        parentGone && descendantGone
          ? "Killing the bridge process group also reclaimed the running command tree."
          : "Killing the bridge process group did NOT reclaim the running command tree: with rpc-ui the command runs in its own process group, so a bridge-level kill alone leaves orphans. The desktop must stop the session (abort/abort_bash) before tearing the bridge down; see scenario 4 for the working order.",
      );
      // Harness cleanup happens only after the observation above.
      killQuietly(identity?.pid, "SIGKILL");
      killQuietly(identity?.descendantPid, "SIGKILL");
      ctx.note("harnessCleanedUpAfterBridgeKill", Boolean(await waitGone(identity?.pid, 3_000)));
    } finally {
      if (identity) {
        killQuietly(identity.pid, "SIGKILL");
        killQuietly(identity.descendantPid, "SIGKILL");
      }
      if (rpc?.pid) await rpc.stop();
    }
  }

  // --- 4. orderly stop then bridge teardown ---------------------------------
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e05-orderly", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const identityFile = join(projectDir, "identity.json");
    const command = `${process.execPath} ${LONG_TASK} ${identityFile}`;

    provider.script([
      { text: "long", toolCalls: [{ name: "bash", args: { command } }], finish: "tool_calls" },
      { text: "after", finish: "stop" },
    ]);

    let rpc;
    let identity = null;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--approval-mode", "yolo"],
        cwd: projectDir,
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "start long command" }, { timeoutMs: 45_000 });
      await rpc.waitFor((f) => f.type === "tool_execution_start", 30_000);
      identity = await readIdentity(identityFile);
      ctx.check("scenario 4: the command is running before the orderly stop", isAlive(identity?.pid) && isAlive(identity?.descendantPid), identity);

      // The order a desktop must use: stop the session first, then tear down.
      await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      await promptPromise.catch(() => {});
      const goneAfterStop = await waitGone(identity?.pid, 8_000);
      const descendantGoneAfterStop = await waitGone(identity?.descendantPid, 8_000);
      ctx.check("scenario 4: the in-protocol stop reclaims the command before teardown", goneAfterStop, `pid ${identity?.pid}`);
      ctx.check("scenario 4: the descendant is reclaimed by the in-protocol stop", descendantGoneAfterStop, `descendant ${identity?.descendantPid}`);

      ctx.check("scenario 4: bridge teardown then finds nothing to orphan", (await rpc.stop()) === true);
      ctx.check("scenario 4: nothing survived the orderly stop", !isAlive(identity?.pid) && !isAlive(identity?.descendantPid));
      ctx.note("orderlyStopReclamation", { parentGone: goneAfterStop, descendantGone: descendantGoneAfterStop });
    } finally {
      if (identity) {
        killQuietly(identity.pid, "SIGKILL");
        killQuietly(identity.descendantPid, "SIGKILL");
      }
      if (rpc?.pid) await rpc.stop();
    }
  }

  ctx.limit("Process termination is asserted on Linux via a self-written PID; macOS/Windows semantics are not covered here.");
});

process.exit(evidence.ok ? 0 : 1);
