/**
 * How the desktop finds and versions the OMP executable it runs.
 *
 * Two rules this module exists to enforce:
 *
 * 1. The product never resolves `omp` from `PATH`. A global `omp` link points at
 *    whatever checkout happened to install it last (on this machine it points
 *    into an unrelated worktree), so the launcher must be an explicit path — a
 *    bundled executable in a shipped build, an explicit override in development.
 * 2. The running version is checked, not assumed. The pinned build is what the
 *    M1 evidence covers; a different one is a different protocol implementation.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { OMP_RUNTIME_VERSION } from "@pi-desktop/shared";

import { OmpRuntimeError } from "./errors.js";

export type OmpLauncherInput = {
  /** Explicit `OMP_DESKTOP_RUNTIME`-style value: wins when present. */
  explicitPath?: string | null;
  /** Path baked into the build (bundled runtime); used when no override is set. */
  bundledPath?: string | null;
  /**
   * Development-only fallback: the launcher inside the pinned submodule. Never
   * used by a packaged product, which has `bundledPath`.
   */
  devLauncherPath?: string | null;
};

/** True when `path` is an absolute executable file. */
export function isExecutableAt(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the executable to run. Throws `launcher-missing` with every candidate
 * it tried, because "no runtime configured" is the failure an operator has to
 * act on and guessing one would hide it.
 */
export function resolveOmpLauncher(input: OmpLauncherInput): string {
  const tried: string[] = [];
  for (const [label, candidate] of [
    ["explicit", input.explicitPath],
    ["bundled", input.bundledPath],
    ["dev", input.devLauncherPath],
  ] as const) {
    if (!candidate) continue;
    if (!isAbsolute(candidate)) {
      tried.push(`${label}:${candidate} (not absolute)`);
      continue;
    }
    const path = resolve(candidate);
    if (isExecutableAt(path)) return path;
    tried.push(`${label}:${path} (not executable)`);
  }
  throw new OmpRuntimeError(
    "launcher-missing",
    "no OMP runtime executable is configured",
    tried.length > 0 ? tried.join("; ") : "no candidates configured",
  );
}

/** Launcher inside the pinned OMP reference checkout, relative to a repo root. */
export const PINNED_LAUNCHER_RELATIVE_PATH = join(
  "upstream",
  "oh-my-pi",
  "packages",
  "coding-agent",
  "scripts",
  "omp",
);

/** How far up from a starting directory the reference checkout is searched. */
const PINNED_SEARCH_DEPTH = 6;

/**
 * The tool gate this product loads into the runtime, relative to a repo root.
 *
 * It ships with the runtime package because it is part of this boundary: the
 * gate is what makes a native tool call wait for the desktop, and the desktop
 * is what understands the dialogs it raises.
 */
export const PINNED_GATE_RELATIVE_PATH = join(
  "packages",
  "omp-runtime",
  "extensions",
  "omp-desktop-gate.ts",
);

/** Find the shipped gate extension by walking up from `startDir`. */
export function findGateExtension(
  startDir: string,
  depth = PINNED_SEARCH_DEPTH,
): string | null {
  let current = resolve(startDir);
  for (let level = 0; level <= depth; level += 1) {
    const candidate = join(current, "app", PINNED_GATE_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const direct = join(current, PINNED_GATE_RELATIVE_PATH);
    if (existsSync(direct)) return direct;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Find the pinned launcher by walking up from `startDir`.
 *
 * This is the development answer to "where is the runtime": a source checkout
 * that carries the pinned submodule, never a globally linked `omp` (which
 * points at whatever checkout installed it last). A packaged build has a
 * bundled runtime instead.
 */
export function findPinnedLauncher(
  startDir: string,
  depth = PINNED_SEARCH_DEPTH,
): string | null {
  let current = resolve(startDir);
  for (let level = 0; level <= depth; level += 1) {
    const candidate = join(current, PINNED_LAUNCHER_RELATIVE_PATH);
    if (isExecutableAt(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export type OmpVersionProbeOptions = {
  launcher: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
};

export type OmpVersionProbe = {
  /** `null` when the launcher ran but printed nothing this parser understood. */
  version: string | null;
  /** Raw first line of stdout, bounded; useful in a failure message. */
  reported: string;
  exitCode: number | null;
};

/**
 * Run `<launcher> --version` and read `omp/<version>`.
 *
 * Bounded and never throws for a runtime that answers oddly: the caller decides
 * whether a missing or unexpected version is fatal. The probe gets the same
 * isolated environment as the runtime, so it cannot create state in the user's
 * home (M0 relied on this for the pinned-source check).
 */
export function probeRuntimeVersion(
  options: OmpVersionProbeOptions,
): Promise<OmpVersionProbe> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.launcher, ["--version"], {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (result: OmpVersionProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(
        new OmpRuntimeError(
          "ready-timeout",
          `version probe exceeded ${timeoutMs} ms`,
          options.launcher,
        ),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      if (stdout.length < 4096) stdout += text;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      /* the probe's stderr is not part of the contract */
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new OmpRuntimeError(
          "spawn-failed",
          `could not run ${options.launcher} --version: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      const first = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
      const version = /^omp\/(.+)$/.exec(first)?.[1]?.trim() ?? null;
      finish({ version, reported: first.slice(0, 200), exitCode: code });
    });
  });
}

/**
 * Compare a probed version against the one this build pins.
 *
 * Returns the mismatch instead of throwing so the caller can attach its own
 * context (which launcher, which run) before turning it into a startup failure.
 */
export function runtimeVersionMismatch(
  reported: string | null,
  expected: string | null = OMP_RUNTIME_VERSION,
): { expected: string; reported: string | null } | null {
  if (expected === null) return null;
  if (reported === expected) return null;
  return { expected, reported };
}
