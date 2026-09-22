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
  startupFailureOwnership,
  type OmpRuntimePhase,
  type OmpRuntimeProcessOptions,
  type OmpStopOptions,
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
  /** How a runtime is started; defaults to the real process implementation. */
  runtimeFactory?: OmpRuntimeFactory;
  /** How a retained group is terminated; defaults to the real implementation. */
  terminateTree?: typeof terminateProcessTree;
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

/**
 * What the supervisor needs from a running runtime.
 *
 * `OmpRuntimeProcess` satisfies this structurally; the seam exists so the
 * lifecycle state machine (surviving process groups, retained ownership,
 * concurrent start/stop) can be driven deterministically, without depending on
 * a child that survives SIGKILL — which no real process does.
 */
export type ManagedOmpRuntime = {
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly currentPhase: OmpRuntimePhase;
  readonly runtimeVersion: string | null;
  /** Protocol version the handshake settled on, reported in the status. */
  readonly protocolVersion: number;
  stop(options?: OmpStopOptions): Promise<OmpStopResult>;
};

export type OmpRuntimeFactory = (
  options: OmpRuntimeProcessOptions,
) => Promise<ManagedOmpRuntime>;

export type OwnedOmpRuntime = {
  /**
   * True once the run's process group is confirmed empty. A record with
   * `reaped: true` is a *directory-only* obligation: its pid/pgid are kept for
   * diagnostics but must never be signalled again, because the operating system
   * may have reused them.
   */
  reaped: boolean;
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
  /** Termination used for retained ownership (seam for deterministic tests). */
  private readonly terminateTree: typeof terminateProcessTree;
  /** The runtime this supervisor owns, live or not yet reclaimed. */
  private runtime: ManagedOmpRuntime | null = null;
  /** Record of `this.runtime`: the group and directory a reclaim must dispose of. */
  private ownership: OwnedOmpRuntime | null = null;
  /**
   * Runs whose disposal is still owed.
   *
   * Two kinds live here, and the `reaped` flag is what tells them apart: a
   * directory-only record (its group is confirmed empty, so its ids must never
   * be signalled again — the operating system may have reused them) and a live
   * record (a group that survived its termination, which the sweep retries).
   */
  private uncleanedRuns: OwnedOmpRuntime[] = [];
  private starting: Promise<EngineRuntimeStatus> | null = null;
  /** Single-flight reclaim: concurrent callers share one attempt. */
  private stopping: Promise<OmpReclaimResult> | null = null;
  private lastFailure: { reason: EngineUnavailableReason; detail: string } | null = null;

  constructor(options: OmpRuntimeSupervisorOptions) {
    this.options = options;
    this.terminateTree = options.terminateTree ?? terminateProcessTree;
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
    if (this.runtime) {
      // A runtime this supervisor still owns is never "stopped": it is either
      // stopping (not usable, and not reclaimable yet) or failed with its
      // process group still populated. Reporting `stopped` here would let a
      // caller forget an ownership it still has.
      return this.failedStatus(
        "unreclaimed",
        this.runtime.currentPhase === "failed"
          ? "the runtime could not be stopped; its process group is still populated"
          : "the runtime is shutting down",
      );
    }

    if (this.uncleanedRuns.length > 0) {
      return this.failedStatus(
        "unreclaimed",
        `${this.uncleanedRuns.length} run director${this.uncleanedRuns.length === 1 ? "y" : "ies"} could not be removed`,
      );
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
    if (this.uncleanedRuns.length > 0) {
      throw new OmpRuntimeError(
        "not-started",
        "a previous runtime directory could not be reclaimed; reclaim it before starting another",
        this.uncleanedRuns[0]?.runRoot,
      );
    }
    if (this.runtime) {
      if (this.runtime.currentPhase === "idle") return this.status();
      // A runtime that is stopping or failed is still owned. Starting a second
      // one would leave two processes sharing one product runtime directory.
      throw new OmpRuntimeError(
        "not-started",
        "the previous runtime has not been reclaimed",
        `phase=${this.runtime.currentPhase}`,
      );
    }
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
      const runtimeFactory =
        this.options.runtimeFactory ??
        ((options: OmpRuntimeProcessOptions) => OmpRuntimeProcess.start(options));
      const runtime = await runtimeFactory({
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
        reaped: false,
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
      // A failed handshake can still leave a live process. When it does, this
      // supervisor adopts it: the record keeps the group it must dispose of, the
      // directory stays, and a later stop/reclaim retries the termination.
      const orphaned = startupFailureOwnership(error);
      if (orphaned) {
        this.runtime = orphaned.runtime;
        this.ownership = {
          reaped: false,
          pid: orphaned.runtime.pid ?? 0,
          pgid: orphaned.runtime.pgid ?? 0,
          runRoot,
          configRoot,
          home,
          launcher,
          runtimeVersion: orphaned.runtime.runtimeVersion,
          startedAt: (this.options.now ?? Date.now)(),
        };
        this.lastFailure = {
          reason: "unreclaimed",
          detail: `the runtime never became usable and could not be stopped: ${(error as Error).message}`,
        };
        throw error;
      }

      this.lastFailure = {
        reason: code === "version-mismatch" ? "version-mismatch" : "start-failed",
        detail: (error as Error).message,
      };
      // Nothing of this attempt is alive, so only the directory can be owed.
      if (!this.removeRunRoot(runRoot)) {
        this.uncleanedRuns.push({
          reaped: true,
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
    if (this.stopping) return this.stopping;
    const attempt = this.performStop(options);
    this.stopping = attempt;
    try {
      return await attempt;
    } finally {
      if (this.stopping === attempt) this.stopping = null;
    }
  }

  private async performStop(options: { abortBash?: boolean }): Promise<OmpReclaimResult> {
    // A start in flight will install a runtime after this call began; waiting
    // for it is what keeps that runtime from becoming unowned.
    if (this.starting) await this.starting.catch(() => undefined);

    const runtime = this.runtime;
    const ownership = this.ownership;
    if (!runtime || !ownership) {
      return { stopped: true, reaped: true, cleaned: true, steps: ["nothing owned"], errors: [] };
    }

    const stop: OmpStopResult = await runtime.stop(
      options.abortBash ? { abortBash: true } : {},
    );

    if (!stop.reaped) {
      // The process group is populated: this supervisor still owns it, keeps the
      // record needed to terminate it, and does not delete the directory of a
      // running process. Retrying calls `stop` again — the process-level stop
      // does not cache a failed verdict.
      this.lastFailure = {
        reason: "unreclaimed",
        detail: stop.errors.join("; ") || "the runtime process group is still populated",
      };
      return {
        stopped: false,
        reaped: false,
        cleaned: false,
        steps: [...stop.steps, "ownership retained for retry"],
        errors: stop.errors.length > 0 ? [...stop.errors] : ["the runtime process group is still populated"],
      };
    }

    this.runtime = null;
    this.ownership = null;
    // The runtime is gone, so any failure recorded about owning it is spent:
    // leaving it would report a live obligation that no longer exists.
    this.lastFailure = null;
    const cleaned = this.removeRunRoot(ownership.runRoot);
    // The group is empty, so what remains is a directory obligation: keeping
    // the pids here would invite a later reclaim to signal a reused number.
    if (!cleaned) this.uncleanedRuns.push({ ...ownership, reaped: true, pid: 0, pgid: 0 });
    const errors = [...stop.errors];
    if (!cleaned) errors.push(`could not remove ${ownership.runRoot}`);
    return {
      stopped: cleaned,
      reaped: true,
      cleaned,
      steps: [...stop.steps, cleaned ? "run root removed" : "run root kept"],
      errors,
    };
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

  /**
   * Reclaim every run this supervisor owns; used on application shutdown.
   *
   * Each retained directory is handled the same way whether its process is
   * alive or not: verify the saved group, terminate it if it is populated,
   * and only delete the directory once nothing from that run survives. A run
   * that still cannot be reclaimed keeps its record, so a later attempt — in
   * this process or the next — still has something to retry.
   */
  async reclaimAll(): Promise<OmpReclaimResult[]> {
    const results: OmpReclaimResult[] = [];
    if (this.runtime || this.starting) {
      const stopped = await this.stop();
      results.push(stopped);
      // The runtime is still owned by `this.runtime`, but a sweep must be able
      // to finish the job from its records alone — on the next call, or from
      // another owner — so a group that survived is recorded as live.
      if (!stopped.reaped && this.ownership) {
        const ownership = this.ownership;
        if (!this.uncleanedRuns.some((entry) => entry.runRoot === ownership.runRoot)) {
          this.uncleanedRuns.push({ ...ownership });
        }
      }
    }

    for (const run of [...this.uncleanedRuns]) {
      const steps: string[] = [];
      const errors: string[] = [];
      // A record whose process is already gone owes only its directory; its ids
      // may long since belong to something else.
      let reaped = true;

      if (!run.reaped && run.pgid > 0) {
        // Still owns a live group: this is the only sweep that signals a
        // retained record, and it does so before the directory is touched.
        const termination = await this.terminateTree(null, run.pgid, { graceMs: 1_000 });
        steps.push(...termination.steps);
        reaped = termination.reaped;
        if (!reaped) errors.push(`process group ${run.pgid} is still populated`);
      } else if (run.reaped) {
        steps.push("process already reaped; directory only");
      }

      // Deleting a directory a live process still uses would hide the ownership
      // that makes the retry possible.
      const cleaned = reaped ? this.removeRunRoot(run.runRoot) : false;
      if (!cleaned) errors.push(`could not remove ${run.runRoot}`);
      if (!reaped || !cleaned) {
        results.push({ stopped: false, reaped, cleaned, steps, errors });
        continue;
      }
      this.uncleanedRuns = this.uncleanedRuns.filter((entry) => entry !== run);
      results.push({ stopped: true, reaped, cleaned, steps, errors });
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
