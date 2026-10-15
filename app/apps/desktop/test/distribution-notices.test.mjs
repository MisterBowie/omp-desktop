import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDistributionNotices } from "../../../scripts/distribution-notices.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const output = (root) => join(root, "apps", "desktop", "resources", "licenses-generated");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-notices-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), JSON.stringify({ lockfileVersion: "9.0", packages: {} }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function dependency(root, variant, name = "fixture-package", locked = true) {
  const dir = join(root, "node_modules", ".pnpm", variant, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
  if (locked) {
    const lock = JSON.parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
    lock.packages[`${name}@1.0.0`] = {};
    writeFileSync(join(root, "pnpm-lock.yaml"), JSON.stringify(lock));
  }
  return dir;
}

test("published notice bytes survive collection and repeated builds exactly", (t) => {
  const root = fixture(t);
  const packageDir = dependency(root, "fixture-a");
  const original = Buffer.from([0xff, 0x00, 0x41, 0x0a]);
  writeFileSync(join(packageDir, "LICENSE"), original);
  dependency(root, "fixture-metadata-only", "metadata-only");
  writeDistributionNotices(root);
  const body = readFileSync(join(output(root), "THIRD-PARTY-NOTICES.txt"));
  const inventoryBytes = readFileSync(join(output(root), "inventory.json"));
  const inventory = JSON.parse(inventoryBytes);
  const published = inventory.components.find((c) => c.id === "fixture-package@1.0.0").files[0];
  assert.deepEqual(body.subarray(published.offset, published.offset + published.bytes), original);
  assert.equal(published.sha256, digest(original));
  assert.equal(inventory.notice.sha256, digest(body));
  assert.deepEqual(inventory.components.find((c) => c.id === "metadata-only@1.0.0").files, []);
  writeDistributionNotices(root);
  assert.deepEqual(readFileSync(join(output(root), "THIRD-PARTY-NOTICES.txt")), body);
  assert.deepEqual(readFileSync(join(output(root), "inventory.json")), inventoryBytes);
});

test("a linked notice outside its package is refused before output is written", (t) => {
  const root = fixture(t);
  const packageDir = dependency(root, "fixture-link");
  const foreign = join(root, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep.txt"), "owned synthetic foreign data");
  symlinkSync(foreign, join(packageDir, "LICENSE"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeDistributionNotices(root), /notice leaves its published package/);
  assert.equal(existsSync(output(root)), false);
  assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "owned synthetic foreign data");
});

test("different notices under the same published package identity are refused", (t) => {
  const root = fixture(t);
  writeFileSync(join(dependency(root, "fixture-peer-a"), "LICENSE"), "first notice");
  writeFileSync(join(dependency(root, "fixture-peer-b"), "LICENSE"), "different notice");
  assert.throws(() => writeDistributionNotices(root), /variants disagree on notices/);
  assert.equal(existsSync(output(root)), false);
});

test("an unlocked stale cache is neither collected nor traversed", (t) => {
  const root = fixture(t);
  writeFileSync(join(dependency(root, "active"), "LICENSE"), "published notice");
  const stale = dependency(root, "stale", "unrelated-private-cache", false);
  const foreign = join(root, "unrelated");
  mkdirSync(foreign);
  symlinkSync(foreign, join(stale, "LICENSE"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(writeDistributionNotices(root).components, 1);
  const inventory = JSON.parse(readFileSync(join(output(root), "inventory.json"), "utf8"));
  assert.deepEqual(inventory.components.map((c) => c.id), ["fixture-package@1.0.0"]);
});
