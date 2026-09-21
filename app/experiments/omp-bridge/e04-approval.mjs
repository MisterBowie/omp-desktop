#!/usr/bin/env node
/**
 * E04 — pre-execution approval for real native tools (disk + process evidence).
 *
 * A gate extension blocks `write`/`bash` through the OMP `tool_call` hook and a
 * real UI decision. The experiment asserts:
 *   - on DENY: no file is created and no command process ever ran;
 *   - on ALLOW: the tool runs and its side effect happens exactly once;
 *   - the gate sees the real tool name and target before execution.
 *
 * Usage: node e04-approval.mjs [--keep-artifacts]
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const EXTENSION = join(EXPERIMENT_ROOT, "extensions", "approval-gate.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driveUi(rpc, respond, stop, timeoutMs = 45_000) {
  const seen = new Set();
  const handled = [];
  const start = Date.now();
  for (;;) {
    for (const frame of rpc.frames) {
      if (frame.type !== "extension_ui_request" || seen.has(frame.id)) continue;
      if (frame.method !== "select" && frame.method !== "confirm" && frame.method !== "input") {
        seen.add(frame.id); // non-dialog UI updates need no answer
        continue;
      }
      seen.add(frame.id);
      const response = respond(frame);
      if (response) rpc.respondUi(frame.id, response);
      handled.push({ id: frame.id, method: frame.method, title: frame.title, response: response ?? null });
    }
    if (stop()) break;
    if (Date.now() - start > timeoutMs) break;
    await sleep(40);
  }
  return handled;
}

function readLog(path) {
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

const evidence = await runExperiment("e04-approval", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const runs = [
    { name: "deny-write", decision: "Deny", tool: "write" },
    { name: "allow-write", decision: "Allow", tool: "write" },
    { name: "deny-bash", decision: "Deny", tool: "bash" },
    { name: "allow-bash", decision: "Allow", tool: "bash" },
  ];

  for (const run of runs) {
    const { root, runRoot, selector } = experimentRoot(ctx, `e04-${run.name}`, { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const writeTarget = join(projectDir, "guarded.txt");
    const bashMarker = join(projectDir, "bash-ran.txt");

    // Each scenario is one prompt; a second turn closes the conversation.
    const toolCall =
      run.tool === "write"
        ? { name: "write", args: { path: writeTarget, content: "approved-once\n" } }
        : { name: "bash", args: { command: `printf 'ran\\n' >> ${bashMarker}` } };
    provider.script([
      { text: "attempting", toolCalls: [toolCall], finish: "tool_calls" },
      { text: "finished", finish: "stop" },
    ]);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", EXTENSION],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

      const promptPromise = rpc.request({ type: "prompt", message: `attempt ${run.tool}` }, { timeoutMs: 50_000 });
      const handled = await driveUi(rpc, () => ({ value: run.decision }), () => rpc.framesOfType("agent_end").length > 0);
      await promptPromise;

      ctx.check(`${run.name}: gate asked exactly once`, handled.length === 1, `${handled.length} dialogs`);
      const gateLog = readLog(uiLog);
      const gate = gateLog.find((l) => l.event === "gate");
      const decision = gateLog.find((l) => l.event === "gate-decision");
      ctx.check(`${run.name}: gate saw the real tool name`, gate?.toolName === run.tool, gate?.toolName);
      ctx.check(
        `${run.name}: gate saw the concrete target before execution`,
        typeof gate?.target === "string" && gate.target.includes(run.tool === "write" ? "guarded.txt" : "bash-ran.txt"),
        gate?.target,
      );
      ctx.check(`${run.name}: gate recorded the human decision`, decision?.decision === (run.decision === "Allow" ? "allow" : "deny"), decision?.decision);

      const wroteFile = existsSync(writeTarget);
      const bashLines = existsSync(bashMarker) ? readFileSync(bashMarker, "utf8").trim().split("\n").filter(Boolean) : [];

      if (run.decision === "Deny") {
        ctx.check(`${run.name}: no write side effect`, !wroteFile);
        ctx.check(`${run.name}: no bash side effect`, bashLines.length === 0, `${bashLines.length} marker lines`);
        const blocked = rpc.frames.find((f) => f.type === "tool_execution_end" && /denied/i.test(JSON.stringify(f)));
        ctx.check(`${run.name}: denial is reported back to the session`, Boolean(blocked), blocked ? "denied result observed" : "no denied result frame");
      } else {
        if (run.tool === "write") {
          ctx.check(`${run.name}: file created after approval`, wroteFile);
          ctx.check(`${run.name}: content written exactly once`, wroteFile && readFileSync(writeTarget, "utf8") === "approved-once\n");
        } else {
          ctx.check(`${run.name}: command ran after approval`, bashLines.length === 1, `${bashLines.length} marker lines`);
        }
      }

      if (run.name === "deny-write" || run.name === "allow-write") {
        writeFixture(`e04-${run.name}.json`, {
          note: "real capture, sanitized; local fake provider, gate answers are synthetic",
          gate: gate ?? null,
          decision: decision ?? null,
          dialogs: handled.map((h) => ({ method: h.method, title: h.title })),
          toolExecutionEnd: rpc.frames.filter((f) => f.type === "tool_execution_end").slice(0, 1),
        });
      }
    } finally {
      if (rpc) ctx.check(`${run.name}: process group reaped`, (await rpc.stop()) === true);
    }
  }

  ctx.limit("The gate is an experiment extension loaded with --extension; production wiring is M2. Model tool-call approval modes were not set to yolo for these runs.");
});

process.exit(evidence.ok ? 0 : 1);
