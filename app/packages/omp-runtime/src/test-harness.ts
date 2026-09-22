/**
 * Shared harness for the runtime-boundary tests.
 *
 * Excluded from `tsc` (see tsconfig `exclude`): it exists for `vitest` only and
 * must not ship in `dist`. It never writes outside a fresh temporary directory
 * and never inherits the operator's environment into a child.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildOmpRuntimeEnv,
  defaultPathEntries,
  OmpRuntimeProcess,
  type OmpRuntimeProcessOptions,
} from "./index.js";

/** The mock runtime shipped beside the tests. */
export const MOCK_LAUNCHER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "mock-omp.mjs",
);

/**
 * PATH the mock children are launched with.
 *
 * The mock is an executable script with an `env node` shebang, and the
 * production PATH deliberately excludes toolchain directories. On macOS the
 * interpreter lives under `~/.nvm/.../bin` and `/usr/bin/node` does not exist,
 * so the fixture adds the directory of *the interpreter running this test*.
 * This is a test-fixture concern only: `buildOmpRuntimeEnv` keeps its closed
 * PATH for real runtimes.
 */
export function mockPathEntries(): string[] {
  return [...defaultPathEntries(), dirname(process.execPath)];
}

/** The pinned version the tests claim the mock reports. */
export const MOCK_VERSION = "18.2.7";

export function makeRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `omp-runtime-${label}-`));
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export type MockLayout = {
  root: string;
  home: string;
  cwd: string;
  logPath: string;
  pidFile: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Lay out one isolated run: synthetic home, working directory, evidence files,
 * and the environment the runtime is started with.
 */
export function makeMockLayout(
  label: string,
  options: { mode?: string; version?: string; extraEnv?: NodeJS.ProcessEnv } = {},
): MockLayout {
  const root = makeRoot(label);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cwd = join(root, "cwd");
  mkdirSync(cwd, { recursive: true });
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const logPath = join(root, "mock.log");
  const pidFile = join(root, "mock.pid");

  const { env } = buildOmpRuntimeEnv({
    home,
    codingAgentDir: agentDir,
    launchDir: cwd,
    baseEnv: {},
    pathEntries: mockPathEntries(),
  });
  env.MOCK_OMP_MODE = options.mode ?? "normal";
  env.MOCK_OMP_VERSION = options.version ?? `omp/${MOCK_VERSION}`;
  env.MOCK_OMP_LOG = logPath;
  env.MOCK_OMP_PID_FILE = pidFile;
  Object.assign(env, options.extraEnv ?? {});

  return { root, home, cwd, logPath, pidFile, env };
}

/** A version probe that answers without spawning anything. */
export function fakeVersionProbe(version: string | null, reported = `omp/${MOCK_VERSION}`) {
  return async () => ({ version, reported, exitCode: 0 });
}

export type StartedMock = {
  process: OmpRuntimeProcess;
  layout: MockLayout;
};

export async function startMock(
  label: string,
  options: {
    mode?: string;
    version?: string;
    expectedRuntimeVersion?: string | null;
    extraEnv?: NodeJS.ProcessEnv;
    readyTimeoutMs?: number;
    requestTimeoutMs?: number;
    processOptions?: Partial<OmpRuntimeProcessOptions>;
  } = {},
): Promise<StartedMock> {
  const layout = makeMockLayout(label, options);
  const runtime = await OmpRuntimeProcess.start({
    launcher: MOCK_LAUNCHER,
    cwd: layout.cwd,
    env: layout.env,
    expectedRuntimeVersion:
      options.expectedRuntimeVersion === undefined
        ? MOCK_VERSION
        : options.expectedRuntimeVersion,
    probeVersion: fakeVersionProbe(options.expectedRuntimeVersion ?? MOCK_VERSION),
    readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    ...options.processOptions,
  });
  return { process: runtime, layout };
}

export function readLog(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Pids recorded by the mock: itself first, then any descendant it spawned. */
export function recordedPids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, "utf8")
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
