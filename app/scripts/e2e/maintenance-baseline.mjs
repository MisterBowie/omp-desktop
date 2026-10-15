/** The immutable, root-audited public M6 installer used by upgrade acceptance. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256OfFile } from "../stage-test-package.mjs";

export const MAINTENANCE_BASELINE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/m6-upgrade-baseline.json", import.meta.url)), "utf8"));
export function verifyMaintenanceBaseline(installer) {
  const expected = MAINTENANCE_BASELINE.assets[process.platform];
  assert(expected && expected.arch === process.arch, "no qualified native upgrade baseline");
  assert.equal(basename(installer), expected.name, "upgrade baseline filename differs");
  assert.equal(statSync(installer).size, expected.bytes, "upgrade baseline byte count differs");
  assert.equal(sha256OfFile(installer), expected.sha256, "upgrade baseline bytes differ");
  return { ...expected, path: installer, revision: MAINTENANCE_BASELINE.revision, version: MAINTENANCE_BASELINE.version, tag: MAINTENANCE_BASELINE.tag };
}
export const maintenanceBaselinePath = directory => join(directory, MAINTENANCE_BASELINE.assets[process.platform].name);
