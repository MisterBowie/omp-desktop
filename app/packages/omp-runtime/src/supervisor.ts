/**
 * Ownership and lifecycle for the OMP runtime the desktop may run.
 *
 * The supervisor is the only place that decides how many runtimes exist, where
 * their isolated directories live, and what has to be true before the desktop
 * may forget about one. It is deliberately not an auto-starting service: this
 * release starts a runtime on request, reports its status, and stops it on
 * shutdown, because nothing in the product drives a conversation through it yet
 * (M3).
 *
 * Two rules it enforces on behalf of the whole product:
 *
 *   - **Cleanup failure is a failure.** A stop that leaves processes or
 *     directories behind keeps its ownership record and reports `reaped: false`
 *     / `cleaned: false`; the caller must never read "stopped" out of a run it
 *     could not reclaim.
 *   - **Detached descendants are not the runtime's problem to solve.** A command
 *     (and a subagent's command tree) runs in its own process group, so the
 *     runtime's own group kill does not reach it — the desktop needs an explicit
 *     termination entry, which is `terminateOwnedTree`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  closedEngineCapabilities,
  liveEngineCapabilities,
  OMP_ENGINE_CAPABILITIES,
  OMP_RUNTIME_VERSION,
  type EngineRuntimeHandle,
  type EngineRuntimeStatus,
  type EngineUnavailableReason,
} from "@pi-desktop/shared";

import { OmpRuntimeError } from "./errors.js";
import {
  buildOmpRuntimeEnv,
  isPathInside,
  makeRuntimeConfigDirName,
  prepareOmpRuntimeHome,
} from "./isolation.js";
import { resolveOmpLauncher } from "./launcher.js";
import {
  OmpRuntimeProcess,
  type OmpRuntimeProcessOptions,
  type OmpStopResult,
} from "./process.js";
import { terminateProcessTree, type TerminateTreeResult } from "./process-group.js";

/** Directory under the product's data root that holds runtime scratch state. */
export const RUNTIME_STATE_DIR = "omp-runtime";

/** Prefix of a run root; ownership checks depend on it. */
export const RUN_ROOT_PREFIX = "run";

export type OmpRuntimeSupervisorOptions = {
  /** Product data root; run directories live below it and nothing else is touched. */
  dataRoot: string;
  /** Explicit runtime path (development override or user configuration). */
  launcherPath?: string | null;
  /** Path baked into this build (a packaged runtime); used when no override is set. */
  bundledLauncherPath?: string | null;
  /** Development-only fallback: the launcher inside the pinned submodule. */
  devLauncherPath?: string | null;
  /** Version this build pins; `null` disables the check. */
  expectedRuntimeVersion?: string | null;
  /** PATH entries published to the child; defaults to the launcher's runtime. */
  pathEntries?: readonly string[];
  /** Working directory of the runtime process; defaults to the run root. */
  cwd?: string;
  /**
   * Extra environment for the runtime process. Isolation keys, proxy variables
   * and credential-shaped names are still decided by `buildOmpRuntimeEnv`.
   */
  extraEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  /**
   * Runs after the run directory exists and before the runtime starts.
   *
   * This is where the embedder projects its own configuration into the child
   * (a model catalog for a configured provider, and later the desktop's model
   * settings). Nothing is copied from the user's real directories: a run starts
   * empty and gets only what this callback writes.
   */
  prepareRun?: (paths: OmpRunPaths) => void | Promise<void>;
  /** Test seams. */
  spawnImpl?: OmpRuntimeProcessOptions["spawnImpl"];
  probeVersion?: OmpRuntimeProcessOptions["probeVersion"];
  abortSettleMs?: number;
  selfExitMs?: number;
  now?: () => number;
};

/** Directories one run owns; handed to `prepareRun` before the child starts. */
export type OmpRunPaths = {
  runRoot: string;
  home: string;
  /** `PI_CODING_AGENT_DIR`: where the runtime keeps provider/model state. */
  agentDir: string;
  configDirName: string;
  configRoot: string;
  launchDir: string;
};

export type OwnedOmpRuntime = {
  /** Process id and group id of the runtime (the runtime is its own leader). */
  pid: number;
  pgid: number;
  /** Isolation root created for this run; removed on a clean stop. */
  runRoot: string;
  configRoot: string;
  home: string;
  launcher: string;
  runtimeVersion: string | null;
  startedAt: number;
};

export type OmpReclaimResult = {
  stopped: boolean;
  reaped: boolean;
  cleaned: boolean;
  steps: string[];
  errors: string[];
};

export class OmpRuntimeSupervisor implements EngineRuntimeHandle {
  readonly engine = "omp";

  private readonly options: OmpRuntimeSupervisorOptions;
  private runtime: OmpRuntimeProcess | null = null;
  private ownership: OwnedOmpRuntime | null = null;
  private starting: Promise<EngineRuntimeStatus> | null = null;
  private lastFailure: { reason: EngineUnavailableReason; detail: string } | null = null;
  private uncleanedRuns: OwnedOmpRuntime[] = [];

  constructor(options: OmpRuntimeSupervisorOptions) {
    this.options = options;
  }

  /** The pinned runtime version this supervisor accepts. */
  get pinnedRuntimeVersion(): string | null {
    return this.options.expectedRuntimeVersion === undefined
      ? OMP_RUNTIME_VERSION
      : this.options.expectedRuntimeVersion;
  }

  /** Runs this supervisor started and could not remove cleanly. */
  get pendingCleanup(): readonly OwnedOmpRuntime[] {
    return this.uncleanedRuns;
  }

  status(): EngineRuntimeStatus {
    if (this.runtime && this.runtime.currentPhase === "idle") {
      return {
        engine: "omp",
        phase: "idle",
        runtimeVersion: this.runtime.runtimeVersion,
        protocolVersion: this.runtime.protocolVersion,
        // The process is up, but this release still drives no conversation
        // through it: M2 capabilities stay closed by declaration.
        reason: "not-implemented",
        detail: "the OMP runtime is running; conversation, tools and approval arrive in M3",
        capabilities: OMP_ENGINE_CAPABILITIES,
      };
    }
    if (this.runtime && this.runtime.currentPhase === "failed") {
      return this.failedStatus("transport-failed", "the runtime did not stop cleanly; it must be rebuilt");
    }
    if (this.lastFailure) {
      return this.failedStatus(this.lastFailure.reason, this.lastFailure.detail);
    }
    return {
      engine: "omp",
      phase: "stopped",
      runtimeVersion: null,
      protocolVersion: null,
      reason: "not-started",
      detail: "no OMP runtime is running",
      capabilities: closedEngineCapabilities(),
    };
  }

  private failedStatus(reason: EngineUnavailableReason, detail: string): EngineRuntimeStatus {
    return {
      engine: "omp",
      phase: "failed",
      runtimeVersion: null,
      protocolVersion: null,
      reason,
      detail,
      capabilities: closedEngineCapabilities(),
    };
  }

  /** Capabilities a caller may act on right now. */
  liveCapabilities() {
    return liveEngineCapabilities("omp", this.status().phase);
  }

  /**
   * Start a runtime, or return the status of the one already running.
   *
   * Single-flight: concurrent callers share one start attempt, so the desktop
   * cannot end up with two runtimes that both believe they own the product's
   * runtime state directory.
   */
  async start(): Promise<EngineRuntimeStatus> {
    if (this.runtime && this.runtime.currentPhase === "idle") return this.status();
    if (this.starting) return this.starting;
    this.starting = this.startRuntime();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startRuntime(): Promise<EngineRuntimeStatus> {
    let launcher: string;
    try {
      launcher = resolveOmpLauncher({
        explicitPath: this.options.launcherPath,
        bundledPath: this.options.bundledLauncherPath,
        devLauncherPath: this.options.devLauncherPath,
      });
    } catch (error) {
      this.lastFailure = { reason: "start-failed", detail: (error as Error).message };
      throw error;
    }

    const runRoot = this.createRunRoot();
    const home = join(runRoot, "home");
    prepareOmpRuntimeHome(home);
    const configDirName = makeRuntimeConfigDirName();
    const codingAgentDir = join(runRoot, "agent");
    mkdirSync(codingAgentDir, { recursive: true });

    const { env, configRoot } = buildOmpRuntimeEnv({
      home,
      configDirName,
      codingAgentDir,
      launchDir: join(runRoot, "cwd"),
      ...(this.options.pathEntries ? { pathEntries: this.options.pathEntries } : {}),
      ...(this.options.extraEnv ? { extraEnv: this.options.extraEnv } : {}),
    });
    const launchDir = join(runRoot, "cwd");
    mkdirSync(launchDir, { recursive: true });
    const paths: OmpRunPaths = { runRoot, home, agentDir: codingAgentDir, configDirName, configRoot, launchDir };

    try {
      if (this.options.prepareRun) await this.options.prepareRun(paths);
      const runtime = await OmpRuntimeProcess.start({
        launcher,
        cwd: this.options.cwd ?? launchDir,
        env,
        expectedRuntimeVersion: this.pinnedRuntimeVersion,
        ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
        ...(this.options.readyTimeoutMs ? { readyTimeoutMs: this.options.readyTimeoutMs } : {}),
        ...(this.options.spawnImpl ? { spawnImpl: this.options.spawnImpl } : {}),
        ...(this.options.probeVersion ? { probeVersion: this.options.probeVersion } : {}),
        ...(this.options.abortSettleMs ? { abortSettleMs: this.options.abortSettleMs } : {}),
        ...(this.options.selfExitMs ? { selfExitMs: this.options.selfExitMs } : {}),
      });
      this.runtime = runtime;
      this.lastFailure = null;
      const pid = runtime.pid ?? 0;
      this.ownership = {
        pid,
        pgid: runtime.pgid ?? pid,
        runRoot,
        configRoot,
        home,
        launcher,
        runtimeVersion: runtime.runtimeVersion,
        startedAt: (this.options.now ?? Date.now)(),
      };
      return this.status();
    } catch (error) {
      const code = (error as OmpRuntimeError)?.code;
      this.lastFailure = {
        reason: code === "version-mismatch" ? "version-mismatch" : "start-failed",
        detail: (error as Error).message,
      };
      // The runtime never became usable: remove what this attempt created, and
      // keep the record when even that fails.
      if (!this.removeRunRoot(runRoot)) {
        this.uncleanedRuns.push({
          pid: 0,
          pgid: 0,
          runRoot,
          configRoot,
          home,
          launcher,
          runtimeVersion: null,
          startedAt: (this.options.now ?? Date.now)(),
        });
      }
      throw error;
    }
  }

  /**
   * Stop the runtime and remove its isolation root.
   *
   * Reports the three independent facts a caller needs: whether the process
   * group is empty, whether the run directory is gone, and what was escalated.
   */
  async stop(options: { abortBash?: boolean } = {}): Promise<OmpReclaimResult> {
    const runtime = this.runtime;
    const ownership = this.ownership;
    if (!runtime || !ownership) {
      return { stopped: true, reaped: true, cleaned: true, steps: ["nothing owned"], errors: [] };
    }
    const stop: OmpStopResult = await runtime.stop(
      options.abortBash ? { abortBash: true } : {},
    );
    this.runtime = null;
    this.ownership = null;

    const cleaned = this.removeRunRoot(ownership.runRoot);
    if (!cleaned) {
      this.uncleanedRuns.push(ownership);
    }
    const errors = [...stop.errors];
    if (!cleaned) errors.push(`could not remove ${ownership.runRoot}`);
    const result: OmpReclaimResult = {
      stopped: stop.reaped && cleaned,
      reaped: stop.reaped,
      cleaned,
      steps: [...stop.steps, cleaned ? "run root removed" : "run root kept"],
      errors,
    };
    return result;
  }

  /**
   * Terminate a detached process group this product started — a command tree the
   * runtime spawned in its own group, which a runtime-level stop does not reach.
   *
   * The caller must own the pid: it comes from a tool event or a subagent
   * record, never from a scan of the process table.
   */
  async terminateOwnedTree(pid: number, options: { graceMs?: number } = {}): Promise<TerminateTreeResult> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new OmpRuntimeError("not-started", `refusing to terminate a non-pid: ${String(pid)}`);
    }
    return terminateProcessTree(null, pid, options.graceMs ? { graceMs: options.graceMs } : {});
  }

  /** Stop every run this supervisor owns; used on application shutdown. */
  async reclaimAll(): Promise<OmpReclaimResult[]> {
    const results: OmpReclaimResult[] = [];
    if (this.runtime) results.push(await this.stop());
    for (const run of [...this.uncleanedRuns]) {
      const cleaned = this.removeRunRoot(run.runRoot);
      if (cleaned) {
        this.uncleanedRuns = this.uncleanedRuns.filter((entry) => entry !== run);
        results.push({ stopped: true, reaped: true, cleaned: true, steps: ["late cleanup"], errors: [] });
      } else {
        results.push({
          stopped: false,
          reaped: false,
          cleaned: false,
          steps: [],
          errors: [`could not remove ${run.runRoot}`],
        });
      }
    }
    return results;
  }

  private createRunRoot(): string {
    const base = join(this.options.dataRoot, RUNTIME_STATE_DIR);
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, `${RUN_ROOT_PREFIX}-`));
  }

  /**
   * Remove one run root this supervisor created.
   *
   * The path must be inside the product's runtime state directory and carry the
   * run prefix: a configuration mistake must not turn into a delete somewhere
   * else on the machine.
   */
  private removeRunRoot(candidate: string): boolean {
    const base = resolve(join(this.options.dataRoot, RUNTIME_STATE_DIR));
    const abs = resolve(candidate);
    if (!isPathInside(abs, base) || abs === base) return false;
    if (!basename(abs).startsWith(`${RUN_ROOT_PREFIX}-`)) return false;
    try {
      rmSync(abs, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Resolve the launcher the supervisor will use, without starting anything. */
export function describeRuntimeLauncher(
  options: Pick<OmpRuntimeSupervisorOptions, "launcherPath" | "bundledLauncherPath" | "devLauncherPath">,
): string | null {
  try {
    return resolveOmpLauncher({
      explicitPath: options.launcherPath,
      bundledPath: options.bundledLauncherPath,
      devLauncherPath: options.devLauncherPath,
    });
  } catch {
    return null;
  }
}
