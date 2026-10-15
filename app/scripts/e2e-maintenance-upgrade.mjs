#!/usr/bin/env node
/** Actual baseline -> new installer -> backup restoration and baseline rollback. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InstalledApplication, until } from "./e2e/installed-application.mjs";
import { invoke, click, inspect, reloadAndSelect, selectSession, prompt, idle } from "./e2e/installed-workflow.mjs";
import { MAINTENANCE_BASELINE, verifyMaintenanceBaseline } from "./e2e/maintenance-baseline.mjs";
import { backupClosedState, restoreClosedState } from "./e2e/maintenance-backup.mjs";
import { readMaintenanceHistory, assertClosedHistory } from "./e2e/maintenance-history.mjs";
import { sha256OfFile } from "./stage-test-package.mjs";
import { FakeProvider } from "../experiments/omp-bridge/lib/provider.mjs";

const [baselineArgument, currentArgument, outputArgument] = process.argv.slice(2);
assert(baselineArgument && currentArgument && outputArgument, "usage: e2e-maintenance-upgrade.mjs <published-baseline-installer> <current-installer> <evidence-directory>");
const baseline = verifyMaintenanceBaseline(resolve(baselineArgument));
const current = resolve(currentArgument); const output = resolve(outputArgument); mkdirSync(output, { recursive: true });
const expectedVersion = JSON.parse(readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8")).version;
assert.notEqual(expectedVersion, MAINTENANCE_BASELINE.version, "upgrade must cross actual desktop versions");
const report = { schemaVersion: 1, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(), baseline,
  installer: { path: current, bytes: statSync(current).size, sha256: sha256OfFile(current) },
  expectedVersion, steps: {}, launches: [], externalBoundary: "loopback FakeProvider only", automaticUpdaterCovered: false };
const provider = await FakeProvider.start(); let application; let failure;
const posts = () => provider.requests.filter(row => row.method === "POST").length;
const write = content => ({ toolCalls: [{ name: "write", args: { path: "upgrade-note.txt", content } }], finish: "tool_calls" });
const save = () => writeFileSync(join(output, "maintenance-upgrade.json"), `${JSON.stringify(report, null, 2)}\n`);
const approve = async () => { await until(async () => (await inspect(application)).permission, "actual upgrade fixture write approval"); await click(application, ".permission-card-actions button:last-child"); };
try {
  provider.routeBySession({ parent: [{ text: "M7_UNEXPECTED_UPGRADE_PROMPT" }], subagents: [
    { marker: "M7_UPGRADE_BASELINE", turns: [write("baseline\n"), { text: "M7_BASELINE_DONE" }] },
    { marker: "M7_UPGRADE_CURRENT", turns: [write("upgraded\n"), { text: "M7_CURRENT_DONE" }] },
    { marker: "M7_ROLLBACK_FRESH", turns: [{ text: "M7_ROLLBACK_FRESH_DONE" }] },
  ] });
  application = InstalledApplication.prepare(baseline.path, output, { expectedVersion: baseline.version });
  report.runRoot = application.root; await application.start(); report.launches.push(application.identity);
  assert.equal(application.identity.version, baseline.version);
  await invoke(application, "projectSet", [application.workspace]);
  const createdProvider = await invoke(application, "providersCreate", [{ name: "M7 upgrade loopback", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "local-model", secretValue: "m7-upgrade-fixture-key", apiStyle: "chat_completions" }]);
  const created = await invoke(application, "sessionCreate", [{ title: "M7 upgrade and rollback", mode: "agent", engine: "omp", projectPath: application.workspace, providerId: createdProvider.provider.id, modelId: "local-model" }]);
  const id = created.session.id; report.sessionId = id;
  await invoke(application, "sessionConfigure", [id, { mode: "agent", permissionMode: "ask" }]);
  await reloadAndSelect(application, id); await prompt(application, "M7_UPGRADE_BASELINE Write the baseline project note."); await approve(); await idle(application, id, "M7_BASELINE_DONE");
  assert.equal(readFileSync(join(application.workspace, "upgrade-note.txt"), "utf8"), "baseline\n");
  report.baselineProjection = (await invoke(application, "sessionGet", [id])).session.messages;
  await application.screenshot("upgrade-01-baseline");
  const beforeClose = readMaintenanceHistory(application, id); await application.quit();
  const closed = readMaintenanceHistory(application, id); assertClosedHistory(beforeClose.bytes, closed.bytes);
  writeFileSync(join(output, "upgrade-baseline-closed.jsonl"), closed.bytes); report.steps.baseline = true;
  const backup = backupClosedState(application); report.backupManifest = backup.manifest; report.steps.closedBackup = true;
  const baselineRequests = posts();
  report.currentPayload = await application.replace(current); await application.start(); report.launches.push(application.identity);
  assert.equal(application.identity.version, expectedVersion);
  await selectSession(application, id); const upgraded = readMaintenanceHistory(application, id);
  assert(upgraded.bytes.equals(closed.bytes)); const upgradeReadPosts = posts(); assert.equal(upgradeReadPosts, baselineRequests);
  assert.deepEqual((await invoke(application, "sessionGet", [id])).session.messages, report.baselineProjection);
  writeFileSync(join(output, "upgrade-current-reopened.jsonl"), upgraded.bytes); report.steps.upgradeHistoryNoReplay = true;
  await application.screenshot("upgrade-02-current-history");
  await prompt(application, "M7_UPGRADE_CURRENT Update the existing project note in the new version."); await approve(); await idle(application, id, "M7_CURRENT_DONE");
  assert.equal(readFileSync(join(application.workspace, "upgrade-note.txt"), "utf8"), "upgraded\n"); report.steps.currentVersionTurn = true;
  await application.quit(); const currentClosed = readMaintenanceHistory(application, id);
  writeFileSync(join(output, "upgrade-current-closed.jsonl"), currentClosed.bytes);
  report.restore = restoreClosedState(application, backup); report.steps.backupRestored = true;
  report.rollbackPayload = await application.replace(baseline.path, { expectedVersion: baseline.version });
  const rollbackRequests = posts(); await application.start(); report.launches.push(application.identity);
  assert.equal(application.identity.version, baseline.version); await selectSession(application, id);
  const rolledBack = readMaintenanceHistory(application, id); assert(rolledBack.bytes.equals(closed.bytes));
  assert.deepEqual((await invoke(application, "sessionGet", [id])).session.messages, report.baselineProjection);
  const rollbackReadPosts = posts(); assert.equal(rollbackReadPosts, rollbackRequests); assert.equal(readFileSync(join(application.workspace, "upgrade-note.txt"), "utf8"), "upgraded\n", "rollback replayed the old tool write");
  writeFileSync(join(output, "upgrade-rollback-reopened.jsonl"), rolledBack.bytes); report.steps.rollbackHistoryNoReplay = true;
  await application.screenshot("upgrade-03-rollback-history");
  await prompt(application, "M7_ROLLBACK_FRESH Reply after the manual rollback."); await idle(application, id, "M7_ROLLBACK_FRESH_DONE"); report.steps.rollbackFreshTurn = true;
  report.noReplay = { baselinePosts: baselineRequests, upgradeReadPosts, rollbackPostsBefore: rollbackRequests, rollbackReadPosts, finalPosts: posts() };
  report.isolation = application.verifySentinels(); report.providerRequests = provider.requests;
  await application.quit(); report.bootAndOrderedQuit = true;
} catch (error) {
  failure = error; report.failure = error.stack ?? String(error);
  if (application?.renderer) { try { await application.screenshot("upgrade-failure"); } catch (captureError) { report.failureScreenshotError = String(captureError); } }
} finally {
  if (application) {
    try { await application.cleanup(); report.cleaned = true; } catch (error) { failure ??= error; report.cleanupFailure = error.stack ?? String(error); }
    report.processReports = application.reports; report.installerMethod = application.installerMethod;
    writeFileSync(join(output, "application-output.txt"), application.output);
    if (application.clean) application.removeOwnedRoot();
  }
  await provider.close(); report.finishedAt = new Date().toISOString(); save();
}
if (failure) throw failure;
console.log(JSON.stringify({ verified: true, steps: report.steps, versions: report.launches.map(row => row.version), cleaned: report.cleaned }));
