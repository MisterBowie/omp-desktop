/** Bind raw native maintenance proof to the current installer and pinned baseline. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const baseline = JSON.parse(readFileSync(new URL("./e2e/fixtures/m6-upgrade-baseline.json", import.meta.url), "utf8"));
export const DAILY_STEPS = ["coding", "concurrentProjects", "longConversation", "providerRecovery", "historyNoReplay", "freshTurn"];
export const UPGRADE_STEPS = ["baseline", "closedBackup", "upgradeHistoryNoReplay", "currentVersionTurn", "backupRestored", "rollbackHistoryNoReplay", "rollbackFreshTurn"];
const DAILY_FILES = ["m7-01-coding.png", "m7-02-concurrent.png", "m7-03-long-conversation.png", "m7-04-provider-error.png", "m7-05-history-reopened.png", ...["a", "b"].flatMap(name => ["before-quit", "closed", "reopened"].map(phase => `m7-${name}-${phase}.jsonl`)), "application-output.txt"];
const UPGRADE_FILES = ["upgrade-01-baseline.png", "upgrade-02-current-history.png", "upgrade-03-rollback-history.png", "upgrade-baseline-closed.jsonl", "upgrade-current-reopened.jsonl", "upgrade-current-closed.jsonl", "upgrade-rollback-reopened.jsonl", "application-output.txt"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reportSha = report => sha(Buffer.from(JSON.stringify(report)));
const shaPattern = /^[a-f0-9]{64}$/;
const leaf = path => path.replaceAll("\\", "/").split("/").at(-1);
const kind = platform => ({ darwin: "dmg", win32: "nsis-setup", linux: "appimage" })[platform];
const normalized = (path, platform) => platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
const nativeRows = bytes => bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
const text = row => JSON.stringify(row.message?.content ?? "");
const assistants = rows => rows.filter(row => row.message?.role === "assistant");
function common(report, options, installer, quits) {
  assert.equal(report.schemaVersion, 1, "maintenance report schema");
  for (const name of ["platform", "arch"]) assert.equal(report[name], options[name], `maintenance ${name}`);
  assert.equal(report.sourceRevision, options.revision, "maintenance source revision");
  assert(!report.failure && !report.cleanupFailure && report.cleaned && report.bootAndOrderedQuit, "maintenance failed workflow/cleanup");
  assert(installer && installer.kind === kind(options.platform), "maintenance native installer");
  assert.equal(report.installer.bytes, installer.bytes, "maintenance installer bytes");
  assert.equal(report.installer.sha256, installer.sha256, "maintenance installer digest");
  assert.equal(leaf(report.installer.path), installer.sourceName, "maintenance installer name");
  assert(leaf(report.runRoot).startsWith("omp-installed-"), "maintenance owned root");
  const exits = report.processReports.filter(row => row.label === "ordered-quit");
  assert.equal(exits.length, quits, "maintenance ordered quit count");
  assert(exits.every(row => row.noOwnedProcessesRemain), "maintenance quit survivors");
  assert.equal(report.processReports.at(-1).processes.length, 0, "maintenance final survivors");
  assert(!report.processReports.some(row => /^cleanup-(?:SIG|pinned)/.test(row.label)), "maintenance required emergency cleanup");
}
function identity(value, root, options, version) {
  assert(value.isPackaged && value.name === "OMP Desktop", "maintenance installed identity");
  assert.equal(value.version, version, "maintenance running version"); assert.equal(value.arch, options.arch);
  for (const name of ["home", "userData", "dataRoot", "executable", "resources"]) {
    assert(normalized(value[name], options.platform).startsWith(`${normalized(root, options.platform)}/`), `maintenance foreign ${name}`);
  }
  assert.equal(normalized(value.dataRoot, options.platform), `${normalized(value.home, options.platform)}/.omp-desktop`);
}
function rawFiles(bundle, expected) {
  assert.deepEqual(Object.keys(bundle.files).sort(), [...expected].sort(), "maintenance raw file set");
  const files = {};
  for (const name of expected) {
    const entry = bundle.files[name]; const bytes = Buffer.from(entry.base64, "base64");
    assert(bytes.length <= 8 * 1024 * 1024 && bytes.length === entry.bytes && sha(bytes) === entry.sha256, `maintenance raw bytes: ${name}`);
    if (name.endsWith(".png")) assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "maintenance screenshot signature");
    files[name] = bytes;
  }
  return files;
}
function successfulWrite(rows, path, content) {
  const calls = rows.flatMap(row => (row.message?.content ?? []).filter?.(block => block.type === "toolCall") ?? []).filter(call => call.name === "write" && call.arguments?.path === path);
  assert.equal(calls.length, 1, `maintenance actual write count: ${path}`);
  assert(typeof calls[0].id === "string" && calls[0].id, "maintenance native tool id");
  if (content) assert.equal(calls[0].arguments.content, content);
  const results = rows.filter(row => row.message?.role === "toolResult" && row.message.toolCallId === calls[0].id);
  assert.equal(results.length, 1); assert.equal(Boolean(results[0].message.isError), false, "maintenance actual write failed");
}
function toolSpan(rows, matches) {
  const calls = rows.flatMap(row => (row.message?.content ?? []).filter?.(call => call.type === "toolCall" && matches(call)).map(call => ({ row, call })) ?? []);
  assert.equal(calls.length, 1, "maintenance tool span count");
  const result = rows.find(row => row.message?.role === "toolResult" && row.message.toolCallId === calls[0].call.id);
  assert(result && !result.message.isError, "maintenance tool span result");
  const start = Date.parse(calls[0].row.timestamp); const end = Date.parse(result.timestamp);
  assert(Number.isFinite(start) && Number.isFinite(end) && start <= end);
  return { start, end };
}
export function assertMaintenanceEvidence(bundle, options, installer) {
  assert.equal(bundle.schema, "omp-desktop.maintenance-evidence/1");
  const daily = bundle.daily.report; const upgrade = bundle.upgrade.report;
  common(daily, options, installer, 2); common(upgrade, options, installer, 3);
  identity(daily.identity, daily.runRoot, options, options.version);
  assert.equal(daily.payload.package.version, options.version); assert(daily.payload.verified);
  assert.equal(daily.launches.length, 2, "maintenance actual restart launches");
  for (const launched of daily.launches) identity(launched.identity, daily.runRoot, options, options.version);
  for (const name of ["resources", "executable"]) assert.equal(normalized(daily.identity[name], options.platform), normalized(daily.payload[name], options.platform));
  const flow = daily.workflow;
  for (const step of DAILY_STEPS) assert.equal(flow.steps[step], true, `maintenance daily step ${step}`);
  assert.equal(flow.externalBoundary, "loopback FakeProvider only"); assert.equal(flow.longTurns, 40);
  assert.equal(flow.initialProjectFailure.status, 1); assert(flow.projectCheck.includes("M7_INVOICE_7_ASSERTIONS_PASSED"));
  assert.equal(flow.timings.length, 40); assert(flow.timings.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0));
  assert(flow.resources.length >= 4 && flow.resources.every(row => row.processes.length > 0 && row.processes.every(process => process.pid > 0 && process.memory?.workingSetSize >= 0)));
  assert.equal(flow.isolation.dataOverrideAtLaunch, null); assert.equal(flow.isolation.unchanged.length, 4);
  assert.equal(flow.concurrent.backgroundCompletedWithBSelected, true);
  for (const name of ["a", "b"]) assert.equal(normalized(flow.concurrent[name].cwd, options.platform), normalized(flow.projects[name], options.platform), "maintenance concurrent cwd");
  assert.equal(flow.httpFaults.filter(row => row.kind === "connection-destroyed").length, 2);
  assert.equal(flow.httpFaults.filter(row => row.status === 401).length, 1);
  assert(flow.terminalErrorMessages.some(row => row.status === "error" && row.error?.code === "OMP_MODEL_ERROR" && row.error.message.includes("M7_AUTH_TERMINAL")));
  assert.equal(flow.providerPostsBeforeReopen, flow.providerPostsAfterReopen, "maintenance model replay");
  const files = rawFiles(bundle.daily, DAILY_FILES);
  for (const name of ["a", "b"]) {
    const before = files[`m7-${name}-before-quit.jsonl`]; const closed = files[`m7-${name}-closed.jsonl`]; const reopened = files[`m7-${name}-reopened.jsonl`];
    assert(closed.subarray(0, before.length).equals(before), "maintenance changed prior history");
    const appended = closed.subarray(before.length).toString("utf8").trim();
    assert(!appended || nativeRows(Buffer.from(appended)).every(row => row.type === "custom" && row.customType === "session_exit"));
    assert(closed.equals(reopened), "maintenance history replay/rewrite");
    assert.equal(sha(before), flow.historyRecovery[name].beforeSha256); assert.equal(sha(closed), flow.historyRecovery[name].closedSha256); assert.equal(sha(reopened), flow.historyRecovery[name].reopenedSha256);
    successfulWrite(nativeRows(closed), `background-${name}.txt`, `M7_OWN_PROJECT_${name.toUpperCase()}\n`);
  }
  const rows = nativeRows(files["m7-a-closed.jsonl"]);
  assert(rows.some(row => row.message?.role === "toolResult" && !row.message.isError && text(row).includes("M7_INVOICE_7_ASSERTIONS_PASSED")), "maintenance native project check missing");
  const secondRows = nativeRows(files["m7-b-closed.jsonl"]);
  const aHold = toolSpan(rows, call => call.name === "bash" && call.arguments?.command?.includes("hold.mjs"));
  const bHold = toolSpan(secondRows, call => call.name === "bash" && call.arguments?.command?.includes("hold.mjs"));
  const aWrite = toolSpan(rows, call => call.name === "write" && call.arguments?.path === "background-a.txt");
  assert(aHold.start <= bHold.start && bHold.start < aHold.end && aHold.end <= aWrite.start && aWrite.end <= bHold.end, "maintenance raw histories do not show concurrent background completion");

  for (let index = 1; index <= 40; index++) assert.equal(assistants(rows).filter(row => text(row).includes(`M7_LONG_REPLY_${String(index).padStart(2, "0")}`)).length, 1, "maintenance native long-turn count");
  assert(assistants(rows).some(row => row.message.stopReason === "error" && row.message.errorMessage?.includes("M7_AUTH_TERMINAL")), "maintenance native provider error missing");
  assert(assistants(rows).some(row => text(row).includes("M7_AFTER_AUTH_RECOVERED")), "maintenance native recovery missing");
  for (const step of UPGRADE_STEPS) assert.equal(upgrade.steps[step], true, `maintenance upgrade step ${step}`);
  assert.equal(upgrade.externalBoundary, "loopback FakeProvider only"); assert.equal(upgrade.automaticUpdaterCovered, false);
  const pinned = baseline.assets[options.platform];
  for (const name of ["name", "bytes", "sha256", "arch"]) assert.equal(upgrade.baseline[name], pinned[name], `maintenance baseline ${name}`);
  for (const name of ["revision", "tag", "version"]) assert.equal(upgrade.baseline[name], baseline[name], `maintenance baseline ${name}`);
  assert.notEqual(options.version, baseline.version); assert.equal(upgrade.expectedVersion, options.version);
  assert.deepEqual(upgrade.launches.map(row => row.version), [baseline.version, options.version, baseline.version]);
  for (const [index, launched] of upgrade.launches.entries()) {
    identity(launched, upgrade.runRoot, options, index === 1 ? options.version : baseline.version);
    for (const name of ["home", "userData", "dataRoot", "executable", "resources"]) assert.equal(normalized(launched[name], options.platform), normalized(upgrade.launches[0][name], options.platform), `maintenance changed ${name}`);
  }
  assert(upgrade.currentPayload.verified && upgrade.rollbackPayload.verified, "maintenance payload inspection");
  assert.equal(upgrade.currentPayload.package.version, options.version); assert.equal(upgrade.rollbackPayload.package.version, baseline.version);
  for (const [payload, launched] of [[upgrade.currentPayload, upgrade.launches[1]], [upgrade.rollbackPayload, upgrade.launches[2]]]) {
    for (const name of ["resources", "executable"]) assert.equal(normalized(payload[name], options.platform), normalized(launched[name], options.platform));
  }
  assert.equal(upgrade.restore.verified, true); assert.deepEqual(upgrade.restore.manifest, upgrade.backupManifest, "maintenance restored backup bytes differ");
  for (const name of ["profile", "data"]) {
    const entries = upgrade.backupManifest[name]; assert(entries.length > 0 && entries.some(row => row.type === "file"));
    assert(entries.filter(row => row.type === "file").every(row => shaPattern.test(row.sha256) && row.bytes >= 0));
  }
  assert.equal(upgrade.projectNoteAfterRollback, "upgraded\n", "maintenance rollback replayed old write");
  assert.equal(upgrade.noReplay.baselinePosts, upgrade.noReplay.upgradeReadPosts); assert.equal(upgrade.noReplay.rollbackPostsBefore, upgrade.noReplay.rollbackReadPosts);
  assert.equal(upgrade.noReplay.finalPosts, upgrade.noReplay.rollbackReadPosts + 1);
  const upgradedFiles = rawFiles(bundle.upgrade, UPGRADE_FILES); const initial = upgradedFiles["upgrade-baseline-closed.jsonl"];
  assert(initial.equals(upgradedFiles["upgrade-current-reopened.jsonl"])); assert(initial.equals(upgradedFiles["upgrade-rollback-reopened.jsonl"]));
  assert(upgradedFiles["upgrade-current-closed.jsonl"].subarray(0, initial.length).equals(initial));
  successfulWrite(nativeRows(initial), "upgrade-note.txt", "baseline\n");
  const originalIds = new Set(nativeRows(initial).map(row => row.id));
  const changed = nativeRows(upgradedFiles["upgrade-current-closed.jsonl"]).filter(row => !originalIds.has(row.id));
  successfulWrite(changed, "upgrade-note.txt", "upgraded\n");
  return { verified: true, dailyReportSha256: reportSha(daily), upgradeReportSha256: reportSha(upgrade), installerSha256: installer.sha256, baselineRevision: baseline.revision, baselineInstallerSha256: pinned.sha256, dailySteps: flow.steps, upgradeSteps: upgrade.steps, longTurns: 40, automaticUpdaterCovered: false };
}
function collect(reportPath, names) {
  const report = JSON.parse(readFileSync(reportPath, "utf8")); const files = {};
  for (const name of names) {
    const path = join(dirname(reportPath), name); const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024, `maintenance invalid raw file: ${name}`);
    const bytes = readFileSync(path); files[name] = { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
  }
  return { report, files };
}
export function stageMaintenanceEvidence(options, assets) {
  assert(options.maintenanceReport && options.upgradeReport, "M7 requires --maintenance-report and --upgrade-report");
  const bundle = { schema: "omp-desktop.maintenance-evidence/1", daily: collect(options.maintenanceReport, DAILY_FILES), upgrade: collect(options.upgradeReport, UPGRADE_FILES) };
  const installer = assets.find(row => row.kind === kind(options.platform)); const summary = assertMaintenanceEvidence(bundle, options, installer);
  const bytes = gzipSync(Buffer.from(JSON.stringify(bundle))); assert(bytes.length <= 16 * 1024 * 1024);
  const name = `OMP-Desktop-${options.version}-${options.stage}-${options.platform}-${options.arch}-maintenance.json.gz`;
  writeFileSync(join(options.out, name), bytes); return { summary, asset: { kind: "maintenance", name, bytes: bytes.length, sha256: sha(bytes) } };
}
export function verifyMaintenanceEvidence(directory, record, options) {
  const assets = record.assets.filter(row => row.kind === "maintenance"); assert.equal(assets.length, 1, "M7 requires exactly one maintenance proof");
  const bytes = readFileSync(join(directory, assets[0].name)); assert(bytes.length <= 16 * 1024 * 1024);
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: 96 * 1024 * 1024 }));
  const summary = assertMaintenanceEvidence(bundle, { ...options, platform: record.platform, arch: record.arch }, record.assets.find(row => row.kind === kind(record.platform)));
  assert.deepEqual(summary, record.maintenanceWorkflow, "maintenance summary differs from raw proof");
}
