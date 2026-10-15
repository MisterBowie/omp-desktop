#!/usr/bin/env node
/** Run isolated copies of actual installed PI and OMP side by side. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repository, originalPI, installer, evidence] = process.argv.slice(2).map(value => resolve(value));
assert.equal(process.platform, "darwin");
const { InstalledApplication, until } = await import(pathToFileURL(join(repository, "app/scripts/e2e/installed-application.mjs")));
const { installedPaths, executableArchitecture } = await import(pathToFileURL(join(repository, "app/scripts/e2e/installed-product.mjs")));
const { CdpClient } = await import(pathToFileURL(join(repository, "app/scripts/e2e/cdp.mjs")));
const { readNativeProcessTable } = await import(pathToFileURL(join(repository, "app/scripts/e2e/native-processes.mjs")));
const { FakeProvider } = await import(pathToFileURL(join(repository, "app/experiments/omp-bridge/lib/provider.mjs")));
mkdirSync(evidence, { recursive: true });
const electron = `process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron")`;
async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const value = server.address().port; await new Promise(ok => server.close(ok)); return value;
}
async function targets(port) { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json(); }
const mainRead = (app, expression) => app.main.evaluate(expression, "Main", { awaitPromise: false });
async function invoke(app, channel, args = []) {
  const result = await app.renderer.evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(channel)}], ...${JSON.stringify(args)})`);
  assert.equal(result?.ok, true, `${channel}: ${JSON.stringify(result)}`);
  return result.data;
}

class PIReference extends InstalledApplication {
  childEnvironment() { return { ...super.childEnvironment(), PI_DESKTOP_DATA_DIR: this.data }; }
  async start() {
    this.mainPort = await freePort(); this.rendererPort = await freePort();
    this.environment = this.childEnvironment();
    this.child = spawn(this.payload.executable, [`--inspect=127.0.0.1:${this.mainPort}`, `--remote-debugging-port=${this.rendererPort}`, `--user-data-dir=${this.profile}`], {
      cwd: this.workspace, env: this.environment, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    this.child.stdout.on("data", bytes => { this.output += bytes; }); this.child.stderr.on("data", bytes => { this.output += bytes; });
    const birth = readNativeProcessTable().get(this.child.pid); assert(birth?.starttime);
    this.roots.set(`${birth.pid}@${birth.starttime}`, birth);
    const target = await until(async () => (await targets(this.mainPort)).find(t => t.webSocketDebuggerUrl), "owned PI Main inspector");
    this.main = await CdpClient.connect(target.webSocketDebuggerUrl);
    await until(() => mainRead(this, `${electron}.app.isReady() && ${electron}.app.getName() === "PI-Desktop"`), "actual PI initialization");
    this.identity = await mainRead(this, `(() => { const {app} = ${electron}; return {isPackaged:app.isPackaged,name:app.getName(),version:app.getVersion(),resources:process.resourcesPath,executable:process.execPath,userData:app.getPath("userData"),home:process.getBuiltinModule("os").homedir(),dataRoot:process.env.PI_DESKTOP_DATA_DIR}; })()`);
    assert.equal(this.identity.isPackaged, true);
    for (const key of ["resources", "executable"]) assert.equal(realpathSync(this.identity[key]), realpathSync(this.payload[key]));
    assert.equal(realpathSync(this.identity.userData), realpathSync(this.profile));
    assert.equal(realpathSync(this.identity.home), realpathSync(this.home));
    assert.equal(realpathSync(this.identity.dataRoot), realpathSync(this.data));
    const page = await until(async () => {
      const urls = await mainRead(this, `Array.from(${electron}.webContents.getAllWebContents(), w => w.getURL())`);
      return (await targets(this.rendererPort)).find(t => t.type === "page" && urls.includes(t.url) && t.url.includes("app.asar/out/renderer/index.html") && !t.url.includes("surface="));
    }, "PI main renderer");
    this.renderer = await CdpClient.connect(page.webSocketDebuggerUrl);
    await this.renderer.send("Runtime.enable"); await this.renderer.send("Page.enable");
    await until(() => this.renderer.evaluate('Boolean(document.querySelector(".app-shell:not(.is-booting)")) && typeof window.piDesktop?.invoke === "function"'), "PI shell");
    this.launches.push({ identity: this.identity, rendererUrl: page.url }); this.snapshot("PI-ready");
  }
}

const report = { sourcePI: originalPI, installer, sharedOwnedHome: true, originalUserProfilesRead: false, checks: [] };
let omp, pi, provider, failure;
try {
  omp = InstalledApplication.prepare(installer, join(evidence, "omp"));
  // These are only this harness's dummy sentinels, not a user's PI directory.
  rmSync(join(omp.home, ".pi-desktop"), { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-pi-reference-")));
  pi = new PIReference(root, join(evidence, "pi"));
  pi.home = omp.home; pi.data = join(omp.home, ".pi-desktop");
  pi.appDirectory = join(root, "PI-Desktop.app");
  execFileSync("/usr/bin/ditto", [originalPI, pi.appDirectory]);
  pi.payload = installedPaths(pi.appDirectory);
  assert.equal(pi.payload.info.CFBundleIdentifier, "net.aiuo.pi-desktop");
  assert.equal(executableArchitecture(pi.payload.executable, "darwin"), "arm64");
  assert.notEqual(pi.payload.info.CFBundleIdentifier, omp.payload.info.CFBundleIdentifier);
  report.roots = { omp: omp.root, pi: pi.root, home: omp.home };
  writeFileSync(join(evidence, "progress.json"), JSON.stringify(report.roots));
  provider = await FakeProvider.start();
  await pi.start();
  const input = name => ({ name, vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "local-model", secretValue: "coexistence-fixture-only", apiStyle: "chat_completions" });
  const piCreated = (await invoke(pi, "providersCreate", [input("PI coexistence fixture")])).provider; assert(piCreated?.id);
  await pi.screenshot("01-pi-ready");
  await omp.start();
  report.identities = { pi: pi.identity, omp: omp.identity };
  assert.equal(pi.identity.home, omp.identity.home);
  assert.notEqual(pi.identity.dataRoot, omp.identity.dataRoot);
  assert.notEqual(pi.identity.userData, omp.identity.userData);
  let ompProviders = (await invoke(omp, "providersList")).providers;
  assert(!ompProviders.some(p => p.id === piCreated.id || p.name === piCreated.name));
  const ompCreated = (await invoke(omp, "providersCreate", [input("OMP coexistence fixture")])).provider; assert(ompCreated?.id);
  const piProviders = (await invoke(pi, "providersList")).providers;
  assert(piProviders.some(p => p.id === piCreated.id)); assert(!piProviders.some(p => p.id === ompCreated.id));
  report.providers = { pi: { id: piCreated.id, name: piCreated.name }, omp: { id: ompCreated.id, name: ompCreated.name } };
  report.checks.push("both actual packaged applications ready with different bundle ids, profiles and databases under one owned HOME");
  report.checks.push("public provider creation/listing stayed within the owning application");
  const piBirth = readNativeProcessTable().get(pi.child.pid); assert(piBirth?.starttime);
  await omp.screenshot("02-omp-both-running");
  await omp.quit();
  assert.equal(readNativeProcessTable().get(piBirth.pid)?.starttime, piBirth.starttime, "OMP quit stopped PI");
  assert((await invoke(pi, "providersList")).providers.some(p => p.id === piCreated.id));
  report.checks.push("OMP ordered quit reclaimed its own tree while the exact PI process remained responsive");
  await omp.start();
  ompProviders = (await invoke(omp, "providersList")).providers;
  assert(ompProviders.some(p => p.id === ompCreated.id)); assert(!ompProviders.some(p => p.id === piCreated.id));
  assert.equal(readNativeProcessTable().get(piBirth.pid)?.starttime, piBirth.starttime);
  await omp.screenshot("03-omp-restarted-alongside-pi");
  report.checks.push("OMP restart restored only its own provider while the same PI instance stayed alive");
  await invoke(omp, "providersDelete", [ompCreated.id]); await invoke(pi, "providersDelete", [piCreated.id]);
  assert.equal(provider.requests.filter(r => r.method === "POST").length, 0);
  await omp.quit(); await pi.quit();
  report.checks.push("both real applications quit in production order with no owned processes remaining and no model POST");
} catch (error) { failure = error; report.failure = error.stack ?? String(error); }
finally {
  report.applications = {};
  for (const [name, app] of [["pi", pi], ["omp", omp]]) {
    if (!app) continue;
    try { await app.cleanup(); } catch (error) { failure ??= error; report[`${name}CleanupFailure`] = error.stack ?? String(error); }
    writeFileSync(join(app.evidenceDirectory, "application-output.txt"), app.output);
    report.applications[name] = { identity: app.identity, launches: app.launches, reports: app.reports, cleaned: app.clean === true };
  }
  if (pi?.clean && omp?.clean) { pi.removeOwnedRoot(); omp.removeOwnedRoot(); report.rootsRemoved = true; }
  if (provider) await provider.close();
  writeFileSync(join(evidence, "coexistence.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: report.checks, rootsRemoved: report.rootsRemoved, identities: report.identities }));
