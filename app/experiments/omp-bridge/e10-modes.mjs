#!/usr/bin/env node
/**
 * E10 — capability difference between `--mode rpc` and `--mode rpc-ui`.
 *
 * An earlier source-only reading assumed plain `rpc` has no extension UI at
 * all. Running the identical scenario in both modes shows that is wrong, and
 * the real difference is narrower and more useful:
 *
 *   - extension dialogs (`select`/`confirm`/`input`/`editor`) work in BOTH
 *     modes, because rpc-mode installs an extension UI bridge either way;
 *   - tool-level UI does not: `sessionOptions.hasUI = isInteractive || mode ===
 *     "rpc-ui"` (main.ts:2085) and only rpc-ui calls `setToolUIContext`, so
 *     OMP's own `ask` tool is created via `AskTool.createIf` only in rpc-ui.
 *
 * The probe therefore reads the tool list OMP actually advertises to the model
 * in each mode.
 *
 * Usage: node e10-modes.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const GATE = join(EXPERIMENT_ROOT, "extensions", "approval-gate.ts");
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Answer request-style extension UI messages with "Allow" until the turn ends. */
async function driveUi(rpc, until, timeoutMs = 45_000) {
  const requests = [];
  const notifications = [];
  const answered = new Set();
  const start = Date.now();
  for (;;) {
    for (const frame of rpc.frames) {
      if (frame.type !== "extension_ui_request" || answered.has(frame.id)) continue;
      answered.add(frame.id);
      if (DIALOG_METHODS.has(frame.method)) {
        requests.push({ id: frame.id, method: frame.method, title: frame.title });
        rpc.write({ type: "extension_ui_response", id: frame.id, value: "Allow" });
      } else {
        // notify/setStatus/setWidget/setTitle/cancel are fire-and-forget.
        notifications.push({ id: frame.id, method: frame.method });
      }
    }
    if (until()) break;
    if (Date.now() - start > timeoutMs) break;
    await sleep(40);
  }
  return { requests, notifications };
}

const readLog = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const evidence = await runExperiment("e10-modes", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const results = {};

  for (const mode of ["rpc", "rpc-ui"]) {
    const { root, runRoot, selector } = experimentRoot(ctx, `e10-${mode}`, { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const target = join(projectDir, "guarded.txt");

    provider.script([
      { text: "attempting", toolCalls: [{ name: "write", args: { path: target, content: "approved-once\n" } }], finish: "tool_calls" },
      { text: "finished", finish: "stop" },
    ]);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode,
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1" },
      });
      ctx.check(`${mode}: ready arrives and protocol v2 negotiates`,
        (await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 })).success === true);

      const prompt = rpc.request({ type: "prompt", message: "attempt write" }, { timeoutMs: 50_000 });
      const ui = await driveUi(rpc, () => rpc.framesOfType("agent_end").length > 0);
      await prompt;

      const log = readLog(uiLog);
      const gate = log.find((l) => l.event === "gate");
      const decision = log.find((l) => l.event === "gate-decision");
      const advertisedTools = (provider.lastRequest?.body?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean);

      results[mode] = {
        mode,
        toolCallHookSawNativeTool: log.some((l) => l.event === "tool-call-audit" && l.toolName === "write"),
        contextHasUI: gate?.hasUI ?? null,
        dialogsRequested: ui.requests.length,
        dialogMethods: ui.requests.map((r) => r.method),
        notifications: ui.notifications.map((n) => n.method),
        decision: decision?.decision ?? null,
        wroteFile: existsSync(target),
        advertisesAskTool: advertisedTools.includes("ask"),
        advertisedToolCount: advertisedTools.length,
        reportedAgentEnd: rpc.framesOfType("agent_end").length > 0,
      };

      ctx.check(`${mode}: the tool_call hook observes the native tool`, results[mode].toolCallHookSawNativeTool);
      ctx.check(`${mode}: exactly one approval dialog is requested`, ui.requests.length === 1, ui.requests);
      ctx.check(`${mode}: the approved decision is honored exactly once`,
        decision?.decision === "allow" && readFileSync(target, "utf8") === "approved-once\n");
    } finally {
      if (rpc) ctx.check(`${mode}: process group reaped`, (await rpc.stop()) === true);
    }
  }

  // --- shared behaviour ----------------------------------------------------
  for (const mode of ["rpc", "rpc-ui"]) {
    ctx.check(`${mode}: extensions reach the tool_call hook`, results[mode].toolCallHookSawNativeTool);
    ctx.check(`${mode}: extension dialogs are delivered over the protocol`, results[mode].dialogsRequested === 1, results[mode].dialogsRequested);
    ctx.check(`${mode}: the extension sees a UI context`, results[mode].contextHasUI === true, results[mode].contextHasUI);
    ctx.note(`${mode}Notifications`, results[mode].notifications);
  }

  // --- the actual difference ----------------------------------------------
  ctx.check("rpc-ui advertises OMP's ask tool to the model", results["rpc-ui"].advertisesAskTool === true, results["rpc-ui"].advertisedToolCount);
  ctx.check("plain rpc does not advertise OMP's ask tool", results.rpc.advertisesAskTool === false, results.rpc.advertisedToolCount);

  writeFixture("e10-mode-capabilities.json", {
    note: "real capture, sanitized; identical scenario in both modes with a local fake provider",
    modes: results,
    source: {
      hasUI: "packages/coding-agent/src/main.ts:2085 sessionOptions.hasUI = isInteractive || mode === \"rpc-ui\"",
      toolUiContext: "packages/coding-agent/src/main.ts:2311 runRpcMode(session, mode === \"rpc-ui\" ? setToolUIContext : undefined, ...) -> sdk.ts:3597 toolContextStore.setUIContext",
      askToolGate: "packages/coding-agent/src/tools/ask.ts:807 AskTool.createIf returns null unless session.canPromptUser ?? session.hasUI",
      extensionUiBridge: "packages/coding-agent/src/modes/rpc/rpc-mode.ts:772 emits extension_ui_request regardless of mode",
    },
  });

  ctx.limit("ACP and SDK paths were read in source only; M1 selects rpc-ui and does not need them, so no runtime comparison is claimed.");
});

process.exit(evidence.ok ? 0 : 1);
