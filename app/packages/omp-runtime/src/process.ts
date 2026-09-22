/**
 * One OMP runtime process: spawn it, take it to a usable protocol state, talk
 * to it, and stop it in the order M1 proved safe.
 *
 * Lifecycle (the states are the desktop's, not the runtime's):
 *
 *   spawn → ready → negotiate(v2) → verify version → usable
 *   stop: in-protocol abort → (abort_bash) → close stdin → SIGTERM group → SIGKILL group
 *
 * Two rules come straight from measured behaviour and are not negotiable here:
 *
 *   - **Stop in protocol, then tear the bridge.** The top-level `abort` is what
 *     reclaims a running command and its children; killing the bridge's process
 *     group first leaves orphans, because a command runs in its own group.
 *   - **A leader's exit is not the group's exit.** Escalation is decided by
 *     group liveness, and the result reports whether anything survived.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { OMP_PROTOCOL_VERSION, OMP_RUNTIME_VERSION } from "@pi-desktop/shared";

import { OmpRuntimeError } from "./errors.js";
import {
  probeRuntimeVersion,
  runtimeVersionMismatch,
  type OmpVersionProbe,
} from "./launcher.js";
import {
  checkReadyFrame,
  type OmpFrame,
  type OmpReadyFrame,
  type OmpResponseFrame,
} from "./protocol.js";
import {
  processGroupLiveness,
  terminateProcessTree,
  waitForExit,
  type TerminateTreeResult,
} from "./process-group.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, OmpTransport } from "./transport.js";

export const DEFAULT_READY_TIMEOUT_MS = 60_000;
/** How long the runtime gets to react to an in-protocol stop before teardown. */
export const DEFAULT_ABORT_SETTLE_MS = 1_000;
/** How long the runtime gets to exit on its own after stdin closes. */
export const DEFAULT_SELF_EXIT_MS = 3_000;

export type OmpRuntimePhase = "starting" | "idle" | "stopping" | "stopped" | "failed";

/**
 * A failed handshake that may still own a running process.
 *
 * `OmpRuntimeProcess.start` reaps what it spawned before it throws, but a stop
 * can come back `reaped: false` — a process group that survived its SIGKILL, or
 * a termination that could not run at all. Dropping that fact would leave a live
 * process whose pid and group nothing recorded, so the failure carries the
 * handle and the verdict: the caller either takes ownership or has nothing to
 * take.
 */
export class OmpStartupFailure extends OmpRuntimeError {
  /** The runtime the caller now owns, when one exists. */
  readonly runtime: OmpRuntimeProcess | null;
  /** The stop attempt's verdict, or null when the stop itself did not finish. */
  readonly stopResult: OmpStopResult | null;

  constructor(
    cause: OmpRuntimeError,
    ownership: { runtime: OmpRuntimeProcess; stopResult: OmpStopResult | null },
  ) {
    super(cause.code, cause.message, cause.detail);
    this.name = "OmpStartupFailure";
    this.runtime = ownership.runtime;
    this.stopResult = ownership.stopResult;
  }

  /** True when the failure left a process this caller has to dispose of. */
  get ownsLiveProcess(): boolean {
    return this.stopResult?.reaped !== true;
  }
}

/** The ownership a startup failure carries, when it carries one. */
export function startupFailureOwnership(
  error: unknown,
): { runtime: OmpRuntimeProcess; stopResult: OmpStopResult | null } | null {
  if (!(error instanceof OmpStartupFailure)) return null;
  if (!error.ownsLiveProcess || !error.runtime) return null;
  return { runtime: error.runtime, stopResult: error.stopResult };
}

export type OmpSpawnOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type OmpRuntimeProcessOptions = {
  /** Absolute path to the executable; never resolved from PATH. */
  launcher: string;
  /** Extra arguments after `--mode rpc-ui`. */
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Version this build pins; `null` disables the check. */
  expectedRuntimeVersion?: string | null;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  /** Test seams. */
  spawnImpl?: (options: OmpSpawnOptions) => ChildProcessWithoutNullStreams;
  /**
   * How the process group is verified and terminated.
   *
   * A real child cannot survive SIGKILL, so the "did not reap" branch of the
   * lifecycle is only reachable with an injected verdict.
   */
  terminateTree?: typeof terminateProcessTree;
  probeVersion?: (launcher: string, env: NodeJS.ProcessEnv) => Promise<OmpVersionProbe>;
  abortSettleMs?: number;
  selfExitMs?: number;
  /** SIGTERM→SIGKILL escalation budget for the process group. */
  terminationGraceMs?: number;
  terminationKillGraceMs?: number;
};

export type OmpStopOptions = {
  /** Send `abort_bash` as well, when the caller knows a command is running. */
  abortBash?: boolean;
  /** Skip the in-protocol stop (the runtime is already unresponsive). */
  skipAbort?: boolean;
};

export type OmpStopResult = TerminateTreeResult & {
  /** The runtime acknowledged the in-protocol stop, when one was attempted. */
  abortAcknowledged: boolean | null;
  errors: string[];
};

export class OmpRuntimeProcess {
  readonly launcher: string;
  readonly runtimeVersion: string | null;
  readonly protocolVersion: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly transport: OmpTransport;
  private readonly options: OmpRuntimeProcessOptions;
  private readyFrame: OmpReadyFrame | null = null;
  private phase: OmpRuntimePhase = "starting";
  /** The one successful stop, remembered so repeated calls agree. */
  private stopResult: OmpStopResult | null = null;
  /** The stop attempt in flight; shared by concurrent callers. */
  private stopPromise: Promise<OmpStopResult> | null = null;

  private constructor(
    options: OmpRuntimeProcessOptions,
    child: ChildProcessWithoutNullStreams,
    runtimeVersion: string | null,
    transport: OmpTransport,
  ) {
    this.options = options;
    this.launcher = options.launcher;
    this.child = child;
    this.runtimeVersion = runtimeVersion;
    this.protocolVersion = OMP_PROTOCOL_VERSION;
    this.transport = transport;
  }

  /** The runtime's readiness frame; throws when the handshake has not finished. */
  get ready(): OmpReadyFrame {
    if (!this.readyFrame) {
      throw new OmpRuntimeError("not-started", "the runtime handshake has not completed");
    }
    return this.readyFrame;
  }

  static async start(options: OmpRuntimeProcessOptions): Promise<OmpRuntimeProcess> {
    const expected =
      options.expectedRuntimeVersion === undefined
        ? OMP_RUNTIME_VERSION
        : options.expectedRuntimeVersion;

    // Version first: a mismatch is cheaper to report before a process exists,
    // and it is a build error rather than a runtime failure.
    let runtimeVersion: string | null = null;
    if (expected !== null) {
      const probe = options.probeVersion
        ? await options.probeVersion(options.launcher, options.env)
        : await probeRuntimeVersion({ launcher: options.launcher, env: options.env, cwd: options.cwd });
      const mismatch = runtimeVersionMismatch(probe.version, expected);
      if (mismatch) {
        throw new OmpRuntimeError(
          "version-mismatch",
          `OMP runtime reports ${mismatch.reported ?? `an unreadable version (${probe.reported || `exit ${probe.exitCode}`})`}, this build requires ${mismatch.expected}`,
        );
      }
      runtimeVersion = probe.version;
    }

    const spawnImpl = options.spawnImpl ?? ((spawnOptions: OmpSpawnOptions) =>
      spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group: the desktop terminates the runtime's group as a
        // unit, and only ever a group it created itself.
        detached: true,
      }) as ChildProcessWithoutNullStreams);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl({
        command: options.launcher,
        args: ["--mode", "rpc-ui", ...(options.args ?? [])],
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      throw new OmpRuntimeError(
        "spawn-failed",
        `could not start ${options.launcher}: ${(error as Error).message}`,
      );
    }

    const transport = new OmpTransport({
      child,
      ...(options.maxLineBytes ? { maxLineBytes: options.maxLineBytes } : {}),
    });

    const runtime = new OmpRuntimeProcess(options, child, runtimeVersion, transport);
    try {
      const checked = checkReadyFrame(await runtime.awaitReady());
      if (!checked.ok) {
        throw new OmpRuntimeError(
          "protocol-unsupported",
          `runtime is not usable: ${checked.detail}`,
          checked.kind,
        );
      }
      runtime.readyFrame = checked.ready;
      await runtime.negotiateProtocol();
      runtime.phase = "idle";
      return runtime;
    } catch (error) {
      // Every failure path reaps what was spawned: the runtime is detached, so
      // an escaping error would leave it running with no owner. When that reap
      // does not complete, the failure carries the handle instead of dropping it.
      const stopResult = await runtime.stop({ skipAbort: true }).catch(() => null);
      const cause =
        error instanceof OmpRuntimeError
          ? error
          : new OmpRuntimeError("spawn-failed", String((error as Error)?.message ?? error));
      if (stopResult?.reaped === true) throw cause;
      throw new OmpStartupFailure(cause, { runtime, stopResult });
    }
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  /** Process-group id (the runtime is the leader of its own group). */
  get pgid(): number | null {
    return this.child.pid ?? null;
  }

  get currentPhase(): OmpRuntimePhase {
    return this.phase;
  }

  get exitStatus(): { code: number | null; signal: NodeJS.Signals | null } {
    return { code: this.child.exitCode, signal: this.child.signalCode };
  }

  get lastStop(): OmpStopResult | null {
    return this.stopResult;
  }

  /** Diagnostics for a failure report; never contains credentials. */
  diagnostics(): { protocolErrors: readonly string[]; stderrTail: string; chunks: number } {
    return {
      protocolErrors: this.transport.protocolErrors(),
      stderrTail: this.transport.stderrTail(),
      chunks: this.transport.chunkFramesSeen,
    };
  }

  onFrame(handler: (frame: OmpFrame) => void): () => void {
    return this.transport.onFrame(handler);
  }

  /** Send a command and await its response frame. */
  request(
    command: OmpFrame,
    options: { timeoutMs?: number; id?: string } = {},
  ): Promise<OmpResponseFrame> {
    if (this.phase === "stopping" || this.phase === "stopped") {
      return Promise.reject(
        new OmpRuntimeError("stopping", "the runtime is shutting down"),
      );
    }
    return this.transport.request(command, {
      timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...(options.id ? { id: options.id } : {}),
    });
  }

  onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    const listener = (code: number | null, signal: NodeJS.Signals | null) => handler({ code, signal });
    this.child.on("exit", listener);
    return () => this.child.off("exit", listener);
  }

  /**
   * Stop the runtime in the measured-safe order and report what happened.
   *
   * The result is the caller's evidence: `reaped` is false when any process from
   * the group survived, and the caller must not treat that as a clean stop.
   */
  async stop(options: OmpStopOptions = {}): Promise<OmpStopResult> {
    // One stop per process: concurrent callers share the attempt instead of
    // each running the abort/EOF/TERM/KILL sequence against the same child.
    // Only a *successful* stop is remembered — a run whose group survived must
    // stay retryable, or the ownership could never be disposed of.
    if (this.stopResult) return this.stopResult;
    if (this.stopPromise) return this.stopPromise;
    const attempt = this.performStop(options);
    this.stopPromise = attempt;
    try {
      const result = await attempt;
      if (result.reaped) this.stopResult = result;
      return result;
    } finally {
      if (this.stopPromise === attempt) this.stopPromise = null;
    }
  }

  private async performStop(options: OmpStopOptions): Promise<OmpStopResult> {
    this.phase = "stopping";
    const steps: string[] = [];
    const errors: string[] = [];
    let abortAcknowledged: boolean | null = null;

    const pgid = this.child.pid ?? null;
    if (pgid === null) {
      steps.push("no process to stop");
      this.transport.dispose();
      this.phase = "stopped";
      return { reaped: true, escalated: "none", steps, abortAcknowledged, errors };
    }

    // 1. In-protocol stop while the bridge is still usable: this is what
    //    reclaims a running command and its descendants.
    if (!options.skipAbort && this.transport.usable) {
      try {
        const abort = await this.transport.request({ type: "abort" }, { timeoutMs: 5_000 });
        abortAcknowledged = abort.success === true;
        steps.push(`abort ${abort.success === true ? "acknowledged" : `refused: ${abort.error ?? "unknown"}`}`);
        if (options.abortBash) {
          const abortBash = await this.transport.request({ type: "abort_bash" }, { timeoutMs: 5_000 });
          steps.push(`abort_bash ${abortBash.success === true ? "acknowledged" : `refused: ${abortBash.error ?? "unknown"}`}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.abortSettleMs ?? DEFAULT_ABORT_SETTLE_MS),
        );
      } catch (error) {
        // A failed in-protocol stop is recorded, not fatal: the teardown below
        // is the fallback, and the caller sees that the stop was not clean.
        if ((error as OmpRuntimeError)?.code === "request-timeout") {
          steps.push("abort timed out");
        } else {
          errors.push(`abort failed: ${(error as Error).message}`);
        }
      }
    } else if (options.skipAbort) {
      steps.push("in-protocol stop skipped");
    }

    // 2. Break the bridge: closing stdin is what makes the runtime exit on its
    //    own (measured: EOF and stdout EPIPE both end it).
    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
      steps.push("closed stdin");
    }
    this.transport.dispose();
    const selfExited = await waitForExit(this.child, this.options.selfExitMs ?? DEFAULT_SELF_EXIT_MS);
    if (selfExited) steps.push("exited after stdin closed");

    // 3. Escalate on the process group, verifying emptiness rather than exit.
    const terminateTree = this.options.terminateTree ?? terminateProcessTree;
    let reaped = selfExited;
    let escalated: "none" | "term" | "kill" = "none";
    if (!reaped) {
      const termination = await terminateTree(this.child, pgid, {
        graceMs: this.options.terminationGraceMs,
        killGraceMs: this.options.terminationKillGraceMs,
      });
      steps.push(...termination.steps);
      reaped = termination.reaped;
      escalated = termination.escalated;
    } else {
      // The leader exited; a descendant that ignores the group signal could
      // still be alive, so liveness is re-checked before claiming success.
      const liveness = processGroupLiveness(pgid);
      if (liveness === "empty") {
        steps.push("group empty");
      } else {
        const termination = await terminateTree(null, pgid, {
          graceMs: this.options.terminationGraceMs,
          killGraceMs: this.options.terminationKillGraceMs,
        });
        steps.push(...termination.steps);
        reaped = termination.reaped;
        escalated = termination.escalated;
      }
    }
    if (!reaped) errors.push("runtime process group is still populated after SIGKILL");

    this.phase = reaped ? "stopped" : "failed";
    return { reaped, escalated, steps, abortAcknowledged, errors };
  }

  // -------------------------------------------------------------------------

  private awaitReady(): Promise<OmpReadyFrame> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    return new Promise<OmpReadyFrame>((resolve, reject) => {
      let settled = false;
      let unsubscribeFrame = () => {};
      let unsubscribeFailure = () => {};
      const finish = (settle: () => void) => () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeFrame();
        unsubscribeFailure();
        settle();
      };
      const timer: NodeJS.Timeout = setTimeout(
        finish(() =>
          reject(
            new OmpRuntimeError(
              "ready-timeout",
              `the runtime did not become ready within ${timeoutMs} ms`,
              this.transport.stderrTail(),
            ),
          ),
        ),
        timeoutMs,
      );
      // A transport that fails before `ready` must reject here instead of
      // letting the readiness timeout absorb the real cause.
      unsubscribeFailure = this.transport.onFailure(
        finish(() => reject(this.transport.transportFailure ?? new OmpRuntimeError("transport-failed", "transport failed during startup"))),
      );
      unsubscribeFrame = this.transport.onFrame((frame) => {
        if (frame.type !== "ready") return;
        finish(() => resolve(frame as OmpReadyFrame))();
      });
    });
  }

  private async negotiateProtocol(): Promise<void> {
    const response = await this.transport.request(
      { type: "negotiate_protocol", protocolVersion: OMP_PROTOCOL_VERSION },
      { timeoutMs: 15_000 },
    );
    const negotiated = (response.data as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    if (response.success !== true || negotiated !== OMP_PROTOCOL_VERSION) {
      throw new OmpRuntimeError(
        "protocol-unsupported",
        `the runtime refused protocol v${OMP_PROTOCOL_VERSION}: ${response.error ?? `answered ${String(negotiated)}`}`,
      );
    }
  }
}
