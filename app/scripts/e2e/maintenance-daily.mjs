/** Actual installed coding, concurrent projects, long history and HTTP recovery. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FakeProvider } from "../../experiments/omp-bridge/lib/provider.mjs";
import { until } from "./installed-application.mjs";
import { installedFilesystemPath } from "./installed-paths.mjs";
import { invoke, click, inspect, selectSession, reloadAndSelect, prompt, idle } from "./installed-workflow.mjs";
import { readMaintenanceHistory, assertClosedHistory } from "./maintenance-history.mjs";
import { startMaintenanceProvider } from "./maintenance-provider.mjs";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tool = (name, args) => ({ toolCalls: [{ name, args }], finish: "tool_calls" });
const reply = text => ({ text, finish: "stop" });
const postCount = provider => provider.requests.filter(row => row.method === "POST").length;
const electron = 'process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron")';
const fixed = `export function totalCents(items, discountBps = 0) {
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10000) throw new RangeError("discount");
  const subtotal = items.reduce((sum, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 0 || !Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) throw new RangeError("item");
    return sum + item.quantity * item.unitPriceCents;
  }, 0);
  return Math.round(subtotal * (10000 - discountBps) / 10000);
}
`;

async function metrics(application, label, facts) {
  const observation = await application.main.evaluate(`${electron}.app.getAppMetrics()`, "Main", { awaitPromise: false });
  assert(observation.length > 0 && observation.every(row => row.pid > 0 && row.memory?.workingSetSize >= 0));
  facts.resources.push({ label, at: Date.now(), scope: "Electron app.getAppMetrics processes; not whole-system peak RSS", processes: observation });
}
async function session(application, project, title, providerId) {
  await invoke(application, "projectGroupCreate", [{ name: title, folders: [project] }]);
  await invoke(application, "projectSet", [project]);
  const created = await invoke(application, "sessionCreate", [{ title, mode: "agent", engine: "omp", projectPath: project, providerId, modelId: "local-model" }]);
  assert(created.session?.id);
  await invoke(application, "sessionConfigure", [created.session.id, { mode: "agent", permissionMode: "ask" }]);
  // Boot each public-IPC-prepared project once so the normal renderer retains
  // its sidebar tab before another project becomes current.
  await reloadAndSelect(application, created.session.id);
  return created.session.id;
}
async function approve(application) {
  await until(async () => (await inspect(application)).permission, "actual tool approval");
  await click(application, ".permission-card-actions button:last-child");
}
async function getSession(application, id) { return (await invoke(application, "sessionGet", [id])).session; }

export async function exerciseMaintenanceDaily(application) {
  const provider = await FakeProvider.start();
  const proxy = await startMaintenanceProvider(provider.baseUrl);
  const facts = { externalBoundary: "loopback FakeProvider only", steps: {}, resources: [], timings: [], longTurns: 40 };
  const save = () => writeFileSync(join(application.evidenceDirectory, "maintenance-daily.json"), `${JSON.stringify(facts, null, 2)}\n`);
  try {
    const a = application.workspace;
    const b = join(application.root, "second project 中文 'quoted'"); mkdirSync(b);
    const tools = join(application.root, "daily-project-tools"); mkdirSync(tools);
    const node = join(tools, process.platform === "win32" ? "project-node.exe" : "project-node"); copyFileSync(process.execPath, node);
    writeFileSync(join(a, "invoice.mjs"), "export const totalCents = () => 0;\n");
    writeFileSync(join(a, "invoice.test.mjs"), `import assert from "node:assert/strict"; import {totalCents} from "./invoice.mjs";
const items=[{quantity:3,unitPriceCents:199},{quantity:2,unitPriceCents:250}];
assert.equal(totalCents(items),1097);assert.equal(totalCents(items,1000),987);assert.equal(totalCents([],500),0);
assert.equal(totalCents(items,10000),0);assert.throws(()=>totalCents(items,-1),RangeError);
assert.throws(()=>totalCents([{quantity:-1,unitPriceCents:10}]),RangeError);assert.throws(()=>totalCents([{quantity:1,unitPriceCents:1.5}]),RangeError);
console.log("M7_INVOICE_7_ASSERTIONS_PASSED");\n`);
    let initialFailure;
    try { execFileSync(node, [join(a, "invoice.test.mjs")], { cwd: a, encoding: "utf8", stdio: "pipe" }); }
    catch (error) { initialFailure = { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }; }
    assert.equal(initialFailure?.status, 1, "sample must really fail before the agent fixes it"); facts.initialProjectFailure = initialFailure;
    for (const [directory, name] of [[a, "a"], [b, "b"]]) {
      writeFileSync(join(directory, "hold.mjs"), `import {existsSync,writeFileSync} from "node:fs";writeFileSync("started-${name}.json",JSON.stringify({pid:process.pid,cwd:process.cwd()}));const deadline=Date.now()+180000;const timer=setInterval(()=>{if(existsSync("release-${name}")){clearInterval(timer);console.log("M7_RELEASED_${name.toUpperCase()}")}else if(Date.now()>deadline){clearInterval(timer);process.exitCode=2}},100);\n`);
    }
    provider.routeBySession({ parent: [reply("M7_UNEXPECTED_PROMPT")], subagents: [
      { marker: "M7_CODING", turns: [tool("read", { path: "invoice.mjs" }), tool("write", { path: "invoice.mjs", content: fixed }), tool("bash", { command: `${quote(node)} invoice.test.mjs`, timeout: 60 }), reply("M7_CODING_DONE")] },
      ...["A", "B"].map(name => ({ marker: `M7_CONCURRENT_${name}`, turns: [tool("bash", { command: `${quote(node)} hold.mjs`, timeout: 240 }), tool("write", { path: `background-${name.toLowerCase()}.txt`, content: `M7_OWN_PROJECT_${name}\n` }), reply(`M7_CONCURRENT_${name}_DONE`)] })),
      ...Array.from({ length: 40 }, (_, index) => ({ marker: `M7_LONG_${String(index + 1).padStart(2, "0")}`, turns: [reply(`M7_LONG_REPLY_${String(index + 1).padStart(2, "0")}`)] })),
      { marker: "M7_HTTP_RECOVER", turns: [reply("M7_HTTP_RECOVERED")] },
      { marker: "M7_AUTH_FAIL", turns: [reply("M7_UNEXPECTED_AUTH_SUCCESS")] },
      { marker: "M7_AFTER_AUTH", turns: [reply("M7_AFTER_AUTH_RECOVERED")] },
      { marker: "M7_AFTER_REOPEN", turns: [reply("M7_AFTER_REOPEN_DONE")] },
    ] });
    const created = await invoke(application, "providersCreate", [{ name: "M7 local HTTP boundary", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", baseUrl: proxy.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "local-model", secretValue: "m7-loopback-fixture-key", apiStyle: "chat_completions" }]);
    const providerId = created.provider?.id; assert(providerId);
    application.progress("M7 create registered project sessions");
    const sessionA = await session(application, a, "M7 invoice and long conversation", providerId);
    const sessionB = await session(application, b, "M7 concurrent second project", providerId);
    facts.sessions = { a: sessionA, b: sessionB }; facts.projects = { a, b };
    await reloadAndSelect(application, sessionA);
    await metrics(application, "ready", facts);
    application.progress("M7 real coding task");
    await prompt(application, "M7_CODING Read invoice.mjs, implement integer-cent invoice totals and basis-point discounts with validation, then run invoice.test.mjs.");
    await until(async () => (await inspect(application)).permission, "invoice write waits for approval");
    assert.equal(readFileSync(join(a, "invoice.mjs"), "utf8"), "export const totalCents = () => 0;\n");
    await click(application, ".permission-card-actions button:last-child");
    await approve(application);
    await idle(application, sessionA, "M7_CODING_DONE");
    assert.equal(readFileSync(join(a, "invoice.mjs"), "utf8"), fixed);
    facts.projectCheck = execFileSync(node, [join(a, "invoice.test.mjs")], { cwd: a, encoding: "utf8" });
    assert(facts.projectCheck.includes("M7_INVOICE_7_ASSERTIONS_PASSED"));
    assert(provider.requests.some(row => row.body?.messages?.some(m => m.role === "tool" && JSON.stringify(m).includes("M7_INVOICE_7_ASSERTIONS_PASSED"))));
    facts.steps.coding = true; await application.screenshot("m7-01-coding"); save();

    application.progress("M7 concurrent projects");
    for (const id of [sessionA, sessionB]) await invoke(application, "sessionConfigure", [id, { mode: "agent", permissionMode: "auto" }]);
    await prompt(application, "M7_CONCURRENT_A Hold until release-a, then write background-a.txt in this project.");
    await until(() => existsSync(join(a, "started-a.json")), "project A external tool running");
    await invoke(application, "projectSet", [b]); await selectSession(application, sessionB);
    await prompt(application, "M7_CONCURRENT_B Hold until release-b, then write background-b.txt in this project.");
    await until(() => existsSync(join(b, "started-b.json")), "project B external tool running");
    assert.equal((await invoke(application, "agentGetStatus", [sessionA])).status.isRunning, true);
    assert.equal((await invoke(application, "agentGetStatus", [sessionB])).status.isRunning, true);
    await metrics(application, "both projects active", facts);
    await application.screenshot("m7-02-concurrent");
    writeFileSync(join(a, "release-a"), "release\n");
    await until(async () => existsSync(join(a, "background-a.txt")) && !(await invoke(application, "agentGetStatus", [sessionA])).status.isRunning, "A completes while B remains selected and running");
    const selected = await inspect(application); assert.equal(selected.activeSessionId, sessionB); assert(!selected.text.includes("M7_CONCURRENT_A_DONE"));
    assert.equal((await invoke(application, "agentGetStatus", [sessionB])).status.isRunning, true);
    assert(!existsSync(join(b, "background-a.txt")));
    writeFileSync(join(b, "release-b"), "release\n");
    await idle(application, sessionB, "M7_CONCURRENT_B_DONE");
    assert.equal(readFileSync(join(a, "background-a.txt"), "utf8"), "M7_OWN_PROJECT_A\n");
    assert.equal(readFileSync(join(b, "background-b.txt"), "utf8"), "M7_OWN_PROJECT_B\n"); assert(!existsSync(join(a, "background-b.txt")));
    facts.concurrent = {};
    for (const [name, directory] of [["a", a], ["b", b]]) {
      const started = JSON.parse(readFileSync(join(directory, `started-${name}.json`), "utf8"));
      assert.equal(installedFilesystemPath(started.cwd), installedFilesystemPath(directory)); facts.concurrent[name] = started;
    }
    facts.concurrent.backgroundCompletedWithBSelected = true; facts.steps.concurrentProjects = true; save();

    await selectSession(application, sessionA); application.progress("M7 40-turn conversation");
    for (let index = 1; index <= facts.longTurns; index++) {
      const sequence = String(index).padStart(2, "0"); const start = Date.now();
      await prompt(application, `M7_LONG_${sequence} Keep this invoice discussion turn in its own conversation. ${`fixture-${sequence}-中文-context `.repeat(35)}`);
      await idle(application, sessionA, `M7_LONG_REPLY_${sequence}`);
      facts.timings.push({ turn: index, elapsedMs: Date.now() - start });
      if (index % 10 === 0) { application.progress(`M7 long conversation ${index}/40`); save(); }
    }
    const history = readMaintenanceHistory(application, sessionA);
    for (let index = 1; index <= 40; index++) {
      const marker = `M7_LONG_REPLY_${String(index).padStart(2, "0")}`;
      assert.equal(history.entries.filter(row => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes(marker)).length, 1, `native history lost/duplicated ${marker}`);
    }
    facts.steps.longConversation = true; facts.longHistory = { bytes: history.bytes.length, sha256: history.sha256, turns: 40, compactionClaimed: false };
    await metrics(application, "after 40 turns", facts); await application.screenshot("m7-03-long-conversation"); save();

    application.progress("M7 HTTP disconnection and terminal error recovery");
    proxy.failNext(2); await prompt(application, "M7_HTTP_RECOVER Recover from a temporary model connection failure.");
    await idle(application, sessionA, "M7_HTTP_RECOVERED");
    assert.equal(proxy.faults.filter(row => row.kind === "connection-destroyed").length, 2);
    proxy.failNext(1, 401); await prompt(application, "M7_AUTH_FAIL Report this deterministic authentication failure.");
    await until(() => proxy.faults.some(row => row.status === 401), "actual HTTP 401 emitted");
    await idle(application, sessionA);
    const failedSession = await until(async () => { const value = await getSession(application, sessionA); return JSON.stringify(value.messages).includes("M7_AUTH_TERMINAL") ? value : false; }, "terminal provider diagnostic reaches stored session");
    facts.terminalErrorMessages = failedSession.messages.filter(row => row.status === "error");
    await application.screenshot("m7-04-provider-error");
    await prompt(application, "M7_AFTER_AUTH Continue after the model service is available again.");
    await idle(application, sessionA, "M7_AFTER_AUTH_RECOVERED");
    facts.httpFaults = proxy.faults; facts.steps.providerRecovery = true; save();

    const before = new Map();
    for (const [name, id] of [["a", sessionA], ["b", sessionB]]) {
      const native = readMaintenanceHistory(application, id); const projection = await getSession(application, id);
      writeFileSync(join(application.evidenceDirectory, `m7-${name}-before-quit.jsonl`), native.bytes); before.set(name, { native, projection });
    }
    const requests = postCount(provider); await application.quit();
    const closed = new Map(); facts.historyRecovery = {};
    for (const [name, id] of [["a", sessionA], ["b", sessionB]]) {
      const native = readMaintenanceHistory(application, id); const appendedExitRecords = assertClosedHistory(before.get(name).native.bytes, native.bytes);
      writeFileSync(join(application.evidenceDirectory, `m7-${name}-closed.jsonl`), native.bytes); closed.set(name, native);
      facts.historyRecovery[name] = { beforeSha256: before.get(name).native.sha256, closedSha256: native.sha256, appendedExitRecords };
    }
    await application.start();
    for (const [name, id] of [["a", sessionA], ["b", sessionB]]) {
      await selectSession(application, id); const native = readMaintenanceHistory(application, id);
      assert(native.bytes.equals(closed.get(name).bytes), "reopening changed closed native history");
      assert.deepEqual((await getSession(application, id)).messages, before.get(name).projection.messages, "history projection changed after restart");
      writeFileSync(join(application.evidenceDirectory, `m7-${name}-reopened.jsonl`), native.bytes); facts.historyRecovery[name].reopenedSha256 = native.sha256;
    }
    assert.equal(postCount(provider), requests, "restart replayed model execution");
    assert.equal(readFileSync(join(a, "background-a.txt"), "utf8"), "M7_OWN_PROJECT_A\n");
    assert.equal(readFileSync(join(b, "background-b.txt"), "utf8"), "M7_OWN_PROJECT_B\n");
    facts.steps.historyNoReplay = true; facts.providerPostsBeforeReopen = requests; facts.providerPostsAfterReopen = postCount(provider);
    await selectSession(application, sessionA); await application.screenshot("m7-05-history-reopened");
    await prompt(application, "M7_AFTER_REOPEN Continue this long conversation after restart."); await idle(application, sessionA, "M7_AFTER_REOPEN_DONE");
    facts.steps.freshTurn = true; facts.isolation = application.verifySentinels(); await metrics(application, "reopened", facts);
    facts.providerRequests = provider.requests.map(row => ({ method: row.method, url: row.url, at: row.at, body: row.body }));
    return facts;
  } finally { save(); await proxy.close(); await provider.close(); }
}
