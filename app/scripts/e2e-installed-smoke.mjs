#!/usr/bin/env node
/** Exercise an actual installed payload with an isolated, owned profile. */
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { InstalledApplication } from "./e2e/installed-application.mjs";
import { exerciseInstalledWorkflow } from "./e2e/installed-workflow.mjs";
import { sha256OfFile } from "./stage-test-package.mjs";

const [installer, outputDirectory] = process.argv.slice(2);
assert(installer && outputDirectory, "usage: e2e-installed-smoke.mjs <installer> <evidence-directory>");
mkdirSync(resolve(outputDirectory), { recursive: true });
let application;
let failure;
const report = {
  schemaVersion: 1, platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  installer: { path: resolve(installer), bytes: statSync(installer).size, sha256: sha256OfFile(installer) },
};
try {
  application = InstalledApplication.prepare(resolve(installer), resolve(outputDirectory));
  report.runRoot = application.root;
  report.payload = application.payload;
  report.installerMethod = application.installerMethod;
  await application.start();
  report.identity = application.identity;
  await application.screenshot("01-installed-ready");
  report.workflow = await exerciseInstalledWorkflow(application);
  await application.quit();
  report.bootAndOrderedQuit = true;
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  if (application) {
    try {
      await application.cleanup();
      report.cleaned = true;
    } catch (error) {
      failure ??= error;
      report.cleanupFailure = error.stack ?? String(error);
    }
    report.launches = application.launches;
    report.processReports = application.reports;
    writeFileSync(join(resolve(outputDirectory), "application-output.txt"), application.output);
    if (application.clean) application.removeOwnedRoot();
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(resolve(outputDirectory), "installed-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify({ bootAndOrderedQuit: true, cleaned: report.cleaned, identity: report.identity }));
