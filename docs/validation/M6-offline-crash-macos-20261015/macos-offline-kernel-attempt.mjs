#!/usr/bin/env node
/** Verify the actual installed UI with kernel-denied outbound networking. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repository, installer, evidence] = process.argv.slice(2).map(value => resolve(value));
assert.equal(process.platform, "darwin"); mkdirSync(evidence, { recursive: true });
const directory = join(repository, "app/scripts/e2e");
const policy = "(version 1) (allow default) (deny network-outbound)";
const original = readFileSync(join(directory, "installed-application.mjs"), "utf8");
const source = original.replace('import { spawn, execFileSync }', 'import { spawn as spawnProcess, execFileSync }')
  .replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(join(directory, relative)).href)}`)
  .replace('async function port()', `const spawn = (command, args, options) => spawnProcess("/usr/bin/sandbox-exec", ["-p", ${JSON.stringify(policy)}, command, ...args], options);\n\nasync function port()`);
assert.notEqual(source, original);
const subject = join(evidence, "installed-offline-subject.mjs"); writeFileSync(subject, source);
const { InstalledApplication, until } = await import(pathToFileURL(subject));
let app, failure;
const report = { policy, sourceRevision: "de691cad8ee8ac9817528a494a31b0a03a41ba93", checks: [] };
try {
  app = InstalledApplication.prepare(installer, evidence);
  await app.start(); report.identity = app.identity;
  await app.main.evaluate(`(() => {
    globalThis.__ompOfflineProbe = { state: "pending" };
    const socket = process.getBuiltinModule("net").connect({ host: "1.1.1.1", port: 80 });
    socket.setTimeout(3000);
    socket.once("connect", () => { globalThis.__ompOfflineProbe = { state: "connected" }; socket.destroy(); });
    socket.once("error", error => { globalThis.__ompOfflineProbe = { state: "error", code: error.code }; socket.destroy(); });
    socket.once("timeout", () => { globalThis.__ompOfflineProbe = { state: "timeout" }; socket.destroy(); });
    return true;
  })()`, "Main", { awaitPromise: false });
  report.networkProbe = await until(async () => {
    const value = await app.main.evaluate("globalThis.__ompOfflineProbe", "Main", { awaitPromise: false });
    return value?.state !== "pending" ? value : false;
  }, "kernel outbound denial");
  assert.equal(report.networkProbe.state, "error");
  assert(["EPERM", "EACCES"].includes(report.networkProbe.code), "the connection was not refused by the kernel policy");
  const providers = await app.renderer.evaluate("window.piDesktop.invoke(window.piDesktop.channels.invoke.providersList)");
  assert.equal(providers?.ok, true);
  report.checks.push("actual installed Main/renderer/host ready with outbound networking denied from process start");
  report.checks.push("a network connection attempted inside the actual Main process was rejected by the kernel");
  report.isolation = app.verifySentinels();
  await app.screenshot("offline-installed-ready");
  await app.quit();
} catch (error) { failure = error; report.failure = error.stack ?? String(error); }
finally {
  if (app) {
    try { await app.cleanup(); } catch (error) { failure ??= error; report.cleanupFailure = error.stack ?? String(error); }
    report.launches = app.launches; report.processReports = app.reports; report.cleaned = app.clean === true;
    writeFileSync(join(evidence, "application-output.txt"), app.output);
    if (app.clean) { app.removeOwnedRoot(); report.rootRemoved = true; }
  }
  writeFileSync(join(evidence, "offline-installed.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: report.checks, networkProbe: report.networkProbe, cleaned: report.cleaned }));
