#!/usr/bin/env node
/**
 * E03 — extension interaction: select / confirm / input correlation, cancel, timeout.
 *
 * A probe extension asks the UI from inside a real `tool_call`; the experiment
 * answers `extension_ui_request` frames and asserts the extension observed the
 * answers, that correlation ids match, and that a cancelled or timed-out dialog
 * resolves without leaving a pending request.
 *
 * Usage: node e03-interaction.mjs [--keep-artifacts]
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const EXTENSION = join(EXPERIMENT_ROOT, "extensions", "ui-probe.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Watch for new extension_ui_request frames until `stop()` or the deadline.
 * `respond(frame)` returns a response object, or null to leave the dialog
 * unanswered (so OMP's own dialog timeout fires).
 */
async function driveUi(rpc, respond, stop, timeoutMs = 40_000) {
  const seen = new Set();
  const handled = [];
  const start = Date.now();
  for (;;) {
    for (const frame of rpc.frames) {
      if (frame.type !== "extension_ui_request" || seen.has(frame.id)) continue;
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

const evidence = await runExperiment("e03-interaction", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const scenarios = [
    {
      name: "all",
      respond: (f) => (f.method === "select" ? { value: "A" } : f.method === "confirm" ? { confirmed: true } : { value: "typed-value" }),
      expectInputs: ["select", "confirm", "input"],
      answerKey: "select",
    },
    { name: "cancel", respond: () => ({ cancelled: true }), expectInputs: ["select"], answerKey: "select" },
    { name: "timeout", respond: () => null, expectInputs: ["select"], answerKey: "select-timeout" },
  ];

  for (const scenario of scenarios) {
    const { root, runRoot, selector } = experimentRoot(ctx, `e03-${scenario.name}`, { baseUrl: provider.baseUrl });
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(root, "ui.log");
    const target = join(projectDir, `e03-${scenario.name}.txt`);

    provider.script([
      { text: "attempting", toolCalls: [{ name: "write", args: { path: target, content: "should not exist\n" } }], finish: "tool_calls" },
      { text: "stopped", finish: "stop" },
    ]);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", EXTENSION],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: uiLog, M1_UI_SCENARIO: scenario.name },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

      const promptPromise = rpc.request({ type: "prompt", message: `probe ${scenario.name}` }, { timeoutMs: 45_000 });
      const handled = await driveUi(rpc, scenario.respond, () => rpc.framesOfType("agent_end").length > 0);
      await promptPromise;

      const methods = handled.map((h) => h.method);
      ctx.check(`${scenario.name}: expected dialogs requested`, scenario.expectInputs.every((m) => methods.includes(m)), methods);
      ctx.check(`${scenario.name}: every request carries a correlation id`, handled.every((h) => typeof h.id === "string" && h.id.length > 0));
      ctx.check(`${scenario.name}: ids are unique per request`, new Set(handled.map((h) => h.id)).size === handled.length, `${handled.length} requests`);

      const logLines = existsSync(uiLog)
        ? readFileSync(uiLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      const answers = Object.fromEntries(logLines.filter((l) => l.asked).map((l) => [l.asked, l.answered]));
      ctx.note(`extensionSaw.${scenario.name}`, answers);

      if (scenario.name === "all") {
        ctx.check("extension observed the select answer", answers.select === "A", answers.select);
        ctx.check("extension observed the confirm answer", answers.confirm === true, answers.confirm);
        ctx.check("extension observed the input answer", answers.input === "typed-value", answers.input);
      } else {
        const observed = answers[scenario.answerKey];
        ctx.check(
          `${scenario.name}: extension resolved with no answer (${scenario.answerKey})`,
          observed === null,
          JSON.stringify(observed),
        );
      }

      ctx.check(`${scenario.name}: blocked tool produced no file`, !existsSync(target));
      ctx.check(
        `${scenario.name}: no pending dialog left behind`,
        rpc.framesOfType("extension_ui_request").length === handled.length,
        `${rpc.framesOfType("extension_ui_request").length} requests / ${handled.length} handled`,
      );

      if (scenario.name === "all") {
        writeFixture("e03-ui-exchange.json", {
          note: "real capture, sanitized; answers are the experiment's own synthetic values",
          requests: handled.map((h) => ({ id: h.id, method: h.method, title: h.title })),
          extensionObserved: answers,
        });
      }
    } finally {
      if (rpc) ctx.check(`${scenario.name}: process group reaped`, (await rpc.stop()) === true);
    }
  }

  ctx.limit("The timeout case relies on a dialog-level timeout supplied by the extension (800ms), not on client-side timing.");
});

process.exit(evidence.ok ? 0 : 1);
