/** Native metadata adapter for the existing ownership planner; no env/argv reads. */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const observer = join(dirname(fileURLToPath(import.meta.url)), "native-process-observer.py");
export function readNativeProcessTable() {
  const python = process.env.OMP_E2E_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const env = { PATH: process.env.PATH || "", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  for (const key of ["SystemRoot", "WINDIR", "windir"]) if (process.env[key]) env[key] = process.env[key];
  const result = JSON.parse(execFileSync(python, ["-I", observer], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env,
  }));
  return nativeProcessTable(result);
}

export function nativeProcessTable(result, platform = process.platform) {
  if (result.observer !== "psutil/7.2.2" || result.platform !== platform || !Array.isArray(result.rows) || result.rows.length === 0) {
    throw new Error("native process identity table unavailable");
  }
  const seen = new Set();
  for (const row of result.rows) {
    if (!Number.isInteger(row.pid) || row.pid < 0 || seen.has(row.pid) ||
        !Number.isInteger(row.ppid) || row.ppid < 0 || !Number.isInteger(row.pgid) || row.pgid < 0 ||
        typeof row.starttime !== "string" || !/^(?:\d+(?:\.\d+)?)?$/.test(row.starttime) ||
        !["R", "Z", "X"].includes(row.state) || typeof row.exe !== "string") {
      throw new Error("invalid native process identity row");
    }
    seen.add(row.pid);
  }
  return new Map(result.rows.map((row) => [row.pid, {
    ...row, comm: row.exe, cmdline: row.exe,
    argv: row.exe ? [ownershipPath(row.exe, platform)] : [],
    // Explicit null prevents the Linux planner from reading unrelated /proc env.
    environ: null,
  }]));
}

export function ownershipPath(path, platform = process.platform) {
  return platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
}

/** Test cleanup only; production termination remains under its own contracts. */
export function reclaimWindowsProcesses(processes, root) {
  if (process.platform !== "win32") throw new Error("Windows process control requires its native host");
  const python = process.env.OMP_E2E_PYTHON || "python";
  const env = { PATH: process.env.PATH || "" };
  for (const key of ["SystemRoot", "WINDIR", "windir"]) if (process.env[key]) env[key] = process.env[key];
  return JSON.parse(execFileSync(python, ["-I", join(dirname(observer), "windows-process-control.py")], {
    input: JSON.stringify({ root, processes }), encoding: "utf8", timeout: 30_000,
    maxBuffer: 1024 * 1024, env,
  }));
}
