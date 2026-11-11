#!/usr/bin/env node
// Temporary probe (not committed): drive the packaged OMP Desktop window through
// the OMP `ask` card with a typed answer. Isolated HOME/profile from the
// installed-smoke harness; the model is the loopback FakeProvider.
//
//   node ask-window-check.mjs <app-root> <installer.dmg> <evidence-dir>
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [appRoot, installer, evidence] = process.argv.slice(2);
assert(appRoot && installer && evidence, "usage: ask-window-check.mjs <app-root> <installer> <evidence-dir>");
const { FakeProvider } = await import(join(appRoot, "experiments/omp-bridge/lib/provider.mjs"));
const { InstalledApplication, until } = await import(join(appRoot, "scripts/e2e/installed-application.mjs"));
const { click, idle, invoke, prompt, reloadAndSelect } = await import(join(appRoot, "scripts/e2e/installed-workflow.mjs"));

const out = resolve(evidence);
mkdirSync(out, { recursive: true });
const PROJECT_ROOT = "/Users/Shared/omp-ask-check";
const PROJECT = join(PROJECT_ROOT, "家政");
const TYPED = "从 Mac 通过局域网把文件传到另一台 Windows 电脑";
const REPLY = "收到你的回答，下面按这个场景给出步骤。";
const electron = `process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron")`;
const report = { typed: TYPED };

async function card(application) {
  return application.renderer.evaluate(`(() => {
    const card = document.querySelector(".asktool-card");
    if (!card || !card.getBoundingClientRect().height) return null;
    return {
      question: card.querySelector(".asktool-question")?.innerText ?? null,
      options: [...card.querySelectorAll(".asktool-option:not(.asktool-custom-option)")].map((n) => n.innerText.trim()),
      custom: card.querySelector(".asktool-custom-option")?.innerText.trim() ?? null,
      input: Boolean(card.querySelector(".asktool-custom-input")),
      inputValue: card.querySelector(".asktool-custom-input")?.value ?? null,
    };
  })()`);
}

let application;
let provider;
try {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, "README.md"), "# 家政\n");
  provider = await FakeProvider.start({ model: "demo-model" });
  application = InstalledApplication.prepare(resolve(installer), out);
  mkdirSync(join(application.home, ".bun", "bin"), { recursive: true });
  copyFileSync(process.execPath, join(application.home, ".bun", "bin", "node"));
  await application.start();
  report.isolatedHome = application.home;
  report.dataRoot = application.data;
  await application.main.evaluate(`(() => {
    const { BrowserWindow } = ${electron};
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    window.setContentSize(1280, 820); window.center(); return true;
  })()`, "Main", { awaitPromise: false });

  const settings = await invoke(application, "settingsGet");
  await invoke(application, "settingsSet", [{ ...settings, theme: "dark", language: "zh-CN", onboardingDismissed: true }]);
  const createdProvider = await invoke(application, "providersCreate", [{
    name: "Fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "demo-model",
    secretValue: "fixture-key", apiStyle: "chat_completions",
  }]);
  const providerId = createdProvider.provider?.id;
  assert(providerId, "fixture provider was not created");
  await invoke(application, "projectSet", [PROJECT]);
  const created = await invoke(application, "sessionCreate", [{ title: "Windows 应用传文件方法", mode: "agent", engine: "omp", projectPath: PROJECT, providerId, modelId: "demo-model" }]);
  const sessionId = created.session?.id;
  assert(sessionId, "session was not created");
  await invoke(application, "sessionConfigure", [sessionId, { mode: "agent", permissionMode: "ask" }]);
  report.sessionId = sessionId;

  provider.script([
    {
      finish: "tool_calls", delayMs: 400,
      toolCalls: [{
        id: "call_ask", name: "ask",
        args: {
          questions: [{
            id: "scenario",
            question: "「Windows app 传文件」具体指哪种场景？",
            options: [
              { label: "Mac → Windows 电脑传文件", description: "局域网共享、云盘、scp/SFTP" },
              { label: "给 Windows 上的某个程序喂文件", description: "拖拽、命令行参数、剪贴板" },
            ],
            recommended: 0,
          }],
        },
      }],
    },
    { text: REPLY, finish: "stop", delayMs: 300 },
  ]);

  await reloadAndSelect(application, sessionId);
  await prompt(application, "和项目无关 windows app 如何传文件？");
  await until(async () => Boolean(await card(application)), "ask card shown");
  report.cardShown = await card(application);
  await application.screenshot("1-ask-card");

  await click(application, ".asktool-custom-option");
  await until(async () => (await card(application))?.input === true, "typed-answer field shown");
  await application.renderer.evaluate(`document.querySelector(".asktool-custom-input").focus()`);
  await application.renderer.send("Input.insertText", { text: TYPED });
  await until(async () => (await card(application))?.inputValue === TYPED, "typed answer entered");
  await application.screenshot("2-typed-answer");
  await click(application, ".asktool-card-actions button:last-child");

  await idle(application, sessionId, REPLY);
  await delay(800);
  await application.screenshot("3-turn-completed");

  const posts = provider.requests.filter((entry) => entry.method === "POST" && String(entry.url).includes("chat/completions"));
  const toolMessage = (posts[1]?.body?.messages ?? []).find((message) => message?.role === "tool" && message.tool_call_id === "call_ask");
  report.providerChatRequests = posts.length;
  report.askToolResultSeenByModel = toolMessage ? (typeof toolMessage.content === "string" ? toolMessage.content : JSON.stringify(toolMessage.content)) : null;
  report.cardGone = (await card(application)) === null;
  report.ui = await application.renderer.evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-sidebar-session-row]")].find((n) => n.getAttribute("data-sidebar-session-row") === ${JSON.stringify(sessionId)});
    return {
      replyShown: document.body.innerText.includes(${JSON.stringify(REPLY)}),
      interruptedShown: /Interrupted by user|已中止|被中断/.test(document.body.innerText),
      errorCards: document.querySelectorAll(".chat-error-card, .error-card, [data-error-card]").length,
      sidebarRow: row ? { className: row.className, text: row.innerText } : null,
    };
  })()`);
  const status = (await invoke(application, "agentGetStatus", [sessionId])).status;
  report.status = { isRunning: status.isRunning, state: status.state ?? null };

  const sessionsDir = join(application.data, "omp-sessions");
  const file = readdirSync(sessionsDir).find((name) => name.endsWith(".jsonl"));
  const native = readFileSync(join(sessionsDir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  report.native = native
    .filter((entry) => entry.type === "message")
    .map((entry) => ({
      role: entry.message.role,
      tool: entry.message.toolName ?? null,
      isError: entry.message.isError ?? null,
      stopReason: entry.message.stopReason ?? null,
      text: (entry.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 200),
    }));

  assert.equal(report.cardShown.options.includes("Other (type your own)"), false, "runtime free-text option is not listed");
  assert.ok(report.cardShown.custom, "typed-answer row offered");
  assert.equal(report.providerChatRequests, 2, "the model was called again after the answer");
  assert.match(report.askToolResultSeenByModel ?? "", new RegExp(TYPED), "model received the typed answer");
  assert.equal(report.ui.replyShown, true);
  assert.equal(report.ui.interruptedShown, false);
  assert.equal(report.status.isRunning, false);
  assert.ok(!report.native.some((entry) => entry.stopReason === "aborted"), "no aborted assistant message");
  report.result = "pass";
  await application.quit();
} catch (error) {
  report.result = "fail";
  report.error = String(error?.stack ?? error);
  try { await application?.screenshot("failure"); } catch {}
  throw error;
} finally {
  writeFileSync(join(out, "ask-window-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (application) {
    try { await application.cleanup(); } finally { if (application.clean) application.removeOwnedRoot(); }
  }
  await provider?.close();
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
  console.log(JSON.stringify({ result: report.result, evidence: out }, null, 2));
}
