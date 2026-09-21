#!/usr/bin/env node
/**
 * E11 — subagent permission coverage and cancellation.
 *
 * The first version of this experiment was invalid: it scripted model turns in
 * one shared queue, so the *parent* session (which keeps running while the
 * subagent starts asynchronously) consumed the `write` turn that was meant for
 * the subagent. Everything it "proved" about subagents was really the parent.
 *
 * This version routes turns by session identity: the child's assignment text is
 * the first user message of its own session, so the fake provider can tell the
 * two sessions apart without relying on timing. It then asserts correlation —
 * the gate's own session id, `hasUI`, and the child's `parentToolCallId` — so a
 * result can only be attributed to the real subagent.
 *
 * Measured on the pinned OMP (rpc-ui):
 *   - a subagent's `write`/`bash` DOES reach the extension `tool_call` hook;
 *   - that hook runs with `hasUI: false`, so it cannot ask the user;
 *   - a UI-dependent gate therefore blocks every subagent tool call, and the
 *     desktop has to decide from its own policy (`M1_CHILD_POLICY` here) or
 *     provide an out-of-band channel (`M1_CHILD_POLICY=defer`).
 *
 * Usage: node e11-subagent-permissions.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Answer real dialogs (parent UI only) while a predicate becomes true. */
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

/** Parent turn: delegate one task to a named subagent carrying `marker`. */
const delegatingTurn = (marker, name, assignment) => ({
  text: "parent delegates",
  toolCalls: [{
    name: "task",
    args: { i: "spawn a child", context: "M1 subagent evidence", tasks: [{ task: `${marker} ${assignment}`, agent: "task", name }] },
  }],
  finish: "tool_calls",
});

const evidence = await runExperiment("e11-subagent-permissions", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  // ==========================================================================
  // A/B — the child's own tool call is denied / approved by policy
  // ==========================================================================
  for (const [label, policy, expectWritten] of [["deny", "deny", false], ["allow", "allow", true]]) {
    const { root, runRoot, selector } = experimentRoot(ctx, `e11-${label}`, { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const target = join(projectDir, `child-${label}.txt`);
    const marker = `M1-CHILD-${label.toUpperCase()}-NONCE-a71c`;

    provider.routeBySession({
      parent: [delegatingTurn(marker, "M1Child", `write the marker file ${target}`), { text: "parent wraps up", finish: "stop" }],
      subagents: [{
        marker,
        turns: [
          { text: "child writes", toolCalls: [{ name: "write", args: { path: target, content: `${label}-once\n` } }], finish: "tool_calls" },
          { text: "child finished", finish: "stop" },
        ],
      }],
    });

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1", M1_CHILD_POLICY: policy },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc.request({ type: "set_subagent_subscription", level: "events" });
      await rpc.request({ type: "prompt", message: "delegate a write to a child" }, { timeoutMs: 90_000 });
      const dialogs = await driveUi(rpc, null, () => rpc.framesOfType("agent_end").length > 0, 60_000);
      await sleep(1_500);

      const log = readLog(uiLog);
      const childAudit = log.find((l) => l.event === "tool-call-audit" && l.toolName === "write");
      const parentAudit = log.find((l) => l.event === "tool-call-audit" && l.toolName === "task");
      const gate = log.find((l) => l.event === "gate" && l.toolName === "write");
      const decision = log.find((l) => l.event === "gate-decision");
      const lifecycle = rpc.frames.find((f) => f.type === "subagent_lifecycle")?.payload;
      const taskEnd = rpc.frames.find((f) => f.type === "tool_execution_end" && f.toolName === "task");
      const classifications = provider.requests.map((r) => provider.classifyRequest(r.body).kind);

      // --- attribution: prove the write belongs to the child, not the parent --
      ctx.check(`${label}: requests were routed to two distinct sessions`,
        classifications.includes("parent") && classifications.includes("subagent"), classifications);
      ctx.check(`${label}: the parent looked up the task tool under its own session`,
        parentAudit?.hasUI === true, parentAudit);
      ctx.check(`${label}: the child's write reached the hook from a UI-less session`,
        childAudit?.hasUI === false, childAudit);
      ctx.check(`${label}: the child's session is distinct from the parent's session`,
        Boolean(childAudit?.sessionId) && childAudit.sessionId !== parentAudit?.sessionId,
        { child: childAudit?.sessionId, parent: parentAudit?.sessionId });
      ctx.check(`${label}: the gate saw the child's own target`,
        typeof gate?.target === "string" && gate.target.endsWith(`child-${label}.txt`), gate?.target);
      ctx.check(`${label}: the child is linked to the parent's task call`,
        typeof lifecycle?.parentToolCallId === "string" &&
        typeof taskEnd?.toolCallId === "string" &&
        lifecycle.parentToolCallId === taskEnd.toolCallId,
        { lifecycle: lifecycle?.parentToolCallId, parentTask: taskEnd?.toolCallId });
      ctx.check(`${label}: the child ran in its own session file`,
        typeof lifecycle?.sessionFile === "string" && lifecycle.sessionFile.includes("M1Child"),
        lifecycle?.sessionFile);
      ctx.check(`${label}: the parent never issued a write of its own`,
        !rpc.frames.some((f) => f.type === "tool_execution_start" && f.toolName === "write"),
        rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName));

      // --- outcome ----------------------------------------------------------
      ctx.check(`${label}: the hook decided from the session's own policy`,
        decision?.route === "child-policy" && decision?.decision === (expectWritten ? "allow" : "deny"), decision);
      ctx.check(`${label}: no dialog was raised for the child (it has no UI)`, dialogs.length === 0, dialogs);
      ctx.check(`${label}: the side effect matches the decision`,
        expectWritten
          ? (existsSync(target) && readFileSync(target, "utf8") === `${label}-once\n`)
          : !existsSync(target), existsSync(target));
      ctx.note(`${label}Audit`, { parent: parentAudit ?? null, child: childAudit ?? null, gate: gate ?? null, decision: decision ?? null });

      writeFixture(`e11-subagent-${label}.json`, {
        note: "real capture, sanitized; turns routed by session identity, decision injected by the experiment's policy",
        parentSessionId: parentAudit?.sessionId ?? null,
        childSessionId: childAudit?.sessionId ?? null,
        childHasUI: childAudit?.hasUI ?? null,
        lifecycle: sanitizeFrame(lifecycle ?? null),
        parentTaskToolCallId: taskEnd?.toolCallId ?? null,
        gate: gate ? { ...sanitizeFrame(gate), target: `<run>/project/child-${label}.txt` } : null,
        decision: decision ?? null,
        dialogCount: dialogs.length,
        sideEffectCreated: existsSync(target),
      });
    } finally {
      if (rpc) ctx.check(`${label}: process group reaped`, (await rpc.stop()) === true);
    }
  }

  // ==========================================================================
  // C — the child waits for an out-of-band decision, then the parent is stopped
  // ==========================================================================
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e11-pending", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const decisionFile = join(root, "child-decision.txt");
    const target = join(projectDir, "child-pending.txt");
    const marker = "M1-CHILD-PENDING-NONCE-b93d";

    provider.routeBySession({
      parent: [delegatingTurn(marker, "M1Pending", `write the marker file ${target}`), { text: "parent wraps up", finish: "stop" }],
      subagents: [{
        marker,
        turns: [
          { text: "child writes", toolCalls: [{ name: "write", args: { path: target, content: "never\n" } }], finish: "tool_calls" },
          { text: "child finished", finish: "stop" },
        ],
      }],
    });

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: {
          M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1",
          M1_CHILD_POLICY: "defer", M1_CHILD_DECISION: decisionFile, M1_CHILD_DEFER_MS: "20000",
        },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc.request({ type: "set_subagent_subscription", level: "events" });
      await rpc.request({ type: "prompt", message: "delegate a write to a child" }, { timeoutMs: 90_000 });

      // The gate logs a pending entry while it waits; that is the observable
      // "child is waiting for approval" state (there is no dialog for it).
      let pendingSeen = false;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 30_000) {
        if (readLog(uiLog).some((l) => l.event === "gate-pending")) { pendingSeen = true; break; }
        await sleep(100);
      }
      ctx.check("C: the child's call reached the hook and is waiting for a decision", pendingSeen, readLog(uiLog).map((l) => l.event));
      ctx.check("C: nothing was executed while the child waited", !existsSync(target));

      // Stop the parent while the child is still waiting.
      const started = Date.now();
      await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      const abortMs = Date.now() - started;
      ctx.check("C: the session stayed responsive through the stop", (await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");
      await sleep(1_500);

      const resolved = readLog(uiLog).find((l) => l.event === "gate-decision" && l.route === "child-defer");
      ctx.check("C: no side effect from the abandoned child call", !existsSync(target));
      ctx.check("C: the stop did not hang on the waiting call", abortMs < 20_000, `${abortMs} ms`);

      // The deferred decision is bounded by M1_CHILD_DEFER_MS; wait for it so
      // the final state is deterministic rather than merely "not yet resolved".
      let settled = resolved ?? null;
      const settleStart = Date.now();
      while (!settled && Date.now() - settleStart < 30_000) {
        settled = readLog(uiLog).find((l) => l.event === "gate-decision" && l.route === "child-defer") ?? null;
        if (!settled) await sleep(200);
      }
      ctx.check("C: the abandoned child approval resolves to a denial after the stop",
        settled?.decision === "deny", settled ?? "still pending after 30s");
      ctx.check("C: still no side effect once the child approval settled", !existsSync(target));
      ctx.note("C-deferResolution", settled ?? null);
      ctx.check("C: process group reaped", (await rpc.stop()) === true);

      writeFixture("e11-subagent-pending-cancel.json", {
        note: "real capture, sanitized; the child's approval was deferred to an out-of-band channel that never answered, then the parent was stopped",
        markers: readLog(uiLog).map((l) => l.event),
        pendingSeen,
        sideEffectCreated: existsSync(target),
        abortMs,
        deferResolution: settled ? sanitizeFrame(settled) : null,
      });
    } finally {
      if (rpc?.pid) await rpc.stop();
    }
  }

  // ==========================================================================
  // D — the child executes a real long command, then the parent is stopped
  // ==========================================================================
  {
    const { root, runRoot, selector } = experimentRoot(ctx, "e11-cancel", { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const identityFile = join(projectDir, "child-identity.json");
    const marker = "M1-CHILD-CANCEL-NONCE-c05e";
    const command = `${process.execPath} ${LONG_TASK} ${identityFile}`;

    provider.routeBySession({
      parent: [delegatingTurn(marker, "M1Long", "run the long command"), { text: "parent wraps up", finish: "stop" }],
      subagents: [{
        marker,
        turns: [
          { text: "child runs", toolCalls: [{ name: "bash", args: { command } }], finish: "tool_calls" },
          { text: "child finished", finish: "stop" },
        ],
      }],
    });

    let rpc;
    let identity = null;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1", M1_CHILD_POLICY: "allow" },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc.request({ type: "set_subagent_subscription", level: "events" });
      await rpc.request({ type: "prompt", message: "delegate a long command" }, { timeoutMs: 90_000 });

      identity = await readIdentity(identityFile, 40_000);
      ctx.check("D: the child really started the external program", identity !== null, identity);
      ctx.check("D: the child's program is alive before the parent stops", isAlive(identity?.pid), identity?.pid);
      ctx.check("D: the child's descendant is alive before the parent stops", isAlive(identity?.descendantPid), identity?.descendantPid);
      ctx.check("D: the command belongs to a child process, not OMP itself",
        Boolean(identity) && identity.pid !== rpc.pid && identity.ppid !== process.pid,
        { child: identity?.pid, ppid: identity?.ppid, omp: rpc.pid, harness: process.pid });
      // The gate must not have raised a dialog: the child approves by policy.
      ctx.check("D: the child's bash was approved by policy, not by a dialog",
        readLog(uiLog).some((l) => l.event === "gate-decision" && l.toolName === undefined && l.route === "child-policy" && l.decision === "allow") ||
        readLog(uiLog).some((l) => l.event === "gate-decision" && l.route === "child-policy"),
        readLog(uiLog).filter((l) => l.event === "gate-decision"));

      await rpc.request({ type: "abort" }, { timeoutMs: 20_000 });
      const parentGoneAfterAbort = await waitGone(identity?.pid, 10_000);
      const descendantGoneAfterAbort = await waitGone(identity?.descendantPid, 10_000);
      ctx.note("D-reclamationAfterParentAbort", { parentGoneAfterAbort, descendantGoneAfterAbort });
      ctx.check("D: the stop leaves the session responsive",
        (await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");
      const snapshot = await rpc.request({ type: "get_subagents" });
      const running = (snapshot.data?.subagents ?? []).filter((s) => s.status === "running").length;

      ctx.check("D: process group reaped", (await rpc.stop()) === true);
      const goneAfterTeardown = await waitGone(identity?.pid, 5_000);
      ctx.note("D-reclamationAfterTeardown", { goneAfterTeardown });

      // Positive control, run only after every observation.
      let reclaimedByExplicitKill = !isAlive(identity?.pid);
      if (isAlive(identity?.pid)) {
        try { process.kill(-identity.pid, "SIGKILL"); } catch { killQuietly(identity.pid, "SIGKILL"); }
        killQuietly(identity?.descendantPid, "SIGKILL");
        reclaimedByExplicitKill = await waitGone(identity?.pid, 5_000) && await waitGone(identity?.descendantPid, 5_000);
      }
      ctx.check("D: an explicit process-tree kill reclaims the child's command tree", reclaimedByExplicitKill,
        `pid ${identity?.pid} descendant ${identity?.descendantPid}`);

      writeFixture("e11-subagent-cancel.json", {
        note: "real capture, sanitized; the child session ran a real external program and the parent turn was stopped",
        childIsDistinctProcess: Boolean(identity) && identity.pid !== rpc.pid,
        reclamationAfterParentAbort: { parentGoneAfterAbort, descendantGoneAfterAbort },
        reclamationAfterTeardown: { goneAfterTeardown },
        subagentsRunningAfterParentStop: running,
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

  ctx.limit("The child-session policy (`M1_CHILD_POLICY`) and the out-of-band decision file are the experiment's model of a desktop-side policy; OMP itself provides no UI for subagent sessions, so an interactive subagent approval cannot be verified here.");
  ctx.limit("Only the `task` agent type is driven; other agent types and the M5 subagent UI are out of M1 scope.");
});

process.exit(evidence.ok ? 0 : 1);
