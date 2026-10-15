#!/usr/bin/env node
/** Cold-start an actual installed app with an unavailable persisted proxy. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repository, installer, evidence] = process.argv.slice(2).map(value => resolve(value));
mkdirSync(evidence, { recursive: true });
const { InstalledApplication, until } = await import(pathToFileURL(join(repository, "app/scripts/e2e/installed-application.mjs")));
let connections = 0;
const rejector = createServer(socket => { connections++; socket.destroy(); });
await new Promise((ok, fail) => { rejector.once("error", fail); rejector.listen(0, "127.0.0.1", ok); });
const proxy = `http://127.0.0.1:${rejector.address().port}`;
async function invoke(app, channel, args = []) {
  const result = await app.renderer.evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(channel)}], ...${JSON.stringify(args)})`);
  assert.equal(result?.ok, true, `${channel}: ${JSON.stringify(result)}`); return result.data;
}
let app, failure;
const report = { unavailableProxy: proxy, physicalProxyForwarding: false, checks: [] };
try {
  app = InstalledApplication.prepare(installer, evidence);
  await app.start();
  const settings = await invoke(app, "settingsGet");
  await invoke(app, "settingsSet", [{ ...settings, networkProxy: { mode: "custom", url: proxy } }]);
  await app.quit();
  const inherited = app.childEnvironment.bind(app);
  app.childEnvironment = () => ({ ...inherited(), NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy });
  await app.start();
  report.identity = app.identity;
  const persisted = await invoke(app, "settingsGet");
  assert.equal(persisted.networkProxy.mode, "custom"); assert.equal(persisted.networkProxy.url, proxy);
  const before = connections;
  await app.main.evaluate(`(() => {
    globalThis.__ompOfflineFetch = {state:"pending"};
    globalThis.__ompOfflinePromise = fetch("https://example.invalid/omp-offline-probe").then(response => { globalThis.__ompOfflineFetch = {state:"unexpected-response",status:response.status}; }, error => { globalThis.__ompOfflineFetch = {state:"error",message:error.message}; });
    return true;
  })()`, "Main", { awaitPromise: false });
  report.fetchProbe = await until(async () => {
    const result = await app.main.evaluate("globalThis.__ompOfflineFetch", "Main", { awaitPromise: false });
    return result?.state !== "pending" ? result : false;
  }, "actual Main fetch rejected by the unavailable proxy");
  assert.equal(report.fetchProbe.state, "error");
  assert(connections > before, "the probe did not reach the physical rejecting proxy");
  const providers = await invoke(app, "providersList"); assert(Array.isArray(providers.providers));
  report.proxyConnections = connections;
  report.isolation = app.verifySentinels();
  report.checks.push("cold installed startup with persisted unavailable proxy reached the actual renderer and host");
  report.checks.push("actual Main fetch failed through the owned non-forwarding proxy, not a mocked application API");
  await app.screenshot("offline-proxy-installed-ready");
  await app.quit();
} catch (error) { failure = error; report.failure = error.stack ?? String(error); }
finally {
  if (app) {
    try { await app.cleanup(); } catch (error) { failure ??= error; report.cleanupFailure = error.stack ?? String(error); }
    report.launches = app.launches; report.processReports = app.reports; report.cleaned = app.clean === true;
    writeFileSync(join(evidence, "application-output.txt"), app.output);
    if (app.clean) { app.removeOwnedRoot(); report.rootRemoved = true; }
  }
  await new Promise(ok => rejector.close(ok));
  writeFileSync(join(evidence, "offline-installed.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: report.checks, fetchProbe: report.fetchProbe, connections: report.proxyConnections, cleaned: report.cleaned }));
