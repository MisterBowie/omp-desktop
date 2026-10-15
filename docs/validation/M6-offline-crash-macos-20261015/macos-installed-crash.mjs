#!/usr/bin/env node
/** Force the actual Main to die while a real packaged OMP tool tree runs. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repository, installer, evidence] = process.argv.slice(2).map(value => resolve(value));
mkdirSync(evidence, { recursive: true });
const directory = join(repository, "app/scripts/e2e");
const { InstalledApplication, until } = await import(pathToFileURL(join(directory, "installed-application.mjs")));
const { FakeProvider } = await import(pathToFileURL(join(repository, "app/experiments/omp-bridge/lib/provider.mjs")));
// Reuse the exact installed acceptance controls; expose them only in a copy of
// this test module. No product or public application API is changed.
const controls = readFileSync(join(directory, "installed-workflow.mjs"), "utf8")
  .replace(/from "(\.[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(resolve(directory, relative)).href)}`)
  + "\nexport { invoke, click, inspect, reloadAndSelect, selectSession, prompt };\n";
const controlsFile = join(evidence, "installed-crash-controls.mjs"); writeFileSync(controlsFile, controls);
const { invoke, click, inspect, reloadAndSelect, selectSession, prompt } = await import(pathToFileURL(controlsFile));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
let app, provider, failure;
const report = { checks: [] };
try {
  app = InstalledApplication.prepare(installer, evidence);
  await app.start(); report.identity = app.identity;
  provider = await FakeProvider.start();
  const node = join(app.root, "crash-project-node"); copyFileSync(process.execPath, node);
  const pidFile = join(app.workspace, "crash-tree.jsonl");
  const tool = join(app.workspace, "crash-tree.mjs");
  writeFileSync(tool, `import {spawn} from "node:child_process"; import {appendFileSync} from "node:fs"; const level=Number(process.argv[2]||0); appendFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,ppid:process.ppid,level})+"\\n"); if(level<2)spawn(process.execPath,[import.meta.filename,String(level+1)],{stdio:"ignore"});setInterval(()=>{},1000);\n`);
  provider.script([{ toolCalls: [{ name: "bash", args: { command: `${quote(node)} ${quote(tool)}`, timeout: 600 } }], finish: "tool_calls" }, { text: "MUST_NOT_REPLAY_AFTER_CRASH", finish: "stop" }]);
  await invoke(app, "projectSet", [app.workspace]);
  const configured = await invoke(app, "providersCreate", [{ name: "Crash local fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "local-model", secretValue: "crash-fixture-only", apiStyle: "chat_completions" }]);
  const session = (await invoke(app, "sessionCreate", [{ title: "Installed crash recovery", mode: "agent", engine: "omp", projectPath: app.workspace, providerId: configured.provider.id, modelId: "local-model" }])).session;
  assert(session?.id); report.sessionId = session.id;
  await invoke(app, "sessionConfigure", [session.id, { mode: "agent", permissionMode: "ask" }]);
  await reloadAndSelect(app, session.id);
  await prompt(app, "INSTALLED_CRASH Start the long real tool tree.");
  await until(async () => (await inspect(app)).permission, "real crash fixture permission");
  await click(app, ".permission-card-actions button:last-child");
  const pids = await until(() => {
    if (!existsSync(pidFile)) return false;
    const rows = readFileSync(pidFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    return rows.length === 3 ? rows : false;
  }, "real running child tree");
  const snapshot = app.snapshot("before-Main-crash");
  report.toolTree = pids.map(row => {
    const observed = snapshot.processes.find(p => p.pid === row.pid); assert(observed?.starttime && observed.exe === node);
    return { ...row, starttime: observed.starttime, exe: observed.exe };
  });
  assert.equal((await invoke(app, "agentGetStatus", [session.id])).status.isRunning, true);
  await app.screenshot("01-running-before-crash");
  const posts = provider.requests.filter(r => r.method === "POST").length;
  // Self-directed SIGKILL on an already identified Main cannot target a reused
  // or foreign pid. It bypasses every asynchronous orderly shutdown callback.
  await app.main.evaluate('(() => { setTimeout(() => process.kill(process.pid, "SIGKILL"), 100); return true; })()', "Main", { awaitPromise: false });
  await app.renderer.close(); await app.main.close();
  await until(() => app.child.signalCode === "SIGKILL", "actual abrupt Main death");
  await app.waitGone(20_000);
  report.afterCrash = app.snapshot("after-crash-without-test-signals");
  assert.equal(report.afterCrash.processes.length, 0);
  assert.equal(provider.requests.filter(r => r.method === "POST").length, posts);
  report.checks.push("actual Main SIGKILL during a real OMP tool left no owned process, without test cleanup signals");
  await app.start();
  await selectSession(app, session.id);
  const status = (await invoke(app, "agentGetStatus", [session.id])).status;
  const recovered = (await invoke(app, "sessionGet", [session.id])).session;
  assert.equal(status.isRunning, false); assert.equal(recovered.engine, "omp");
  assert(recovered.messages.length > 0, "crash recovery returned empty history");
  assert.equal(provider.requests.filter(r => r.method === "POST").length, posts);
  assert.equal(readFileSync(pidFile, "utf8").trim().split("\n").length, 3);
  report.recovery = { status, messageCount: recovered.messages.length, modelPostsBeforeCrash: posts, modelPostsAfterRecovery: posts };
  await app.screenshot("02-recovered-after-crash");
  report.checks.push("restarted installed profile recovered the native conversation as idle without model or tool replay");
  await app.quit();
} catch (error) { failure = error; report.failure = error.stack ?? String(error); }
finally {
  if (app) {
    try { await app.cleanup(); } catch (error) { failure ??= error; report.cleanupFailure = error.stack ?? String(error); }
    report.launches = app.launches; report.processReports = app.reports; report.cleaned = app.clean === true;
    writeFileSync(join(evidence, "application-output.txt"), app.output);
    if (app.clean) { app.removeOwnedRoot(); report.rootRemoved = true; }
  }
  if (provider) await provider.close();
  writeFileSync(join(evidence, "installed-crash.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: report.checks, recovery: report.recovery, cleaned: report.cleaned }));
