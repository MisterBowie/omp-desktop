/**
 * Run the pinned runtime's own `omp plugin …` CLI against the desktop store
 * (ADR 0333).
 *
 * Every marketplace mutation goes through OMP's implementation — fetching and
 * validating catalogs, cloning sources, installing into its cache and writing
 * its registries — so the desktop never reimplements the marketplace. The
 * child runs with the same environment policy as a session runtime
 * (`buildOmpRuntimeEnv`): HOME is the store, nothing credential-shaped is
 * forwarded, and only the desktop's explicit proxy reaches it.
 *
 * The CLI's success output is human text, so callers treat the exit status as
 * the result and re-read the registries; only a failure's message is lifted
 * from stderr, bounded and stripped of terminal escapes.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildOmpRuntimeEnv, defaultPathEntries } from "../isolation.js";
import { terminateProcessTree } from "../process-group.js";
import { OMP_MARKETPLACE_CONFIG_DIR, type OmpMarketplaceStore } from "./store.js";

/** Default ceiling for one CLI invocation; a git clone of a large source is the slow case. */
export const DEFAULT_PLUGIN_CLI_TIMEOUT_MS = 180_000;

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 600;

export type OmpPluginCliOptions = {
  launcher: string;
  store: OmpMarketplaceStore;
  /** Arguments after `plugin`. Passed as an argv array; no shell is involved. */
  args: readonly string[];
  pathEntries?: readonly string[];
  proxy?: { url: string; bypass: string };
  timeoutMs?: number;
  signal?: AbortSignal;
  baseEnv?: NodeJS.ProcessEnv;
};

export type OmpPluginCliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

/**
 * PATH for the CLI: the session default plus the usual git locations, since
 * GitHub and git sources are cloned with `git`. Only existing directories are
 * added.
 */
export function marketplacePathEntries(baseEnv: NodeJS.ProcessEnv = process.env): string[] {
  const entries = defaultPathEntries(undefined, baseEnv);
  const extra =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin"]
      : process.platform === "win32"
        ? [baseEnv.ProgramFiles, baseEnv["ProgramFiles(x86)"]]
            .filter((dir): dir is string => typeof dir === "string" && dir.length > 0)
            .map((dir) => join(dir, "Git", "cmd"))
        : [];
  for (const dir of extra) if (existsSync(dir) && !entries.includes(dir)) entries.push(dir);
  return entries;
}

function appendBounded(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current;
  return (current + chunk).slice(0, limit);
}

export function runOmpPluginCli(options: OmpPluginCliOptions): Promise<OmpPluginCliResult> {
  const { env } = buildOmpRuntimeEnv({
    home: options.store.home,
    configDirName: OMP_MARKETPLACE_CONFIG_DIR,
    codingAgentDir: options.store.agentDir,
    launchDir: options.store.launchDir,
    pathEntries: options.pathEntries ?? marketplacePathEntries(options.baseEnv),
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    extraEnv: {
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      // A private source must fail instead of waiting on a prompt nobody sees.
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLUGIN_CLI_TIMEOUT_MS;
  return new Promise((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const child = spawn(options.launcher, ["plugin", ...options.args], {
      cwd: options.store.launchDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const stopTree = () => {
      if (child.pid !== undefined && child.exitCode === null) void terminateProcessTree(child, child.pid, { graceMs: 1_000 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stopTree();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout = appendBounded(stdout, text, MAX_STDOUT_BYTES);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderr = appendBounded(stderr, text, MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(`could not run the OMP plugin command: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, aborted });
    });
  });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/**
 * The human-readable reason a CLI run failed: the last line OMP marked as a
 * failure (`✘ …`), else the last non-empty stderr line, with the redundant
 * `Error: ` wrapper removed.
 */
export function ompPluginCliFailure(result: OmpPluginCliResult): string {
  if (result.timedOut) return "the OMP plugin command timed out";
  if (result.aborted) return "the OMP plugin command was cancelled";
  const lines = result.stderr
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marked = [...lines].reverse().find((line) => line.startsWith("✘"));
  const line = marked ?? lines.at(-1) ?? `the OMP plugin command exited with ${result.exitCode ?? "a signal"}`;
  const cleaned = line.replace(/^✘\s*/, "").replace(/:\s*Error:\s*/, ": ");
  return cleaned.length > MAX_ERROR_CHARS ? `${cleaned.slice(0, MAX_ERROR_CHARS)}…` : cleaned;
}

/**
 * Remove native-addon extractions left by other runtime versions. OMP extracts
 * its addon (≈180 MB) into the config root per version; a store that outlives
 * runtime upgrades would otherwise keep every old copy.
 */
export function pruneStaleNatives(store: OmpMarketplaceStore, keepVersion: string): void {
  let entries: string[];
  try {
    entries = readdirSync(store.nativesDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== keepVersion) rmSync(join(store.nativesDir, entry), { recursive: true, force: true });
  }
}
