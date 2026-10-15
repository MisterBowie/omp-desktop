import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const entry = fileURLToPath(new URL("../../../scripts/report-maintenance-ci.mjs", import.meta.url));

test("native maintenance failure annotations keep status and remain bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-maintenance-diagnostic-"));
  try {
    writeFileSync(join(root, "maintenance-upgrade.json"), JSON.stringify({ failure: "x".repeat(24_000), cleaned: true, failureState: { status: { status: { isRunning: true, activity: { phase: "retrying" } } }, ui: { text: "fixture", stop: false } } }));
    const result = spawnSync(process.execPath, [entry, root], { encoding: "utf8" });
    assert.equal(result.status, 0, "annotation cannot mask the caller's original native exit");
    assert(result.stdout.startsWith("::error title=Native maintenance acceptance::"));
    assert(result.stdout.length < 8200); assert(result.stdout.includes('"isRunning":true'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing report is observable and a successful native report stays quiet", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-maintenance-diagnostic-"));
  try {
    const missing = spawnSync(process.execPath, [entry, root], { encoding: "utf8" });
    assert.equal(missing.status, 0); assert(missing.stdout.includes("native maintenance report missing"));
    writeFileSync(join(root, "maintenance-smoke.json"), JSON.stringify({ cleaned: true, bootAndOrderedQuit: true }));
    const passed = spawnSync(process.execPath, [entry, root], { encoding: "utf8" });
    assert.equal(passed.status, 0); assert(!passed.stdout.includes("::error")); assert(passed.stdout.includes('"complete":true'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
