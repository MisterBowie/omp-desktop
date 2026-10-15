import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { assertMaintenanceEvidence, stageMaintenanceEvidence, verifyMaintenanceEvidence } from "../../../scripts/maintenance-acceptance-record.mjs";
const evidence = new URL("../../../../docs/validation/M7-installed-macos-local-20261015/", import.meta.url);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const dailyFiles = ["m7-01-coding.png", "m7-02-concurrent.png", "m7-03-long-conversation.png", "m7-04-provider-error.png", "m7-05-history-reopened.png", ...["a", "b"].flatMap(name => ["before-quit", "closed", "reopened"].map(phase => `m7-${name}-${phase}.jsonl`)), "application-output.txt"];
const upgradeFiles = ["upgrade-01-baseline.png", "upgrade-02-current-history.png", "upgrade-03-rollback-history.png", "upgrade-baseline-closed.jsonl", "upgrade-current-reopened.jsonl", "upgrade-current-closed.jsonl", "upgrade-rollback-reopened.jsonl", "application-output.txt"];
function capture(directory, reportName, names) {
  const report = JSON.parse(gunzipSync(readFileSync(new URL(`${directory}/${reportName}.gz`, evidence))));
  const files = {};
  for (const name of names) {
    const bytes = name.endsWith(".txt") ? gunzipSync(readFileSync(new URL(`${directory}/${name}.gz`, evidence))) : readFileSync(new URL(`${directory}/${name}`, evidence));
    files[name] = { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
  }
  return { report, files };
}
const fixture = { schema: "omp-desktop.maintenance-evidence/1", daily: capture("daily", "maintenance-smoke.json", dailyFiles), upgrade: capture("upgrade", "maintenance-upgrade.json", upgradeFiles) };
// The captured local runs used different harness revisions. This synthetic
// in-memory candidate binding is only a contract fixture, never release proof.
fixture.daily.report.sourceRevision = "f".repeat(40); fixture.upgrade.report.sourceRevision = "f".repeat(40);
const options = { platform: "darwin", arch: "arm64", revision: "f".repeat(40), version: fixture.daily.report.identity.version, stage: "m7-test-contract-fixture" };
const installer = { kind: "dmg", sourceName: fixture.daily.report.installer.path.split("/").at(-1), ...fixture.daily.report.installer };

test("raw native maintenance evidence verifies the coding/concurrent/error/history/backup contract", () => {
  assert.equal(assertMaintenanceEvidence(fixture, options, installer).verified, true);
});

test("M7 refuses incomplete, stale, forged, replaying and wrong-baseline claims", () => {
  const mutations = [
    b => { b.daily.report.workflow.steps.concurrentProjects = false; },
    b => { b.upgrade.report.steps.rollbackFreshTurn = false; },
    b => { b.daily.report.sourceRevision = "a".repeat(40); },
    b => { b.daily.report.launches[1].identity.version = "0.15.2"; },
    b => { b.upgrade.report.currentPayload.verified = false; },
    b => { b.upgrade.report.baseline.sha256 = "0".repeat(64); },
    b => { b.upgrade.report.launches[1].version = b.upgrade.report.baseline.version; },
    b => { b.upgrade.report.restore.manifest.profile.pop(); },
    b => { b.daily.report.workflow.providerPostsAfterReopen++; },
    b => { b.upgrade.report.noReplay.rollbackReadPosts++; },
    b => { b.daily.report.workflow.terminalErrorMessages = []; },
    b => { b.daily.report.workflow.httpFaults.pop(); },
    b => { b.daily.report.processReports.at(-1).processes.push({ pid: 999 }); },
    b => { b.daily.files["m7-a-closed.jsonl"].base64 = Buffer.from("forged").toString("base64"); },
  ];
  for (const mutate of mutations) { const changed = structuredClone(fixture); mutate(changed); assert.throws(() => assertMaintenanceEvidence(changed, options, installer)); }
});

test("a consistently rehashed raw history still cannot omit a long conversation reply", () => {
  const changed = structuredClone(fixture);
  for (const [phase, key] of [["before-quit", "beforeSha256"], ["closed", "closedSha256"], ["reopened", "reopenedSha256"]]) {
    const name = `m7-a-${phase}.jsonl`; const original = changed.daily.files[name];
    const bytes = Buffer.from(Buffer.from(original.base64, "base64").toString("utf8").replaceAll("M7_LONG_REPLY_40", "M7_LONG_REPLY_99"));
    changed.daily.files[name] = { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
    changed.daily.report.workflow.historyRecovery.a[key] = sha(bytes);
  }
  assert.throws(() => assertMaintenanceEvidence(changed, options, installer), /native long-turn count/);
});

test("M7 staging requires both reports and reopens its public raw proof", () => {
  assert.throws(() => stageMaintenanceEvidence(options, [installer]), /M7 requires/);
  const root = mkdtempSync(join(tmpdir(), "omp-maintenance-record-"));
  try {
    for (const [name, section] of [["daily", fixture.daily], ["upgrade", fixture.upgrade]]) {
      mkdirSync(join(root, name)); writeFileSync(join(root, name, "report.json"), JSON.stringify(section.report));
      for (const [file, value] of Object.entries(section.files)) writeFileSync(join(root, name, file), Buffer.from(value.base64, "base64"));
    }
    const args = { ...options, out: root, maintenanceReport: join(root, "daily/report.json"), upgradeReport: join(root, "upgrade/report.json") };
    const staged = stageMaintenanceEvidence(args, [installer]);
    const record = { platform: options.platform, arch: options.arch, assets: [installer, staged.asset], maintenanceWorkflow: staged.summary };
    verifyMaintenanceEvidence(root, record, args);
    record.maintenanceWorkflow.dailyReportSha256 = "0".repeat(64);
    assert.throws(() => verifyMaintenanceEvidence(root, record, args), /summary differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
