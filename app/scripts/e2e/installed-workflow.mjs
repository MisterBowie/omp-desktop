/** Real Composer/permission/stop/history paths; only the provider is a fixture. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FakeProvider } from "../../experiments/omp-bridge/lib/provider.mjs";
import { until } from "./installed-application.mjs";
import { digest } from "./installed-product.mjs";
import { installedFilesystemPath } from "./installed-paths.mjs";
import { readNativeProcessTable } from "./native-processes.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const write = (content) => ({ toolCalls: [{ name: "write", args: { path: "answer.mjs", content } }], finish: "tool_calls" });
const command = (value) => ({ toolCalls: [{ name: "bash", args: { command: value, timeout: 600 } }], finish: "tool_calls" });

async function invoke(application, channel, args = []) {
  const response = await application.renderer.evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(channel)}], ...${JSON.stringify(args)})`);
  assert(response?.ok, `${channel} failed: ${JSON.stringify(response)}`);
  return response.data;
}
async function click(application, selector) {
  const clicked = await application.renderer.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) return false; node.click(); return true; })()`);
  assert(clicked, `visible enabled control missing: ${selector}`);
}
async function inspect(application) {
  return application.renderer.evaluate(`(() => {
    const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height);
    const card = document.querySelector(".permission-card");
    return { text: document.body.innerText, permission: visible(card) ? card.innerText : null,
      stop: visible(document.querySelector(".composer-shell .stop-btn")),
      activeSessionId: document.querySelector('[data-sidebar-session-row][aria-current="page"], [data-sidebar-session-row].active')?.getAttribute("data-sidebar-session-row") };
  })()`);
}
async function selectSession(application, sessionId) {
  await until(async () => {
    return application.renderer.evaluate(`(() => {
      for (const toggle of document.querySelectorAll('[data-action="toggle-project-collapse"][aria-expanded="false"]')) toggle.click();
      const row = [...document.querySelectorAll("[data-sidebar-session-row]")].find(n => n.getAttribute("data-sidebar-session-row") === ${JSON.stringify(sessionId)});
      if (!row) return false;
      row.querySelector("button.thread-item-main")?.click();
      return true;
    })()`);
  }, "actual sidebar session row");
  await until(async () => (await inspect(application)).activeSessionId === sessionId, "selected installed OMP session");
}
async function reloadAndSelect(application, sessionId) {
  await application.renderer.send("Page.reload");
  await until(() => application.renderer.evaluate('Boolean(document.querySelector(".app-shell:not(.is-booting) .composer-input"))'), "reloaded composer");
  await selectSession(application, sessionId);
}
async function prompt(application, text) {
  assert(await application.renderer.evaluate(`(() => {
    const input = document.querySelector(".composer-input");
    if (!input || input.getAttribute("contenteditable") === "false") return false;
    input.focus(); input.textContent = ${JSON.stringify(text)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    input.dispatchEvent(new Event("change", { bubbles: true })); return true;
  })()`), "editable live Composer missing");
  await until(() => application.renderer.evaluate('document.querySelector(".composer-shell .send-btn")?.disabled === false'), "Composer Send enabled");
  await click(application, ".composer-shell .send-btn");
}
async function idle(application, sessionId, expectedText) {
  return until(async () => {
    const status = (await invoke(application, "agentGetStatus", [sessionId])).status;
    const ui = await inspect(application);
    return !status.isRunning && !ui.stop && !ui.permission && (!expectedText || ui.text.includes(expectedText)) ? ui : false;
  }, `turn completed: ${expectedText || "stopped"}`);
}
function nativeFacts(session, dataRoot) {
  assert.equal(session.engine, "omp");
  // The native reference is intentionally absent from renderer IPC. Like the
  // existing M5 harness, observe only this fixture's DB through a read-only
  // external connection; never add an application IPC surface for the test.
  const database = new DatabaseSync(join(dataRoot, "pi.sqlite"), { readOnly: true });
  let reference;
  try { reference = database.prepare("SELECT engine_runtime_version, native_session_id, native_session_path FROM sessions WHERE id = ?").get(session.id); }
  finally { database.close(); }
  assert.equal(reference?.engine_runtime_version, "18.3.0");
  const file = reference.native_session_path;
  assert(file && existsSync(file), "real native transcript missing");
  const part = relative(dataRoot, file);
  assert(part && !part.startsWith("..") && !isAbsolute(part), "native transcript escaped the installed data root");
  const bytes = readFileSync(file);
  const entries = bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  const tools = entries.flatMap(entry => (entry.message?.content ?? []).filter?.(block => block.type === "toolCall") ?? []);
  const writeCalls = tools.filter(tool => tool.name === "write");
  assert.equal(writeCalls.length, 2, "the two requested writes must each appear once in the native transcript");
  assert.equal(new Set(writeCalls.map(tool => tool.id)).size, 2, "write tool call IDs repeated");
  const results = entries.map(entry => entry.message).filter(message => message?.role === "toolResult" && writeCalls.some(tool => tool.id === message.toolCallId));
  assert.equal(results.length, 2, "native write results were duplicated or lost");
  assert.equal(results.filter(result => result.isError).length, 1, "one denied write must fail and the one approved write must succeed");
  return { file, bytes: bytes.length, sha256: digest(bytes), messages: session.messages, writeCalls: writeCalls.map(tool => ({ id: tool.id, name: tool.name })), writeResults: results.map(result => ({ toolCallId: result.toolCallId, isError: result.isError })) };
}

export async function exerciseInstalledWorkflow(application) {
  const provider = await FakeProvider.start();
  const facts = { externalBoundary: "loopback FakeProvider only", nativeFolderChooserCovered: false, checks: [], steps: {} };
  try {
    const project = application.workspace;
    const tools = join(application.root, "project-tools"); mkdirSync(tools);
    const node = join(tools, process.platform === "win32" ? "project-node.exe" : "project-node");
    copyFileSync(process.execPath, node);
    const answer = join(project, "answer.mjs");
    const broken = "export const answer = () => 41;\n";
    const fixed = "export const answer = () => 42;\n";
    writeFileSync(answer, broken);
    const testResult = join(project, "test-result.json");
    writeFileSync(join(project, "check.mjs"), `import assert from "node:assert/strict"; import {writeFileSync} from "node:fs"; import {homedir} from "node:os"; import {answer} from "./answer.mjs"; assert.equal(answer(),42); writeFileSync(${JSON.stringify(testResult)},JSON.stringify({answer:answer(),cwd:process.cwd(),home:homedir(),PATH:process.env.PATH,USERPROFILE:process.env.USERPROFILE??null})); console.log("INSTALLED_PROJECT_TEST_PASSED");\n`);
    const pidFile = join(project, "long-processes.jsonl");
    const longScript = join(project, "long-tree.mjs");
    writeFileSync(longScript, `import {spawn} from "node:child_process"; import {appendFileSync} from "node:fs"; const level=Number(process.argv[2]||0); appendFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,ppid:process.ppid,level})+"\\n"); if(level<2) spawn(process.execPath,[import.meta.filename,String(level+1)],{stdio:"ignore"}); setInterval(()=>{},1000);\n`);
    provider.routeBySession({ parent: [{ text: "unexpected installed prompt", finish: "stop" }], subagents: [
      { marker: "INSTALLED_DENY", turns: [write(fixed), { text: "INSTALLED_DENIED_DONE", finish: "stop" }] },
      { marker: "INSTALLED_ALLOW", turns: [write(fixed), { text: "INSTALLED_ALLOWED_DONE", finish: "stop" }] },
      { marker: "INSTALLED_TEST", turns: [command(`${quote(node)} ${quote(join(project, "check.mjs"))}`), { text: "INSTALLED_TEST_DONE", finish: "stop" }] },
      { marker: "INSTALLED_STOP", turns: [command(`${quote(node)} ${quote(longScript)}`), { text: "SHOULD_NOT_CONTINUE_AFTER_STOP", finish: "stop" }] },
      { marker: "INSTALLED_RESTART", turns: [{ text: "INSTALLED_RESTART_DONE", finish: "stop" }] },
    ] });
    const opened = await invoke(application, "projectSet", [project]);
    assert.equal(installedFilesystemPath(opened.workspace?.path), installedFilesystemPath(project));
    const createdProvider = await invoke(application, "providersCreate", [{
      name: "Installed loopback fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "local-model",
      secretValue: "installed-fixture-key", apiStyle: "chat_completions",
    }]);
    assert(createdProvider.provider?.id);
    const created = await invoke(application, "sessionCreate", [{ title: "Installed project workflow", mode: "agent", engine: "omp", projectPath: project, providerId: createdProvider.provider.id, modelId: "local-model" }]);
    const sessionId = created.session?.id; assert(sessionId);
    await invoke(application, "sessionConfigure", [sessionId, { mode: "agent", permissionMode: "ask" }]);
    await reloadAndSelect(application, sessionId);
    facts.sessionId = sessionId;
    facts.checks.push("project and OMP session created through public preload IPC, selected through sidebar");
    facts.steps.project = true;
    application.progress("installed deny");
    await prompt(application, "INSTALLED_DENY Fix answer.mjs to return 42.");
    await until(async () => (await inspect(application)).permission, "real write approval before side effect");
    assert.equal(readFileSync(answer, "utf8"), broken);
    await application.screenshot("02-deny-pending");
    await click(application, ".permission-card-actions button:first-child");
    await idle(application, sessionId, "INSTALLED_DENIED_DONE");
    assert.equal(readFileSync(answer, "utf8"), broken);
    facts.checks.push("denied write preserved exact original bytes");
    facts.steps.deny = true;

    application.progress("installed allow once");
    await prompt(application, "INSTALLED_ALLOW Fix answer.mjs to return 42.");
    await until(async () => (await inspect(application)).permission, "second real write approval");
    assert.equal(readFileSync(answer, "utf8"), broken);
    await click(application, ".permission-card-actions button:last-child");
    await idle(application, sessionId, "INSTALLED_ALLOWED_DONE");
    assert.equal(readFileSync(answer, "utf8"), fixed);
    facts.checks.push("allow-once performed the real write after approval");
    facts.steps.allowOnce = true;
    await application.screenshot("03-approved-write");

    application.progress("installed project test");
    await prompt(application, "INSTALLED_TEST Run the project check.");
    await until(async () => (await inspect(application)).permission, "fresh bash permission after allow-once");
    assert(!existsSync(testResult));
    await click(application, ".permission-card-actions button:last-child");
    await idle(application, sessionId, "INSTALLED_TEST_DONE");
    const checked = JSON.parse(readFileSync(testResult, "utf8"));
    assert.equal(checked.answer, 42); assert.equal(checked.cwd, project);
    assert(checked.home.startsWith(application.data), "OMP tool home escaped the installed data root");
    assert(provider.requests.some(r => (r.body?.messages ?? []).some(m => m.role === "tool" && JSON.stringify(m).includes("INSTALLED_PROJECT_TEST_PASSED"))));
    facts.projectTest = checked;
    facts.checks.push("real project executable passed and its tool result reached the provider");
    facts.steps.projectTest = true;

    application.progress("installed process stop");
    await prompt(application, "INSTALLED_STOP Start the long process tree.");
    await until(async () => (await inspect(application)).permission, "long tool permission");
    await click(application, ".permission-card-actions button:last-child");
    const tree = await until(() => {
      if (!existsSync(pidFile)) return false;
      const rows = readFileSync(pidFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      return rows.length === 3 ? rows : false;
    }, "actual external child and grandchild");
    const running = application.snapshot("long-tool-running");
    facts.longTree = tree.map(row => {
      const identity = running.processes.find(p => p.pid === row.pid);
      assert(identity?.starttime && identity.exe === node, "long process was not actually observed as owned");
      return { ...row, starttime: identity.starttime, exe: identity.exe };
    });
    assert.equal((await invoke(application, "agentGetStatus", [sessionId])).status.isRunning, true);
    await application.screenshot("04-long-tool-before-stop");
    await click(application, ".composer-shell .stop-btn");
    await idle(application, sessionId);
    await until(() => {
      const table = readNativeProcessTable();
      return facts.longTree.every(p => table.get(p.pid)?.starttime !== p.starttime);
    }, "real tool child tree reaped after Stop");
    facts.checks.push("Composer Stop ended the running turn and reaped all three observed external processes");
    facts.steps.stopTree = true;
    await application.screenshot("05-stopped");

    const sessionBefore = (await invoke(application, "sessionGet", [sessionId])).session;
    const before = nativeFacts(sessionBefore, application.data);
    facts.beforeRestart = before;
    writeFileSync(join(application.evidenceDirectory, "native-before-quit.jsonl"), readFileSync(before.file));
    const requestCount = provider.requests.filter(r => r.method === "POST").length;
    await application.quit();
    facts.afterQuit = nativeFacts(sessionBefore, application.data);
    const beforeBytes = readFileSync(join(application.evidenceDirectory, "native-before-quit.jsonl"));
    const closedBytes = readFileSync(before.file);
    assert(closedBytes.subarray(0, beforeBytes.length).equals(beforeBytes), "ordered quit changed an existing native record");
    const exitRecords = closedBytes.subarray(beforeBytes.length).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert(exitRecords.every(record => record.type === "custom" && record.customType === "session_exit"), "ordered quit appended an unexpected tool/model record");
    facts.exitRecords = exitRecords;
    writeFileSync(join(application.evidenceDirectory, "native-after-quit.jsonl"), closedBytes);
    application.progress("restart same installed payload/profile");
    await application.start();
    await selectSession(application, sessionId);
    const after = nativeFacts((await invoke(application, "sessionGet", [sessionId])).session, application.data);
    facts.afterRestart = after;
    writeFileSync(join(application.evidenceDirectory, "native-after-restart.jsonl"), readFileSync(after.file));
    assert.equal(after.sha256, facts.afterQuit.sha256, "restart/history read rewrote the closed native transcript");
    assert.deepEqual(after.messages, before.messages, "restart/history projection changed messages");
    assert.equal(provider.requests.filter(r => r.method === "POST").length, requestCount, "restart replayed a model request");
    assert.equal(readFileSync(answer, "utf8"), fixed);
    assert.equal(readFileSync(pidFile, "utf8").trim().split("\n").length, 3, "restart replayed the stopped process");
    facts.checks.push("same installed profile recovered identical native history without model/tool replay");
    facts.steps.recoveryNoReplay = true;
    await application.screenshot("06-recovered-history");
    await prompt(application, "INSTALLED_RESTART Reply after the restart.");
    await idle(application, sessionId, "INSTALLED_RESTART_DONE");
    facts.checks.push("a fresh turn completed after recovery");
    facts.steps.freshTurn = true;
    await application.screenshot("07-post-restart-turn");
    facts.providerRequests = provider.requests.map(request => ({
      method: request.method, url: request.url, at: request.at, model: request.body?.model ?? null,
      messages: request.body?.messages?.filter(message => !["system", "developer"].includes(message.role)) ?? [],
    }));
    assert(!JSON.stringify(provider.requests).includes("OMP_E2E_IGNORED_HOME_SENTINEL"), "the runtime imported another application's HOME configuration");
    facts.isolation = application.verifySentinels();
    facts.checks.push("default .omp-desktop data root selected without a data override; existing PI/OMP fixtures unchanged and not imported");
    facts.steps.defaultIsolation = true;
    return facts;
  } finally {
    // Preserve only this synthetic fixture's traffic, never a real credential.
    writeFileSync(join(application.evidenceDirectory, "workflow-facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
    await provider.close();
  }
}
