import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import { assertInstalledAcceptance, stageInstalledEvidence, verifyInstalledEvidence } from "../../../scripts/installed-acceptance-record.mjs";
import { testReleaseMilestone } from "../../../scripts/test-release-stage.mjs";

const evidence = new URL("../../../../docs/validation/M6-installed-macos-local-20261015/", import.meta.url);
const report = JSON.parse(gunzipSync(readFileSync(new URL("installed-smoke.json.gz", evidence))));
const options = { platform: report.platform, arch: report.arch, revision: report.sourceRevision, version: report.identity.version, stage: "m6-test-fixture" };
const installer = { kind: "dmg", sourceName: report.installer.path.split("/").at(-1), ...report.installer };

test("only stages with explicit current gates are accepted", () => {
  assert.equal(testReleaseMilestone("m5-test-20261015-bdec5007"), 5);
  assert.equal(testReleaseMilestone("m6-test-candidate"), 6);
  assert.equal(testReleaseMilestone("m7-test-candidate"), 7);
  for (const tag of ["v0.15.2", "m8-test-unqualified", "m6-test-", "m6-test-../escape", "m6-preview"]) assert.throws(() => testReleaseMilestone(tag), /controlled/);
});

test("captured Mac installed report passes; incomplete, stale and different-byte claims fail", () => {
  assert.equal(assertInstalledAcceptance(report, options, installer).verified, true);
  const mutations = [
    r => { delete r.workflow.steps.stopTree; }, r => { r.cleaned = false; },
    r => { r.sourceRevision = "another-source"; }, r => { r.platform = "win32"; },
    r => { r.installer.sha256 = "0".repeat(64); }, r => { r.workflow.afterRestart.sha256 = "0".repeat(64); },
    r => { r.payload.update.updaterCacheDirName = "@pi-desktopdesktop-updater"; },
    r => { r.workflow.isolation.dataOverrideAtLaunch = "/tmp/overridden"; },
    r => { r.processReports.at(-1).processes.push({ pid: 9999 }); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => assertInstalledAcceptance(changed, options, installer), /installed acceptance/);
  }
});

test("public evidence carries exact raw history and screenshots; a forged summary is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-installed-evidence-"));
  try {
    for (const name of ["01-installed-ready.png", "02-deny-pending.png", "03-approved-write.png", "04-long-tool-before-stop.png", "05-stopped.png", "06-recovered-history.png", "07-post-restart-turn.png", "native-before-quit.jsonl", "native-after-quit.jsonl", "native-after-restart.jsonl"]) writeFileSync(join(root, name), readFileSync(new URL(name, evidence)));
    writeFileSync(join(root, "application-output.txt"), gunzipSync(readFileSync(new URL("application-output.txt.gz", evidence))));
    const reportPath = join(root, "installed-smoke.json"); writeFileSync(reportPath, JSON.stringify(report));
    const staged = stageInstalledEvidence({ ...options, out: root, installedReport: reportPath }, [installer]);
    const record = { platform: options.platform, arch: options.arch, assets: [installer, staged.asset], installedWorkflow: staged.summary };
    verifyInstalledEvidence(root, record, options);
    const bytes = readFileSync(join(root, staged.asset.name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), staged.asset.sha256);
    record.installedWorkflow.reportSha256 = "0".repeat(64);
    assert.throws(() => verifyInstalledEvidence(root, record, options), /summary differs/);
    const bundle = JSON.parse(gunzipSync(bytes)); bundle.files["native-after-restart.jsonl"].base64 = Buffer.from("forged").toString("base64");
    writeFileSync(join(root, staged.asset.name), gzipSync(Buffer.from(JSON.stringify(bundle))));
    assert.throws(() => verifyInstalledEvidence(root, record, options), /evidence bytes differ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
