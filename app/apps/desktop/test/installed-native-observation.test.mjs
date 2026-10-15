import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executableArchitecture } from "../../../scripts/e2e/installed-product.mjs";
import { nativeProcessTable, ownershipPath } from "../../../scripts/e2e/native-processes.mjs";
import { collectOwnedProcesses } from "../../../scripts/e2e/process-ownership.mjs";

const row = (pid, exe, starttime = "132456789012345678") => ({ pid, ppid: 1, pgid: pid, starttime, state: "R", exe });
const observed = (rows) => ({ observer: "psutil/7.2.2", platform: "win32", rows });

test("native process observation preserves exact Windows birth and normalizes owned executable boundaries", () => {
  const root = "D:\\Temp\\应用 with spaces 'quoted'";
  const table = nativeProcessTable(observed([
    row(10, `${root}\\OMP Desktop.exe`), row(11, `${root}-foreign\\OMP Desktop.exe`),
  ]), "win32");
  const owned = collectOwnedProcesses({ table, selfPid: 100, roots: [], runRoots: [ownershipPath(root, "win32")] });
  assert.deepEqual(owned.processes.map(p => p.pid), [10]);
  assert.equal(table.get(10).starttime, "132456789012345678");
  assert.equal(table.get(10).environ, null);
});

test("unavailable, foreign-platform, duplicate and malformed observations fail closed", () => {
  for (const value of [
    observed([]), { ...observed([row(2, "x")]), platform: "darwin" },
    observed([row(2, "x"), row(2, "y")]), observed([{ ...row(2, "x"), starttime: 123 }]),
  ]) assert.throws(() => nativeProcessTable(value, "win32"), /native process identity/);
});

test("recorded pids with a different birth do not claim a foreign process", () => {
  const table = nativeProcessTable(observed([row(20, "C:\\foreign\\app.exe", "999999999999999999")]), "win32");
  const owned = collectOwnedProcesses({ table, selfPid: 100, roots: [{ pid: 20, starttime: "132456789012345678" }], runRoots: ["d:/owned"] });
  assert.equal(owned.processes.length, 0);
  assert.equal(owned.ignored[0].reason, "root-reused");
});

test("installed architecture is read from PE/ELF bytes and corrupt headers are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-arch-"));
  const file = join(root, "payload");
  try {
    const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 0x3c); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
    writeFileSync(file, pe); assert.equal(executableArchitecture(file, "win32"), "x64");
    pe.writeUInt16LE(0xaa64, 68); writeFileSync(file, pe); assert.equal(executableArchitecture(file, "win32"), "arm64");
    pe.writeUInt32LE(999_999, 0x3c); writeFileSync(file, pe); assert.throws(() => executableArchitecture(file, "win32"), /PE signature/);
    const elf = Buffer.alloc(64); Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
    writeFileSync(file, elf); assert.equal(executableArchitecture(file, "linux"), "x64");
    elf[4] = 1; writeFileSync(file, elf); assert.throws(() => executableArchitecture(file, "linux"), /ELF class/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
