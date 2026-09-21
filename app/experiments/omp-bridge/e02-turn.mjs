#!/usr/bin/env node
/**
 * E02 — a local fake model drives a real OMP turn.
 *
 * Verifies text, thinking, and a controlled tool call flow through the real
 * agent loop, and separates the `prompt` command response (acceptance) from the
 * real end-of-turn signal (`turn_end` / `agent_end`).
 *
 * Usage: node e02-turn.mjs [--keep-artifacts]
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const evidence = await runExperiment("e02-turn", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const { root, runRoot, selector, launchDir } = experimentRoot(ctx, "e02", { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const targetFile = join(projectDir, "hello.txt");

  let rpc;
  try {
    // Turn 1: thinking + text + a controlled `write` tool call. Turn 2: closing text.
    provider.script([
      { thinking: "planning a small write", text: "Writing the file now.", toolCalls: [{ name: "write", args: { path: targetFile, content: "hello from e02\n" } }], finish: "tool_calls" },
      { thinking: "finishing", text: "Done.", finish: "stop" },
    ]);

    rpc = await OmpRpc.start({
      repoRoot, runRoot, mode: "rpc-ui",
      args: ["--model", selector, "--approval-mode", "yolo"],
      cwd: projectDir,
    });
    await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

    const promptStart = Date.now();
    const promptResponse = await rpc.request({ type: "prompt", message: "Create hello.txt" }, { timeoutMs: 20_000 });
    const promptResponseAt = Date.now() - promptStart;
    ctx.check("prompt command is acknowledged", promptResponse.success === true, promptResponse);
    ctx.check("prompt acknowledgement arrives before the turn ends", rpc.framesOfType("turn_end").length === 0, `at ${promptResponseAt}ms`);

    const agentEnd = await rpc.waitFor((f) => f.type === "agent_end", 60_000);
    ctx.check("agent_end terminates the turn", Boolean(agentEnd));
    ctx.check("prompt acknowledgement is not the turn-end signal", Boolean(agentEnd) && promptResponseAt < 60_000);

    // --- tool call evidence -------------------------------------------------
    const toolStart = rpc.framesOfType("tool_execution_start");
    const toolEnd = rpc.framesOfType("tool_execution_end");
    ctx.check("tool_execution_start observed", toolStart.length >= 1, toolStart.map((f) => f.toolName ?? f.name));
    ctx.check("tool_execution_end observed", toolEnd.length >= 1);
    ctx.check("the real write tool ran and produced the file", existsSync(targetFile));
    if (existsSync(targetFile)) {
      ctx.check("file content matches the scripted tool call", readFileSync(targetFile, "utf8") === "hello from e02\n", readFileSync(targetFile, "utf8"));
    }

    // --- transport shape ----------------------------------------------------
    const textFrames = rpc.frames.filter((f) => f.type === "text" || f.type === "message_update");
    ctx.check("assistant text/thinking reached the client", textFrames.length > 0, `${textFrames.length} frames`);
    const turnEnd = rpc.framesOfType("turn_end");
    ctx.check("turn_end observed", turnEnd.length >= 1, `${turnEnd.length}`);

    // --- request the provider received --------------------------------------
    const sent = provider.lastRequest;
    ctx.check("fake provider was called with tools advertised", Array.isArray(sent?.body?.tools) && sent.body.tools.length > 0, `${sent?.body?.tools?.length ?? 0} tools`);
    const toolNames = (sent?.body?.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    ctx.note("advertisedTools", toolNames);
    ctx.note("toolCallCount", provider.requests.length);

    writeFixture("e02-turn-events.json", {
      note: "real capture, sanitized; local fake provider, approval-mode=yolo for this experiment only",
      ready: sanitizeFrame(rpc.readyFrame),
      promptResponse: sanitizeFrame(promptResponse),
      eventTypes: [...new Set(rpc.frames.map((f) => f.type))],
      toolStart: toolStart.slice(0, 2).map(sanitizeFrame),
      toolEnd: toolEnd.slice(0, 2).map(sanitizeFrame),
      turnEnd: turnEnd.slice(0, 1).map(sanitizeFrame),
      agentEnd: agentEnd ? sanitizeFrame(agentEnd) : null,
    });

    ctx.limit("The scripted model is local; no paid provider is contacted. Tool approval is bypassed here via --approval-mode yolo and is covered by E04.");
  } finally {
    if (rpc) ctx.check("process group reaped", (await rpc.stop()) === true);
  }
});

process.exit(evidence.ok ? 0 : 1);
