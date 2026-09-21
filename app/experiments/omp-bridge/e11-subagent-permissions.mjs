#!/usr/bin/env node
/**
 * E11 — subagent permission coverage and cancellation.
 *
 * The parent session's approval evidence does not by itself prove that a
 * subagent's tool calls are covered, so this experiment drives a real
 * subagent (`task` tool) with the trusted extension loaded and checks:
 *
 *   A. deny  — the subagent's `write` is blocked before execution;
 *   B. allow — the same call executes exactly once;
 *   C. cancel — the parent session is stopped while the subagent runs a real
 *      long command, and the subagent's process tree is reclaimed;
 *   D. pending — the parent is stopped while the subagent's approval dialog is
 *      still open: the dialog is cancelled by targetId and nothing is executed.
 *
 * The subagent's own model turns come from the local fake provider, so no paid
 * model is contacted.
 *
 * Usage: node e11-subagent-permissions.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const GATE = join(EXPERIMENT_ROOT, "extensions", "approval-gate.ts");
const LONG_TASK = join(EXPERIMENT_ROOT, "tools", "long-task.mjs");
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const killQuietly = (pid, sig) => { if (pid) { try { process.kill(pid, sig); } catch { /* gone */ } } };

/** Process group/session bookkeeping, used to explain reclamation results. */
function procInfo(pid) {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(rest[1]), pgrp: Number(rest[2]), session: Number(rest[3]) };
  } catch {
    return null;
  }
}

async function waitGone(pid, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await sleep(150);
  }
  return !isAlive(pid);
}

async function readIdentity(path, timeoutMs = 25_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8").trim());
        if (Number.isInteger(parsed.pid) && parsed.pid > 0) return parsed;
      } catch { /* still writing */ }
    }
    await sleep(100);
  }
  return null;
}

const readLog = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** Answer request-style dialogs with `choice` until `until()` or the deadline. */
async function driveUi(rpc, choice, until, timeoutMs = 60_000) {
  const answered = new Set();
  const dialogs = [];
  const start = Date.now();
  for (;;) {
    for (const frame of rpc.frames) {
      if (frame.type !== "extension_ui_request" || answered.has(frame.id)) continue;
      if (!DIALOG_METHODS.has(frame.method)) continue;
      answered.add(frame.id);
      dialogs.push({ id: frame.id, method: frame.method, title: frame.title });
      if (choice !== null) rpc.write({ type: "extension_ui_response", id: frame.id, value: choice });
    }
    if (until()) break;
    if (Date.now() - start > timeoutMs) break;
    await sleep(40);
  }
  return dialogs;
}

const taskCall = (target, marker) => ({
  name: "task",
  args: {
    i: "subagent work",
    context: "M1 subagent permission/cancel evidence",
    tasks: [{ task: `write the marker file ${target} (${marker})`, agent: "task", name: "M1Sub" }],
  },
});

const evidence = await runExperiment("e11-subagent-permissions", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  // ==========================================================================
  // A/B — deny and allow a subagent's own tool call
  // ==========================================================================
  for (const [label, choice, expectWritten] of [["deny", "Deny", false], ["allow", "Allow", true]]) {
    const { root, runRoot, selector } = experimentRoot(ctx, `e11-${label}`, { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const target = join(projectDir, `subagent-${label}.txt`);

    provider.script([
      { text: "delegating", toolCalls: [taskCall(target, label)], finish: "tool_calls" },
      { text: "child writing", toolCalls: [{ name: "write", args: { path: target, content: `${label}-once\n` } }], finish: "tool_calls" },
      { text: "child done", finish: "stop" },
      { text: "parent done", finish: "stop" },
    ]);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1" },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "delegate a write" }, { timeoutMs: 90_000 });
      const dialogs = await driveUi(rpc, choice, () => rpc.framesOfType("agent_end").length > 0);
      await promptPromise.catch(() => {});
      await sleep(1_000);

      const log = readLog(uiLog);
      const gate = log.find((l) => l.event === "gate" && l.toolName === "write");
      const decision = log.find((l) => l.event === "gate-decision");

      ctx.check(`${label}: the subagent's write reaches the extension hook`, Boolean(gate), JSON.stringify(log.slice(0, 4)));
      ctx.check(`${label}: the dialog is raised for the subagent call`, dialogs.length >= 1, dialogs);
      ctx.check(`${label}: the gate records the human decision`, decision?.decision === (expectWritten ? "allow" : "deny"), decision);
      ctx.check(`${label}: the gate saw the subagent's concrete target`, String(gate?.target ?? "").endsWith(`subagent-${label}.txt`), gate?.target);
      ctx.check(`${label}: the subagent executed exactly ${expectWritten ? "once" : "nothing"}`,
        expectWritten
          ? (existsSync(target) && readFileSync(target, "utf8") === `${label}-once\n`)
          : !existsSync(target));
      ctx.check(`${label}: the task tool itself ran under the hook`, log.some((l) => l.event === "tool-call-audit" && l.toolName === "task"));
      ctx.note(`${label}GateHasUI`, gate?.hasUI ?? null);

      if (label === "allow") {
        writeFixture("e11-subagent-allow.json", {
          note: "real capture, sanitized; subagent driven by the local fake provider, gate answer synthetic",
          gate, decision, dialogs,
          subagentFrames: [...new Set(rpc.frames.filter((f) => String(f.type).startsWith("subagent_")).map((f) => f.type))],
        });
      } else {
        writeFixture("e11-subagent-deny.json", {
          note: "real capture, sanitized; the subagent's write is denied before execution",
          gate, decision, dialogs,
          toolExecutionStarts: rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
          sideEffectCreated: existsSync(target),
        });
      }
    } finally {
      if (rpc) ctx.check(`${label}: process group reaped`, (await rpc.stop()) === true);
    }
  }

  // ==========================================================================
  // C — parent abort while the subagent runs a real long command
  // ==========================================================================
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e11-cancel", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const identityFile = join(projectDir, "subagent-identity.json");
    const uiLog = join(root, "ui.log");
    const command = `${process.execPath} ${LONG_TASK} ${identityFile}`;

    provider.script([
      { text: "delegating", toolCalls: [{ name: "task", args: { i: "long child work", context: "M1 subagent cancel", tasks: [{ task: "run the long command", agent: "task", name: "M1Long" }] } }], finish: "tool_calls" },
      { text: "child running", toolCalls: [{ name: "bash", args: { command } }], finish: "tool_calls" },
      { text: "child done", finish: "stop" },
      { text: "parent done", finish: "stop" },
    ]);

    let rpc;
    let identity = null;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc.request({ type: "set_subagent_subscription", level: "events" });
      const promptPromise = rpc.request({ type: "prompt", message: "delegate a long command" }, { timeoutMs: 90_000 });

      // The subagent's bash call may need approval; allow it, and stop waiting
      // as soon as the external program has recorded its identity.
      const dialogs = await driveUi(rpc, "Allow", () => existsSync(identityFile), 60_000);
      identity = await readIdentity(identityFile, 10_000);
      ctx.check("C: the subagent started a real external program", identity !== null, identity);
      ctx.check("C: the subagent's program is alive before abort", isAlive(identity?.pid), identity?.pid);
      ctx.check("C: the subagent's descendant is alive before abort", isAlive(identity?.descendantPid), identity?.descendantPid);
      ctx.note("C-dialogCount", dialogs.length);

      const subagentFrames = rpc.frames.filter((f) => String(f.type).startsWith("subagent_"));
      ctx.check("C: subagent lifecycle frames are emitted for the child", subagentFrames.some((f) => f.type === "subagent_lifecycle"), subagentFrames.map((f) => f.type).slice(0, 4));
      const lifecycle = subagentFrames.find((f) => f.type === "subagent_lifecycle");
      ctx.check("C: the child is correlated to the parent's task call", typeof lifecycle?.payload?.parentToolCallId === "string", lifecycle?.payload?.parentToolCallId);

      await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      await promptPromise.catch(() => {});

      // Measured, not assumed: does the parent's stop reclaim the subagent?
      const parentGoneAfterAbort = await waitGone(identity?.pid, 8_000);
      const descendantGoneAfterAbort = await waitGone(identity?.descendantPid, 8_000);
      ctx.note("C-reclamationAfterParentAbort", { parentGoneAfterAbort, descendantGoneAfterAbort });
      ctx.check("C: the parent stop is acknowledged and the session survives",
        (await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");

      // Is the subagent still tracked as running after the parent stopped?
      const snapshotAfterStop = await rpc.request({ type: "get_subagents" });
      const stillRunning = (snapshotAfterStop.data?.subagents ?? []).filter((s) => s.status === "running");
      ctx.note("C-subagentsStillRunningAfterParentStop", stillRunning.length);

      // Bridge teardown is the other candidate mechanism.
      const ompProc = procInfo(rpc.pid);
      const commandProc = procInfo(identity?.pid);
      ctx.note("C-proc", { ompProc, commandProc, childInOmpGroup: Boolean(ompProc && commandProc && commandProc.pgrp === ompProc.pgrp) });
      ctx.check("C: process group reaped", (await rpc.stop()) === true);
      const parentGoneAfterTeardown = await waitGone(identity?.pid, 5_000);
      const descendantGoneAfterTeardown = await waitGone(identity?.descendantPid, 5_000);
      ctx.note("C-reclamationAfterTeardown", { parentGoneAfterTeardown, descendantGoneAfterTeardown });

      ctx.limit(
        parentGoneAfterAbort
          ? "The parent stop reclaimed the subagent's running command tree."
          : "The parent stop did NOT reclaim the subagent's running command tree (the subagent runs detached), and bridge teardown does not either; the desktop must stop the subagent explicitly, and M2 must kill the subagent's process tree rather than relying on the parent turn ending.",
      );

      // Positive control: an explicit tree kill does reclaim it, so the
      // requirement above is achievable. This runs only after every
      // observation, and is a deliberate explicit kill, not a finally-fallback.
      const treePid = identity?.pid;
      if (treePid && isAlive(treePid)) {
        // Kill the subagent's own process group (its session leader is the
        // command itself when OMP detaches it).
        try { process.kill(-treePid, "SIGKILL"); } catch { killQuietly(treePid, "SIGKILL"); killQuietly(identity.descendantPid, "SIGKILL"); }
      }
      const reclaimedByExplicitKill = await waitGone(identity?.pid, 5_000) && await waitGone(identity?.descendantPid, 5_000);
      ctx.check("C: an explicit process-tree kill reclaims the subagent's command tree", reclaimedByExplicitKill,
        `parent ${identity?.pid} child ${identity?.descendantPid}`);

      writeFixture("e11-subagent-cancel.json", {
        note: "real capture, sanitized; subagent ran a real external program (tools/long-task.mjs) and the parent turn was stopped",
        subagentFrameTypes: [...new Set(subagentFrames.map((f) => f.type))],
        lifecycle: sanitizeFrame(lifecycle ?? null),
        identity: identity ? { pidIsDistinctFromOmp: identity.pid !== rpc.pid, ppidEqualsOmp: identity.ppid === rpc.pid } : null,
        reclamationAfterParentAbort: { parentGoneAfterAbort, descendantGoneAfterAbort },
        reclamationAfterTeardown: { parentGoneAfterTeardown, descendantGoneAfterTeardown },
        subagentsStillRunningAfterParentStop: stillRunning.length,
        reclaimedByExplicitProcessTreeKill: reclaimedByExplicitKill,
      });
    } finally {
      if (identity) {
        killQuietly(identity.pid, "SIGKILL");
        killQuietly(identity.descendantPid, "SIGKILL");
      }
      if (rpc?.pid) await rpc.stop();
    }
  }

  // ==========================================================================
  // D — parent abort while the subagent's approval dialog is still pending
  // ==========================================================================
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e11-pending", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const target = join(projectDir, "pending-subagent.txt");

    provider.script([
      { text: "delegating", toolCalls: [taskCall(target, "pending")], finish: "tool_calls" },
      { text: "child writing", toolCalls: [{ name: "write", args: { path: target, content: "never\n" } }], finish: "tool_calls" },
      { text: "child done", finish: "stop" },
      { text: "parent done", finish: "stop" },
    ]);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const promptPromise = rpc.request({ type: "prompt", message: "delegate a write" }, { timeoutMs: 90_000 });

      // Wait for the subagent's dialog, then never answer it.
      const dialog = await rpc.waitFor((f) => f.type === "extension_ui_request" && DIALOG_METHODS.has(f.method), 60_000);
      ctx.check("D: the subagent's approval dialog is pending before abort", Boolean(dialog), dialog?.title);

      await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      const cancelFrame = await rpc.waitFor(
        (f) => f.type === "extension_ui_request" && f.method === "cancel" && f.targetId === dialog?.id,
        20_000,
      );
      ctx.check("D: the pending subagent dialog is cancelled by targetId", Boolean(cancelFrame), cancelFrame ?? "no cancel frame");
      await promptPromise.catch(() => {});
      await sleep(1_000);

      const decision = readLog(uiLog).find((l) => l.event === "gate-decision");
      ctx.check("D: the gate resolved without an approval", decision?.decision === "deny", decision);
      ctx.check("D: no side effect from the cancelled subagent dialog", !existsSync(target));
      ctx.check("D: session stays responsive", (await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");
      ctx.check("D: process group reaped", (await rpc.stop()) === true);

      writeFixture("e11-subagent-pending-cancel.json", {
        note: "real capture, sanitized; the subagent's dialog was deliberately left unanswered",
        dialog: dialog ? { id: dialog.id, method: dialog.method, title: dialog.title } : null,
        cancel: cancelFrame ? sanitizeFrame(cancelFrame) : null,
        decision: decision ?? null,
        sideEffectCreated: existsSync(target),
      });
    } finally {
      if (rpc?.pid) await rpc.stop();
    }
  }

  ctx.limit("Subagent permission coverage is asserted for the `task` agent type driven by the local fake provider; other agent types and the M5 subagent UI are out of M1 scope.");
  ctx.limit("Approval dialogs raised from a subagent are answered by this experiment; how the desktop routes them is M5 work.");
});

process.exit(evidence.ok ? 0 : 1);
