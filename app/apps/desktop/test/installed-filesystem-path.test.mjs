import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import { createInstalledRunRoot, installedFilesystemPath } from "../../../scripts/e2e/installed-paths.mjs";

test("installed roots use physical identity and distinguish an escaping alias", (t) => {
  const root = createInstalledRunRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(root, realpathSync.native(root));
  const actual = join(root, "actual 中文 with spaces 'quoted'"); mkdirSync(actual);
  const alias = join(root, "alias");
  symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(installedFilesystemPath(alias), installedFilesystemPath(actual));
  const outside = `${root}-foreign`; mkdirSync(outside);
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const escape = join(root, "escape");
  symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  assert.equal(installedFilesystemPath(escape), installedFilesystemPath(outside));
  assert(!installedFilesystemPath(escape).startsWith(`${root}${sep}`));
  assert.throws(() => installedFilesystemPath(join(root, "missing")), /ENOENT/);
});
