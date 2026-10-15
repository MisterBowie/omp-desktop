#!/usr/bin/env node
/** Observe native appData first; only then test a default profile in that HOME. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repository, installer, evidence] = process.argv.slice(2).map(value => resolve(value));
assert.equal(process.platform, "darwin"); mkdirSync(evidence, { recursive: true });
const directory = join(repository, "app/scripts/e2e");
const { InstalledApplication } = await import(pathToFileURL(join(directory, "installed-application.mjs")));
const electron = `process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron")`;
let app, failure;
const report = { defaultProfileLaunchAttempted: false, checks: [] };
try {
  app = InstalledApplication.prepare(installer, evidence);
  const originalEnvironment = app.childEnvironment.bind(app);
  app.childEnvironment = () => ({ ...originalEnvironment(), CFFIXED_USER_HOME: app.home });
  // This first launch still has the mandatory explicit throwaway profile.
  await app.start();
  const paths = await app.main.evaluate(`(() => { const {app} = ${electron}; return {home:app.getPath("home"),appData:app.getPath("appData"),userData:app.getPath("userData")}; })()`, "Main", { awaitPromise: false });
  report.nativePathsBeforeDefaultLaunch = paths;
  assert.equal(realpathSync(paths.home), app.home, "native HOME differs; refuse a no-override launch");
  assert(paths.appData.startsWith(`${paths.home}/`), "native appData was not redirected; a no-override launch is refused");
  const nativeAppData = join(app.home, relative(paths.home, paths.appData));
  await app.quit();
  // Preserve all existing owned lifecycle/identity checks. The only removed
  // launch argument is --user-data-dir; no product code or app path is changed.
  const original = readFileSync(join(directory, "installed-application.mjs"), "utf8");
  const argument = '      `--user-data-dir=${this.profile}`, "--no-first-run",';
  assert.equal(original.split(argument).length, 2);
  const source = original.replace(argument, '      "--no-first-run",').replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(join(directory, relative)).href)}`);
  const subject = join(evidence, "installed-default-profile-subject.mjs"); writeFileSync(subject, source);
  const { InstalledApplication: DefaultProfileApplication } = await import(pathToFileURL(subject));
  Object.setPrototypeOf(app, DefaultProfileApplication.prototype);
  app.profile = join(nativeAppData, "OMP Desktop");
  report.defaultProfileLaunchAttempted = true;
  await app.start();
  assert.equal(realpathSync(app.identity.userData), realpathSync(app.profile));
  report.identity = app.identity;
  report.isolation = app.verifySentinels();
  await app.screenshot("default-product-profile");
  report.checks.push("native appData was observed inside the owned HOME before removing the explicit profile switch");
  report.checks.push("actual installed application selected OMP Desktop userData and .omp-desktop data without either override");
  await app.quit();
} catch (error) { failure = error; report.failure = error.stack ?? String(error); }
finally {
  if (app) {
    try { await app.cleanup(); } catch (error) { failure ??= error; report.cleanupFailure = error.stack ?? String(error); }
    report.launches = app.launches; report.processReports = app.reports;
    report.cleaned = app.clean === true;
    writeFileSync(join(evidence, "application-output.txt"), app.output);
    if (app.clean) { app.removeOwnedRoot(); report.rootRemoved = true; }
  }
  writeFileSync(join(evidence, "default-profile.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: report.checks, identity: report.identity, cleaned: report.cleaned }));
