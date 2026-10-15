#!/usr/bin/env node
/** Cheap native proof of alias identity and exact-handle cleanup boundaries. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInstalledRunRoot, installedFilesystemPath } from "./e2e/installed-paths.mjs";
import { ownershipPath, readNativeProcessTable, reclaimWindowsProcesses } from "./e2e/native-processes.mjs";
import { collectOwnedProcesses } from "./e2e/process-ownership.mjs";

assert.equal(process.platform, "win32", "requires the real Windows host");
const root = createInstalledRunRoot();
const foreignRoot = `${root}-foreign`;
const children = [];
async function start(executable) {
  const child = spawn(executable, ["-e", 'console.log("READY");setInterval(()=>{},1000)'], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  children.push(child);
  await Promise.race([
    once(child.stdout, "data", { signal: AbortSignal.timeout(15_000) }), once(child, "error").then(([error]) => { throw error; }),
    once(child, "exit").then(() => { throw new Error("native probe exited before ready"); }),
  ]);
  return child;
}
async function exited(child) {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}
try {
  mkdirSync(foreignRoot);
  const name = "probe-node.exe";
  copyFileSync(process.execPath, join(root, name));
  copyFileSync(process.execPath, join(foreignRoot, name));
  const python = process.env.OMP_E2E_PYTHON || "python";
  const alias = execFileSync(python, ["-I", "-c", `
import ctypes,sys
from ctypes import wintypes
function=ctypes.WinDLL("kernel32",use_last_error=True).GetShortPathNameW
function.argtypes=[wintypes.LPCWSTR,wintypes.LPWSTR,wintypes.DWORD]
function.restype=wintypes.DWORD
buffer=ctypes.create_unicode_buffer(32768)
if not function(sys.argv[1],buffer,len(buffer)): raise ctypes.WinError(ctypes.get_last_error())
print(buffer.value)
`, root], { encoding: "utf8", timeout: 10_000 }).trim();
  assert.equal(installedFilesystemPath(alias), root, "8.3 alias does not resolve to the physical test root");
  const victim = await start(join(alias, name));
  const foreign = await start(join(foreignRoot, name));
  const table = readNativeProcessTable();
  const ownedRecord = table.get(victim.pid), foreignRecord = table.get(foreign.pid);
  assert(ownedRecord?.starttime && foreignRecord?.starttime);
  assert.equal(installedFilesystemPath(ownedRecord.exe), join(root, name));
  const owned = collectOwnedProcesses({ table, selfPid: process.pid, roots: [ownedRecord], runRoots: [ownershipPath(root)] });
  assert(owned.processes.some(record => record.pid === victim.pid));
  assert(!owned.processes.some(record => record.pid === foreign.pid), "sibling prefix was claimed as owned");
  assert.throws(() => reclaimWindowsProcesses([ownedRecord], process.env.SystemRoot), /existing unique test root/);
  const mismatched = reclaimWindowsProcesses([
    { ...ownedRecord, starttime: (BigInt(ownedRecord.starttime) + 1n).toString() }, foreignRecord,
  ], alias);
  assert(mismatched.results.find(record => record.pid === victim.pid)?.identityMismatch);
  assert(mismatched.results.find(record => record.pid === foreign.pid)?.refusedOutsideRoot);
  assert.equal(victim.exitCode, null); assert.equal(foreign.exitCode, null);
  const reclaimed = reclaimWindowsProcesses([foreignRecord, ownedRecord], alias);
  assert(reclaimed.results.find(record => record.pid === foreign.pid)?.refusedOutsideRoot);
  assert(reclaimed.results.find(record => record.pid === victim.pid)?.terminated);
  await exited(victim);
  assert(readNativeProcessTable().get(foreign.pid)?.starttime === foreignRecord.starttime, "foreign sibling was signalled");
  console.log(JSON.stringify({ physicalRoot: root, shortAlias: alias, exactBirthMismatchRefused: true,
    foreignSiblingRefusedAndAlive: true, ownedVictimReaped: true, method: reclaimed.method }));
} catch (error) {
  const text = String(error.stack ?? error).slice(0, 5000)
    .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.error(`::error title=Native Windows harness boundary::${text}`);
  process.exitCode = 1;
} finally {
  // Only the two ChildProcess handles this probe actually spawned are used.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited(child);
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(foreignRoot, { recursive: true, force: true });
}
