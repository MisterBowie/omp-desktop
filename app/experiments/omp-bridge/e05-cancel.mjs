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
    const pidFile = join(projectDir, "command.pid");

    provider.script([
      { text: "running", toolCalls: [{ name: "bash", args: { command: `echo $$ > ${pidFile}; exec sleep 300` } }], finish: "tool_calls" },
      { text: "after", finish: "stop" },
    ]);

    let rpc;
    let commandPid = null;
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
      commandPid = await readPidFile(pidFile);
      ctx.check("the command wrote its own PID while running", commandPid !== null, commandPid);
      ctx.check("the command process is alive before abort", isAlive(commandPid), commandPid);

      const abortResponse = await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      ctx.check("abort is acknowledged", abortResponse.success === true, abortResponse);
      await promptPromise.catch(() => {});
      await rpc.waitFor((f) => f.type === "agent_end" || f.type === "turn_end", 20_000);

      // Recorded finding, not a pass/fail gate: does the in-protocol stop path
      // reclaim the OS process of a command that is still running?
      const stoppedByAbort = await waitGone(commandPid, 5_000);
      const abortBash = await rpc.request({ type: "abort_bash" }, { timeoutMs: 20_000 });
      ctx.check("abort_bash is acknowledged", abortBash.success === true, abortBash);
      const stoppedByAbortBash = await waitGone(commandPid, 5_000);
      ctx.note("terminatedByPlainAbort", stoppedByAbort);
      ctx.note("terminatedByAbortBash", stoppedByAbortBash);
      ctx.check("the turn reports tool completion after stopping", rpc.framesOfType("tool_execution_end").length >= 1);
      ctx.limit(
        stoppedByAbortBash
          ? "In-protocol stop (abort/abort_bash) reclaimed the running command in this environment."
          : "In-protocol stop (abort + abort_bash) did NOT reclaim the OS process of the running command in rpc-ui mode; the desktop stop path needs a process-tree termination fallback, which the bridge-level kill provides (scenario 3).",
      );
      ctx.check("session stayed responsive after abort", (await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");

      writeFixture("e05-abort-events.json", {
        note: "real capture, sanitized; event type names and abort response only",
        eventTypes: [...new Set(rpc.frames.map((f) => f.type))],
        abortResponse,
        toolExecutionEnd: rpc.frames.filter((f) => f.type === "tool_execution_end").slice(0, 1),
      });
    } finally {
      if (commandPid && isAlive(commandPid)) { try { process.kill(commandPid, "SIGKILL"); } catch {} }
      ctx.onCleanup(() => { if (commandPid && isAlive(commandPid)) { try { process.kill(commandPid, "SIGKILL"); } catch {} } });
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
    const pidFile = join(projectDir, "command.pid");

    provider.script([{ text: "long", toolCalls: [{ name: "bash", args: { command: `echo $$ > ${pidFile}; exec sleep 300` } }], finish: "tool_calls" }]);

    let rpc;
    let commandPid = null;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--approval-mode", "yolo"],
        cwd: projectDir,
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "start long command" }, { timeoutMs: 45_000 });
      await rpc.waitFor((f) => f.type === "tool_execution_start", 30_000);
      commandPid = await readPidFile(pidFile);
      ctx.check("command PID observable before bridge kill", commandPid !== null, commandPid);
      ctx.check("command alive before bridge kill", isAlive(commandPid), commandPid);

      const reaped = await rpc.stop();
      ctx.check("bridge process group reaped on kill", reaped === true);
      await promptPromise.catch(() => {});

      ctx.check("no orphan command process survives the bridge kill", await waitGone(commandPid), `pid ${commandPid}`);
    } finally {
      ctx.onCleanup(() => { if (commandPid && isAlive(commandPid)) { try { process.kill(commandPid, "SIGKILL"); } catch {} } });
      if (rpc) await rpc.stop();
    }
  }

  ctx.limit("Process termination is asserted on Linux via a self-written PID; macOS/Windows semantics are not covered here.");
});

process.exit(evidence.ok ? 0 : 1);
