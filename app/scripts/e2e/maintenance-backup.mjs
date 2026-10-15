/** Copy and restore only this closed installed fixture's profile/data trees. */
import assert from "node:assert/strict";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { digest } from "./installed-product.mjs";
import { installedFilesystemPath } from "./installed-paths.mjs";

export function treeInventory(directory) {
  const files = [];
  const walk = (path, prefix) => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name); const key = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(file);
      if (stat.isSymbolicLink()) files.push({ path: key, type: "symlink", target: readlinkSync(file) });
      else if (stat.isDirectory()) { files.push({ path: key, type: "directory" }); walk(file, key); }
      else { assert(stat.isFile(), `closed backup contains a special file: ${key}`); const bytes = readFileSync(file); files.push({ path: key, type: "file", bytes: bytes.length, sha256: digest(bytes) }); }
    }
  };
  walk(directory, ""); return files;
}
function assertClosedOwnedState(application) {
  assert.equal(application.snapshot("closed-state-backup").processes.length, 0, "backup/restore requires a fully closed application");
  for (const path of [application.profile, application.data]) {
    const part = relative(installedFilesystemPath(application.root), installedFilesystemPath(path));
    assert(part && !part.startsWith("..") && !isAbsolute(part), "profile/data backup escaped its owned root");
  }
}
export function backupClosedState(application) {
  assertClosedOwnedState(application);
  const directory = join(application.root, "closed-state-backup"); mkdirSync(directory);
  const manifest = {};
  for (const [name, source] of [["profile", application.profile], ["data", application.data]]) {
    manifest[name] = treeInventory(source); cpSync(source, join(directory, name), { recursive: true, verbatimSymlinks: true });
    assert.deepEqual(treeInventory(join(directory, name)), manifest[name], "closed backup changed bytes");
  }
  return { directory, manifest };
}
export function restoreClosedState(application, backup) {
  assertClosedOwnedState(application);
  assert.equal(backup.directory, join(application.root, "closed-state-backup"));
  for (const [name, destination] of [["profile", application.profile], ["data", application.data]]) {
    assert.deepEqual(treeInventory(join(backup.directory, name)), backup.manifest[name], "closed backup was changed before restore");
    rmSync(destination, { recursive: true }); cpSync(join(backup.directory, name), destination, { recursive: true, verbatimSymlinks: true });
    assert.deepEqual(treeInventory(destination), backup.manifest[name], "restored tree differs from closed backup");
  }
  return { verified: true, profileEntries: backup.manifest.profile.length, dataEntries: backup.manifest.data.length,
    manifest: { profile: treeInventory(application.profile), data: treeInventory(application.data) } };
}
