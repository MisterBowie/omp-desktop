#!/usr/bin/env node
/** Actual installed Composer -> native tools -> real TypeScript LSP -> history. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InstalledApplication, until } from "./e2e/installed-application.mjs";
import { click, idle, inspect, invoke, prompt, reloadAndSelect, selectSession } from "./e2e/installed-workflow.mjs";
import { FakeProvider } from "../experiments/omp-bridge/lib/provider.mjs";
import { sha256OfFile } from "./stage-test-package.mjs";

const [installer, output, server] = process.argv.slice(2);
assert(installer && output && server, "usage: e2e-installed-lsp.mjs <installer> <evidence-directory> <typescript-language-server-cli.mjs>");
const evidenceDirectory = resolve(output);
mkdirSync(evidenceDirectory, { recursive: true });
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), checks: [],
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  installer: { path: resolve(installer), bytes: statSync(installer).size, sha256: sha256OfFile(installer) },
};
const provider = await FakeProvider.start();
let application;
let failure;
try {
  application = InstalledApplication.prepare(resolve(installer), evidenceDirectory);
  report.payload = application.payload;
  const project = application.workspace;
  mkdirSync(join(project, ".omp"));
  writeFileSync(join(project, "package.json"), '{"private":true}\n');
  writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true}}\n');
  writeFileSync(join(project, "existing.ts"), "export const editedValue: number = 42;\n");
  writeFileSync(join(project, "usage.ts"), 'import { editedValue } from "./existing";\nconsole.log(editedValue);\n');
  writeFileSync(join(project, ".omp/lsp.json"), JSON.stringify({ servers: {
    "typescript-language-server": { command: process.execPath, args: [resolve(server), "--stdio"], rootMarkers: ["tsconfig.json"] },
  } }));
  await application.start();
  report.identity = application.identity;
  await invoke(application, "projectSet", [project]);
  const createdProvider = await invoke(application, "providersCreate", [{
    name: "Installed LSP loopback fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "local-model", secretValue: "lsp-fixture-key", apiStyle: "chat_completions",
  }]);
  const created = await invoke(application, "sessionCreate", [{
    title: "Real LSP coding", mode: "agent", engine: "omp", projectPath: project, providerId: createdProvider.provider.id, modelId: "local-model",
  }]);
  const sessionId = created.session.id;
  report.sessionId = sessionId;
  await invoke(application, "sessionConfigure", [sessionId, { mode: "agent", permissionMode: "ask" }]);
  await reloadAndSelect(application, sessionId);
  async function step(marker, toolCalls, { approval = false } = {}) {
    provider.script([...toolCalls.map((call) => ({ toolCalls: [call], finish: "tool_calls" })), { text: marker, finish: "stop" }]);
    await prompt(application, marker);
    if (approval) {
      await until(async () => (await inspect(application)).permission, "actual coding approval");
      await click(application, ".permission-card-actions button:last-child");
    }
    await idle(application, sessionId, marker);
  }
  async function revealTools() {
    await application.renderer.evaluate(`(() => {
      for (const node of document.querySelectorAll('.tool-activity-header[aria-expanded="false"]')) node.click();
    })()`);
    await until(() => application.renderer.evaluate('document.querySelectorAll(".tool-row-header").length > 0'), "actual tool rows");
    await application.renderer.evaluate(`(() => {
      for (const node of document.querySelectorAll('.tool-row-header[aria-expanded="false"]:not(:disabled)')) node.click();
    })()`);
  }
  await step("LSP_WRITE_COMPLETE", [{ name: "write", args: { path: "written.ts", content: 'export const writtenValue: number = "wrong";\n' } }], { approval: true });
  await revealTools();
  await until(async () => (await inspect(application)).text.includes("2322"), "visible real write diagnostic");
  assert.match((await inspect(application)).text, /not assignable to type/);
  await application.screenshot("01-write-lsp-diagnostic");
  report.checks.push("real installed Composer write displays TypeScript 2322 after allow-once");

  await step("LSP_READ_COMPLETE", [{ name: "read", args: { path: "existing.ts" } }]);
  const modelMessages = provider.requests.at(-1).body.messages;
  const read = modelMessages.findLast((message) => message.role === "tool" && String(message.content).includes("existing.ts#"));
  const header = String(read?.content).match(/\[([^\]\n]*existing\.ts#[0-9a-fA-F]{4})\]/);
  assert(header, "the actual default hashline read must supply an edit snapshot");
  await step("LSP_EDIT_COMPLETE", [{ name: "edit", args: {
    input: `*** Begin Patch\n[${header[1]}]\nPUT 1.=1:\n+export const editedValue: number = "wrong";\n*** End Patch`,
  } }], { approval: true });
  assert.match(readFileSync(join(project, "existing.ts"), "utf8"), /"wrong"/);
  const saved = (await invoke(application, "sessionGet", [sessionId])).session;
  const edited = saved.messages.findLast((message) => message.toolName === "edit");
  assert.match(JSON.stringify(edited), /2322/, "the actual edit row must contain fresh compiler findings");
  await revealTools();
  await until(async () => (await inspect(application)).text.includes("editedValue") && (await inspect(application)).text.includes("2322"), "visible real edit diagnostic");
  await application.screenshot("02-edit-lsp-diagnostic");
  report.checks.push("real default hashline edit returns and displays TypeScript 2322");

  await step("LSP_DEFINITION_COMPLETE", [
    { name: "read", args: { path: "xd://lsp" } },
    { name: "lsp", args: { action: "definition", file: "usage.ts", line: 2, symbol: "editedValue" } },
  ]);
  const completed = (await invoke(application, "sessionGet", [sessionId])).session;
  const definition = completed.messages.findLast((message) => message.toolName === "lsp");
  assert.match(JSON.stringify(definition), /existing\.ts/);
  await revealTools();
  await application.screenshot("03-lsp-definition");
  report.checks.push("native deferred LSP discovery resolves the imported definition across files");
  const posts = provider.requests.filter((request) => request.method === "POST").length;
  assert.equal(posts, 9, "four requested prompts must not spawn an extra idle diagnostic model continuation");
  writeFileSync(join(evidenceDirectory, "messages-before-restart.json"), JSON.stringify(completed.messages, null, 2));
  await application.quit();
  await application.start();
  await selectSession(application, sessionId);
  const recovered = (await invoke(application, "sessionGet", [sessionId])).session;
  assert.deepEqual(recovered.messages, completed.messages);
  assert.equal(provider.requests.filter((request) => request.method === "POST").length, posts, "history reads must not replay model or LSP work");
  await revealTools();
  await until(async () => (await inspect(application)).text.includes("2322"), "recovered visible compiler diagnostic");
  await application.screenshot("04-recovered-lsp-history");
  report.checks.push("restart preserves compiler results and semantic navigation without model/tool replay");
  await application.quit();
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
  if (application?.renderer) {
    try { report.failureUi = await inspect(application); await application.screenshot("failure"); }
    catch (captureError) { report.captureFailure = String(captureError); }
  }
} finally {
  if (application) {
    try { await application.cleanup(); report.cleaned = true; }
    catch (error) { failure ??= error; report.cleanupFailure = error.stack ?? String(error); }
    report.launches = application.launches;
    report.processReports = application.reports;
    writeFileSync(join(evidenceDirectory, "application-output.txt"), application.output);
    if (application.clean) application.removeOwnedRoot();
  }
  await provider.close();
  writeFileSync(join(evidenceDirectory, "provider-requests.json"), JSON.stringify(provider.requests, null, 2));
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(evidenceDirectory, "installed-lsp.json"), JSON.stringify(report, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: report.checks, cleaned: report.cleaned }));
