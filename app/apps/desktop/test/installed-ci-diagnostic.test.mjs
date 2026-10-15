import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("failed installed diagnostics expose bounded owned identities without argv or environment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-installed-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const processes = Array.from({ length: 20 }, (_, index) => ({
    pid: index + 100, ppid: 50, starttime: "132456789012345678", exe: `/owned/worker-${index}`,
    ownership: "descendant", argv: ["PRIVATE_ARGV_SENTINEL"], environ: ["PRIVATE_ENV_SENTINEL"],
  }));
  writeFileSync(join(root, "installed-smoke.json"), JSON.stringify({
    platform: "win32", failure: "controlled failure", processReports: [{ label: "last", processes,
      protectedAncestors: [{ argv: ["PRIVATE_ANCESTOR_SENTINEL"] }] }],
  }));
  const stdout = execFileSync(process.execPath, [
    fileURLToPath(new URL("../../../scripts/report-installed-ci.mjs", import.meta.url)), root,
  ], { encoding: "utf8" });
  const annotation = stdout.split("::").at(-1).trim();
  const report = JSON.parse(annotation);
  assert.equal(report.ownedSurvivors.length, 16);
  assert.equal(report.ownedSurvivors[0].exe, "/owned/worker-0");
  assert.equal(report.ownedSurvivors[0].starttime, "132456789012345678");
  assert.doesNotMatch(stdout, /PRIVATE_(?:ARGV|ENV|ANCESTOR)_SENTINEL/);
});
