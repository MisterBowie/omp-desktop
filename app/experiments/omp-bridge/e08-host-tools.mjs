#!/usr/bin/env node
/**
 * E08 — host tools, subagents, and the permission-coverage boundary.
 *
 * Answers two questions with evidence:
 *   1. can the desktop register a host tool and serve its calls over RPC?
 *   2. does registering host tools (or subscribing to subagents) mean OMP's
 *      native tools are covered by the same approval path?
 *
 * The second answer is the important one: an extension that observes EVERY
 * `tool_call` records whether a host tool and native tools both reach it.
 *
 * Usage: node e08-host-tools.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const GATE = join(EXPERIMENT_ROOT, "extensions", "approval-gate.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST_TOOL = {
  name: "m1_host_echo",
  label: "M1 Host Echo",
  description: "Host-provided echo tool used by the M1 bridge experiments.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "text to echo" } },
    required: ["text"],
  },
};

const evidence = await runExperiment("e08-host-tools", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const { root, runRoot, selector } = experimentRoot(ctx, "e08", { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const uiLog = join(root, "audit.log");
  const nativeTarget = join(projectDir, "native.txt");

  provider.script([
    { text: "calling host tool", toolCalls: [{ name: HOST_TOOL.name, args: { text: "from-model" } }], finish: "tool_calls" },
    { text: "now a native tool", toolCalls: [{ name: "write", args: { path: nativeTarget, content: "native\n" } }], finish: "tool_calls" },
    { text: "done", finish: "stop" },
  ]);

  let rpc;
  const hostCalls = [];
  try {
    rpc = await OmpRpc.start({
      repoRoot, runRoot, mode: "rpc-ui",
      args: ["--model", selector, "--extension", GATE, "--approval-mode", "yolo"],
      cwd: projectDir,
      extraEnv: { M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1" },
    });
    await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

    // --- 1. register the host tool -----------------------------------------
    const registered = await rpc.request({ type: "set_host_tools", tools: [HOST_TOOL] });
    ctx.check("set_host_tools is accepted", registered.success === true, registered);
    ctx.check("registered host tool name is echoed back", (registered.data?.toolNames ?? []).includes(HOST_TOOL.name), registered.data?.toolNames);
    ctx.note("registeredHostTools", registered.data?.toolNames ?? []);

    // --- 2. subagent subscription ------------------------------------------
    const sub = await rpc.request({ type: "set_subagent_subscription", level: "events" });
    ctx.check("set_subagent_subscription(events) is accepted", sub.success === true, sub);
    const snapshot = await rpc.request({ type: "get_subagents" });
    ctx.check("get_subagents returns a snapshot", snapshot.success === true && Array.isArray(snapshot.data?.subagents ?? []), `${(snapshot.data?.subagents ?? []).length} subagents`);

    // --- 3. run a turn that calls the host tool, then a native tool ---------
    const promptPromise = rpc.request({ type: "prompt", message: "call the host tool then write a file" }, { timeoutMs: 45_000 });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && rpc.framesOfType("agent_end").length === 0) {
      for (const frame of rpc.frames) {
        if (frame.type !== "host_tool_call" || hostCalls.some((c) => c.id === frame.id)) continue;
        hostCalls.push({ id: frame.id, toolName: frame.toolName, args: frame.arguments });
        rpc.write({
          type: "host_tool_result",
          id: frame.id,
          result: { content: [{ type: "text", text: `host-echo:${frame.arguments?.text ?? ""}` }] },
        });
      }
      await sleep(50);
    }
    await promptPromise;

    ctx.check("the host tool was actually called by the model", hostCalls.length >= 1, hostCalls.map((c) => c.toolName));
    ctx.check("the host tool call carried the model's arguments", hostCalls[0]?.args?.text === "from-model", hostCalls[0]?.args);

    // The tool result must reach the model on a later provider request.
    const resultSeenByModel = provider.requests.some((r) =>
      JSON.stringify(r.body?.messages ?? []).includes("host-echo:from-model"),
    );
    ctx.check("host tool result is fed back to the model", resultSeenByModel);

    // --- 4. permission boundary --------------------------------------------
    await sleep(500);
    const audit = existsSync(uiLog)
      ? readFileSync(uiLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const toolNamesSeenByExtension = audit.filter((l) => l.event === "tool-call-audit").map((l) => l.toolName);
    ctx.note("toolCallsSeenByExtension", toolNamesSeenByExtension);
    ctx.check("the extension observed the native tool call", toolNamesSeenByExtension.includes("write"), toolNamesSeenByExtension);
    ctx.note("hostToolSeenByExtension", toolNamesSeenByExtension.includes(HOST_TOOL.name));
    ctx.check(
      "host tool registration does not imply native tools bypass the extension path",
      toolNamesSeenByExtension.includes("write"),
      "native `write` still reached the tool_call hook",
    );
    ctx.limit(
      toolNamesSeenByExtension.includes(HOST_TOOL.name)
        ? "The host tool also passed through the extension tool_call hook."
        : "The host tool did NOT pass through the extension tool_call hook: registering host tools is not covered by the same pre-execution extension gate, so the desktop must gate host-tool execution on its own side.",
    );

    // The gate intentionally denies gated tools when no UI is connected (E04),
    // so the observable proof here is interception BEFORE execution.
    const nativeStarts = rpc.frames.filter((f) => f.type === "tool_execution_start" && f.toolName === "write");
    ctx.check("native tool was intercepted before execution", nativeStarts.length === 0, `${nativeStarts.length} executions`);
    ctx.check("denied native tool produced no side effect", !existsSync(nativeTarget));

    writeFixture("e08-host-tool-exchange.json", {
      note: "real capture, sanitized",
      registration: sanitizeFrame(registered),
      hostToolCalls: hostCalls,
      toolCallsSeenByExtension: toolNamesSeenByExtension,
      subagentSubscription: "events",
    });
  } finally {
    if (rpc) ctx.check("process group reaped", (await rpc.stop()) === true);
  }

  ctx.limit("The host-tool exchange is a real capture; the fake provider only supplies model turns.");

  // ==========================================================================
  // Scenario 2 — host tool cancellation
  // ==========================================================================
  {
    const { root: root2, runRoot: runRoot2, selector: selector2 } = experimentRoot(ctx, "e08-cancel", { baseUrl: provider.baseUrl });
    const projectDir2 = join(root2, "project");
    mkdirSync(projectDir2, { recursive: true });

    provider.script([
      { text: "calling host tool", toolCalls: [{ name: HOST_TOOL.name, args: { text: "never-answered" } }], finish: "tool_calls" },
      { text: "wrapped up", finish: "stop" },
    ]);

    let rpc2;
    try {
      rpc2 = await OmpRpc.start({ repoRoot, runRoot: runRoot2, mode: "rpc-ui", args: ["--model", selector2], cwd: projectDir2 });
      await rpc2.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc2.request({ type: "set_host_tools", tools: [HOST_TOOL] });

      const prompt2 = rpc2.request({ type: "prompt", message: "call the host tool" }, { timeoutMs: 45_000 });
      // Wait for the call, then deliberately never answer it and abort instead.
      const pending = await rpc2.waitFor((f) => f.type === "host_tool_call", 20_000);
      ctx.check("scenario 2: host tool call arrives and is left unanswered", pending?.toolName === HOST_TOOL.name, pending?.type);
      await rpc2.request({ type: "abort" }, { timeoutMs: 20_000 });
      await prompt2.catch(() => {});
      await rpc2.waitFor((f) => f.type === "agent_end", 20_000);

      const cancelFrame = rpc2.frames.find((f) => f.type === "host_tool_cancel");
      ctx.note("hostToolCancelFrame", cancelFrame ? sanitizeFrame(cancelFrame) : null);
      // Cancellation is correlated by `targetId` (its own `id` is a fresh frame id),
      // exactly like the dialog cancel frames in E03/E05.
      ctx.check(
        "abandoning a pending host tool call produces host_tool_cancel",
        Boolean(cancelFrame) && cancelFrame.targetId === pending?.id,
        cancelFrame ? sanitizeFrame(cancelFrame) : "no host_tool_cancel frame",
      );
      ctx.check("host_tool_cancel carries its own distinct frame id", Boolean(cancelFrame) && cancelFrame.id !== cancelFrame.targetId);
      ctx.check("scenario 2: session stays responsive after the abandoned call", (await rpc2.request({ type: "get_state" }, { timeoutMs: 10_000 })).type === "response");
      ctx.check("scenario 2: process group reaped", (await rpc2.stop()) === true);
      writeFixture("e08-host-tool-cancel.json", {
        note: "real capture, sanitized; the host deliberately never answered the call",
        request: pending ? sanitizeFrame(pending) : null,
        cancel: cancelFrame ? sanitizeFrame(cancelFrame) : null,
      });
    } finally {
      if (rpc2?.pid) try { await rpc2.stop(); } catch { /* already stopped */ }
    }
  }

  // ==========================================================================
  // Scenario 3 — real subagent events
  // ==========================================================================
  {
    const { root: root3, runRoot: runRoot3, selector: selector3 } = experimentRoot(ctx, "e08-subagent", { baseUrl: provider.baseUrl });
    const projectDir3 = join(root3, "project");
    mkdirSync(projectDir3, { recursive: true });

    provider.script([
      { text: "delegating", toolCalls: [{ name: "task", args: { i: "spawn a scout", context: "M1 subagent evidence", tasks: [{ task: "report the word ALPHA", agent: "scout", name: "M1Scout" }] } }], finish: "tool_calls" },
      { text: "ALPHA", finish: "stop" },
      { text: "subagent finished", finish: "stop" },
      { text: "parent done", finish: "stop" },
    ]);

    let rpc3;
    try {
      rpc3 = await OmpRpc.start({ repoRoot, runRoot: runRoot3, mode: "rpc-ui", args: ["--model", selector3], cwd: projectDir3 });
      await rpc3.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc3.request({ type: "set_host_tools", tools: [HOST_TOOL] });
      const sub = await rpc3.request({ type: "set_subagent_subscription", level: "events" });
      ctx.check("scenario 3: subagent subscription accepted for the run", sub.success === true, sub.data?.level);

      const prompt3 = rpc3.request({ type: "prompt", message: "delegate a small task to a subagent" }, { timeoutMs: 60_000 });
      // Sample the snapshot while the subagent is still alive: finished
      // subagents are dropped from the registry, so querying after agent_end
      // would legitimately report none.
      await rpc3.waitFor((f) => typeof f.type === "string" && f.type.startsWith("subagent_"), 40_000);
      const snapshot3 = await rpc3.request({ type: "get_subagents" });
      const subs = snapshot3.data?.subagents ?? [];
      ctx.check("scenario 3: get_subagents reports the live subagent", subs.length > 0, `${subs.length} subagents`);
      ctx.note("subagentSnapshot", sanitizeFrame(subs.slice(0, 2)));
      await prompt3.catch(() => {});
      await rpc3.waitFor((f) => f.type === "agent_end", 60_000);
      await sleep(1_000);

      const subagentFrames = rpc3.frames.filter((f) => typeof f.type === "string" && f.type.startsWith("subagent_"));
      ctx.check("scenario 3: real subagent frames reach the desktop", subagentFrames.length > 0, subagentFrames.map((f) => f.type));
      ctx.check("scenario 3: lifecycle, progress and event frames are all covered",
        ["subagent_lifecycle", "subagent_progress", "subagent_event"].every((t) => subagentFrames.some((f) => f.type === t)),
        [...new Set(subagentFrames.map((f) => f.type))]);
      ctx.note("subagentFrameTypes", [...new Set(subagentFrames.map((f) => f.type))]);
      ctx.check("scenario 3: the task tool actually executed", rpc3.frames.some((f) => f.type === "tool_execution_start" && f.toolName === "task"));
      ctx.check("scenario 3: process group reaped", (await rpc3.stop()) === true);
      writeFixture("e08-subagent-events.json", {
        note: "real capture, sanitized; subagent driven by the local fake provider",
        frameTypes: [...new Set(subagentFrames.map((f) => f.type))],
        sample: sanitizeFrame(subagentFrames.find((f) => f.type === "subagent_lifecycle") ?? subagentFrames[0] ?? null),
        snapshot: sanitizeFrame(subs.slice(0, 1)),
      });
    } finally {
      if (rpc3?.pid) try { await rpc3.stop(); } catch { /* already stopped */ }
    }
  }
});

process.exit(evidence.ok ? 0 : 1);