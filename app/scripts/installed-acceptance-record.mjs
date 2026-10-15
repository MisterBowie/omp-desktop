/** Bind native installed acceptance and its public evidence to installer bytes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const INSTALLED_STEPS = ["project", "deny", "allowOnce", "projectTest", "stopTree", "recoveryNoReplay", "freshTurn", "defaultIsolation"];
const FILES = [
  "01-installed-ready.png", "02-deny-pending.png", "03-approved-write.png",
  "04-long-tool-before-stop.png", "05-stopped.png", "06-recovered-history.png", "07-post-restart-turn.png",
  "native-before-quit.jsonl", "native-after-quit.jsonl", "native-after-restart.jsonl", "application-output.txt",
];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reportSha = report => sha(Buffer.from(JSON.stringify(report)));
const shaPattern = /^[a-f0-9]{64}$/;
const installerKind = platform => ({ darwin: "dmg", win32: "nsis-setup", linux: "appimage" })[platform];

export function assertInstalledAcceptance(report, options, installer) {
  const fail = label => `installed acceptance: ${label}`;
  assert.equal(report.schemaVersion, 1, fail("schema"));
  assert.equal(report.sourceRevision, options.revision, fail("different source revision"));
  assert.equal(report.platform, options.platform, fail("different native platform"));
  assert.equal(report.arch, options.arch, fail("different native architecture"));
  assert(!report.failure && !report.cleanupFailure, fail("failed workflow/cleanup"));
  assert.equal(report.bootAndOrderedQuit, true, fail("ordered application quit missing"));
  assert.equal(report.cleaned, true, fail("owned processes were not reclaimed"));
  assert(installer && installer.kind === installerKind(options.platform), fail("native installer is missing"));
  assert.equal(report.installer?.bytes, installer.bytes, fail("installer byte count"));
  assert.equal(report.installer?.sha256, installer.sha256, fail("different installer bytes"));
  assert.equal(report.installer?.path?.replaceAll("\\", "/").split("/").at(-1), installer.sourceName, fail("different installer filename"));
  const payload = report.payload;
  assert.equal(payload?.verified, true, fail("installed payload identity not verified"));
  assert.equal(payload.platform, options.platform, fail("payload platform"));
  assert.equal(payload.arch, options.arch, fail("payload architecture"));
  assert.equal(payload.package?.name, "omp-desktop", fail("inherited package identity"));
  assert.equal(payload.package?.version, options.version, fail("product version"));
  assert.equal(payload.update?.updaterCacheDirName, "omp-desktop-updater", fail("shared update cache"));
  assert.equal(payload.update?.owner, "MisterBowie", fail("foreign update owner"));
  assert.equal(payload.update?.repo, "omp-desktop", fail("foreign update repository"));
  assert(shaPattern.test(payload.asarSha256), fail("asar digest"));
  assert(payload.licenses?.originalFiles > 0 && payload.licenses.rustComponents > 0, fail("original dependency notices missing"));
  assert(shaPattern.test(payload.licenses.noticeSha256) && shaPattern.test(payload.licenses.inventorySha256), fail("notice digests"));
  const norm = path => options.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
  const inside = (child, parent) => typeof child === "string" && typeof parent === "string" && norm(child).startsWith(`${norm(parent)}/`);
  const identity = report.identity;
  assert.equal(identity?.isPackaged, true, fail("development Electron launch"));
  assert.equal(identity.name, "OMP Desktop", fail("application name"));
  assert.equal(identity.arch, options.arch, fail("running architecture"));
  assert.equal(identity.version, options.version, fail("running version"));
  for (const name of ["executable", "resources"]) {
    assert.equal(norm(identity[name]), norm(payload[name]), fail(`foreign ${name}`));
    assert(inside(identity[name], report.runRoot), fail(`${name} outside owned root`));
  }
  assert(inside(identity.home, report.runRoot) && inside(identity.userData, report.runRoot), fail("foreign HOME/profile"));
  const workflow = report.workflow;
  for (const step of INSTALLED_STEPS) assert.equal(workflow?.steps?.[step], true, fail(`missing workflow step ${step}`));
  assert.equal(workflow.externalBoundary, "loopback FakeProvider only", fail("external fixture boundary"));
  assert.equal(workflow.isolation?.dataOverrideAtLaunch, null, fail("default data root was overridden"));
  assert.equal(norm(identity.dataRoot), `${norm(identity.home)}/.omp-desktop`, fail("default data root"));
  assert.equal(norm(workflow.isolation.defaultProductDataRoot), norm(identity.dataRoot), fail("data root mismatch"));
  assert.equal(workflow.isolation.unchanged?.length, 4, fail("PI/OMP fixture observations missing"));
  assert(inside(workflow.projectTest?.home, identity.dataRoot), fail("tool HOME escaped"));
  assert.equal(workflow.longTree?.length, 3, fail("real three-process tree missing"));
  assert.equal(new Set(workflow.longTree.map(row => row.pid)).size, 3, fail("duplicate process identity"));
  for (const row of workflow.longTree) assert(Number.isInteger(row.pid) && row.pid > 1 && typeof row.starttime === "string" && row.starttime && inside(row.exe, report.runRoot), fail("invalid owned child identity"));
  assert(shaPattern.test(workflow.afterQuit?.sha256), fail("closed native transcript digest missing"));
  assert.equal(workflow.afterQuit.sha256, workflow.afterRestart?.sha256, fail("recovery rewrote history"));
  const quits = report.processReports?.filter(item => item.label === "ordered-quit");
  assert.equal(quits?.length, 2, fail("two verified native quits required"));
  assert(quits.every(item => item.noOwnedProcessesRemain === true), fail("quit left owned processes"));
  assert.equal(report.processReports.at(-1)?.processes?.length, 0, fail("final process observation not empty"));
  return { verified: true, steps: workflow.steps, reportSha256: reportSha(report), installerSha256: installer.sha256, nativeFolderChooserCovered: workflow.nativeFolderChooserCovered, nativeQuitConfirmationCovered: false };
}

function verifyBundle(bundle, options, installer) {
  assert.equal(bundle.schema, "omp-desktop.installed-evidence/1");
  const summary = assertInstalledAcceptance(bundle.report, options, installer);
  assert.deepEqual(Object.keys(bundle.files).sort(), [...FILES].sort(), "installed evidence file set differs");
  for (const name of FILES) {
    const entry = bundle.files[name];
    const bytes = Buffer.from(entry.base64, "base64");
    assert(bytes.length <= 3 * 1024 * 1024 && bytes.length === entry.bytes && sha(bytes) === entry.sha256, `installed evidence bytes differ: ${name}`);
    if (name.endsWith(".png")) assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "invalid screenshot bytes");
  }
  for (const [name, key] of [["native-before-quit.jsonl", "beforeRestart"], ["native-after-quit.jsonl", "afterQuit"], ["native-after-restart.jsonl", "afterRestart"]]) {
    assert.equal(bundle.files[name].sha256, bundle.report.workflow[key].sha256, "raw native history does not match the report");
  }
  return summary;
}

export function stageInstalledEvidence(options, assets) {
  assert(options.installedReport, "M6 requires --installed-report from the native installer workflow");
  const report = JSON.parse(readFileSync(options.installedReport, "utf8"));
  const installer = assets.find(asset => asset.kind === installerKind(options.platform));
  assertInstalledAcceptance(report, options, installer);
  const bundle = { schema: "omp-desktop.installed-evidence/1", report, files: {} };
  for (const name of FILES) {
    const path = join(dirname(options.installedReport), name);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 3 * 1024 * 1024, `invalid installed evidence file: ${name}`);
    const bytes = readFileSync(path);
    bundle.files[name] = { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
  }
  const summary = verifyBundle(bundle, options, installer);
  const bytes = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const name = `OMP-Desktop-${options.version}-${options.stage}-${options.platform}-${options.arch}-validation.json.gz`;
  writeFileSync(join(options.out, name), bytes);
  return { summary, asset: { kind: "validation", name, bytes: bytes.length, sha256: sha(bytes) } };
}

export function verifyInstalledEvidence(recordDirectory, record, options) {
  const proof = record.assets.filter(asset => asset.kind === "validation");
  assert.equal(proof.length, 1, "M6 requires exactly one native installed validation asset");
  const bytes = readFileSync(join(recordDirectory, proof[0].name));
  assert(bytes.length <= 8 * 1024 * 1024, "installed proof exceeds its byte bound");
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }));
  const summary = verifyBundle(bundle, { ...options, platform: record.platform, arch: record.arch }, record.assets.find(asset => asset.kind === installerKind(record.platform)));
  assert.deepEqual(summary, record.installedWorkflow, "staged installed summary differs from its raw proof");
}
