/**
 * One desktop session, driven against one pinned runtime process.
 *
 * The runner is the seam between three things that must stay apart: the
 * runtime's frames, the desktop's event vocabulary, and the user's decisions.
 * It owns exactly four responsibilities.
 *
 *   1. **Prompting and reporting.** `prompt` starts a run generation and sends
 *      `prompt`; every frame the runtime emits is converted (see `events.ts`)
 *      and handed to `emit` as an `AgentEventEnvelope`, with the run's `turnId`
 *      attached so the desktop can tell two runs apart.
 *   2. **Asking.** Dialog frames are classified (`ui-requests.ts`) and passed
 *      to `onUiRequest`; the desktop answers with `resolveUiRequest`, and only
 *      the answer that is still pending, current and unspent is written back.
 *   3. **Stopping, in the order the pinned runtime needs.** `abort` first
 *      (`rpc-mode.ts` awaits `session.abort`, which is what reclaims a running
 *      command and its descendants), then `abort_bash` *only* while a bash tool
 *      call is still open, then a bounded wait for the turn to converge; the
 *      process-group teardown M2 owns is the last resort, never the first step.
 *   4. **Refusing stale work.** A run generation is closed when it stops; frames
 *      and decisions that arrive afterwards are counted as late instead of
 *      being attributed to whatever runs next.
 */
import type { AgentEvent, AgentEventEnvelope } from "@pi-desktop/shared";

import { OmpRuntimeError } from "../errors.js";
import type { OmpFrame } from "../protocol.js";
import { appError, OmpEventConverter } from "./events.js";
import {
  OmpUiRequests,
  type OmpUiDecision,
  type OmpUiRequest,
  type OmpUiRecord,
} from "./ui-requests.js";

/** The part of the runtime handle this module needs. */
export type OmpSessionRuntime = {
  readonly pid: number | null;
  /** Write one frame to the runtime. */
  write(frame: OmpFrame): boolean;
  /** Send one command and resolve with its response frame. */
  request(
    command: OmpFrame,
    options?: { timeoutMs?: number; id?: string },
  ): Promise<{ success?: boolean; error?: string; data?: unknown }>;
  /** Observe frames that are not responses to our own requests. */
  onFrame(handler: (frame: OmpFrame) => void): () => void;
  /** Observe the failure that makes the transport unusable. */
  onFailure(handler: (error: OmpRuntimeError) => void): () => void;
  readonly usable: boolean;
};

export type OmpRunState = "idle" | "running" | "stopping";

export type OmpStopOutcome = {
  /** The runtime acknowledged the in-protocol abort. */
  aborted: boolean;
  /** A bash tool call was still open when the abort was acknowledged. */
  abortBashSent: boolean;
  /** The turn stopped without tearing the process down. */
  converged: boolean;
  /** The process-group teardown ran (the protocol stop did not converge). */
  toreDown: boolean;
  steps: string[];
  errors: string[];
};

export type OmpSessionRunnerOptions = {
  sessionId: string;
  runtime: OmpSessionRuntime;
  /** Deliver one desktop event envelope. */
  emit: (envelope: AgentEventEnvelope) => void;
  /** The desktop's chance to answer a dialog. */
  onUiRequest?: (request: OmpUiRequest, info: { sessionId: string; generation: number }) => void;
  /** Diagnostic trail for every dialog decision. */
  onUiRecord?: (record: OmpUiRecord) => void;
  /**
   * Last resort for `stop`: the M2 process teardown. Absent in tests that only
   * exercise the protocol path.
   */
  teardown?: (options: { abortBash: boolean }) => Promise<{
    reaped: boolean;
    cleaned: boolean;
  }>;
  now?: () => number;
  /** How long to wait for one convergence step before escalating. */
  convergeTimeoutMs?: number;
  /** How long to wait for `abort` itself to be answered. */
  abortTimeoutMs?: number;
};

type RunRecord = {
  generation: number;
  turnId: string;
  promptMessage: string;
  startedAt: number;
  bashOpen: boolean;
  settled: boolean;
};

const DEFAULT_CONVERGE_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

export class OmpSessionRunner {
  private readonly sessionId: string;
  private readonly runtime: OmpSessionRuntime;
  private readonly emitEnvelope: (envelope: AgentEventEnvelope) => void;
  private readonly onUiRequest:
    | ((request: OmpUiRequest, info: { sessionId: string; generation: number }) => void)
    | undefined;
  private readonly onUiRecord: ((record: OmpUiRecord) => void) | undefined;
  private readonly teardown: OmpSessionRunnerOptions["teardown"];
  private readonly now: () => number;
  private readonly convergeTimeoutMs: number;
  private readonly abortTimeoutMs: number;

  private readonly converter: OmpEventConverter;
  private readonly ui: OmpUiRequests;
  private readonly detachFrame: () => void;
  private readonly detachFailure: () => void;

  private state: OmpRunState = "idle";
  private run: RunRecord | null = null;
  private lastClosedGeneration = 0;
  private readonly bashCallIds = new Set<string>();
  private lateFrames = 0;
  private readonly waiters = new Set<() => void>();
  private disposed: { code: string; message: string } | null = null;

  constructor(options: OmpSessionRunnerOptions) {
    this.sessionId = options.sessionId;
    this.runtime = options.runtime;
    this.emitEnvelope = options.emit;
    this.onUiRequest = options.onUiRequest;
    this.onUiRecord = options.onUiRecord;
    this.teardown = options.teardown;
    this.now = options.now ?? Date.now;
    this.convergeTimeoutMs = options.convergeTimeoutMs ?? DEFAULT_CONVERGE_TIMEOUT_MS;
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.converter = new OmpEventConverter({ sessionId: this.sessionId, now: this.now });
    this.ui = new OmpUiRequests({
      sessionId: this.sessionId,
      write: (frame) => this.runtime.write(frame as OmpFrame),
      now: this.now,
    });
    this.detachFrame = this.runtime.onFrame((frame) => this.onFrame(frame));
    this.detachFailure = this.runtime.onFailure((error) => this.onTransportFailure(error));
  }

  /** What `agentGetStatus` answers for this session. */
  status(): {
    isRunning: boolean;
    currentTurnId?: string;
    pendingToolConfirmations: number;
  } {
    return {
      isRunning: this.state === "running",
      ...(this.run ? { currentTurnId: this.run.turnId } : {}),
      pendingToolConfirmations: this.ui.open().length,
    };
  }

  runState(): OmpRunState {
    return this.state;
  }

  /** Open dialog requests, for the desktop's status surface. */
  openRequests(): Array<{ requestId: string; request: OmpUiRequest; generation: number }> {
    return this.ui.open();
  }

  diagnostics(): {
    lateFrames: number;
    conversion: ReturnType<OmpEventConverter["snapshot"]>;
    uiRecords: readonly OmpUiRecord[];
    state: OmpRunState;
  } {
    return {
      lateFrames: this.lateFrames,
      conversion: this.converter.snapshot(),
      uiRecords: this.ui.records(),
      state: this.state,
    };
  }

  /**
   * Start a run.
   *
   * Refused while a previous run is still stopping: the runtime runs one agent
   * loop at a time, so a second prompt would be answered into the turn the user
   * just cancelled.
   */
  async prompt(message: string): Promise<{ accepted: boolean; turnId: string; generation: number }> {
    this.throwIfDisposed();
    if (this.state !== "idle") {
      throw new OmpRuntimeError(
        "not-started",
        `the runtime is ${this.state}; stop it before prompting again`,
      );
    }
    if (!this.runtime.usable) {
      throw new OmpRuntimeError("transport-failed", "the runtime transport is not usable");
    }
    const generation = this.ui.beginRun();
    const turnId = `omp-turn:${this.sessionId}:${generation}`;
    this.run = {
      generation,
      turnId,
      promptMessage: message,
      startedAt: this.now(),
      bashOpen: false,
      settled: false,
    };
    this.state = "running";
    const response = await this.runtime.request({ type: "prompt", message }, { timeoutMs: 30_000 });
    if (response.success === false) {
      this.state = "idle";
      this.run = null;
      throw new OmpRuntimeError(
        "not-started",
        `the runtime refused the prompt: ${response.error ?? "unknown error"}`,
      );
    }
    return { accepted: true, turnId, generation };
  }

  /**
   * Answer one open dialog with the user's decision.
   *
   * `value` names the option a question's user actually picked; approvals
   * ignore it, because their meaning is the decision, not a label.
   */
  resolveUiRequest(
    requestId: string,
    decision: OmpUiDecision,
    options: { value?: string } = {},
  ): { ok: boolean; reason?: string; detail?: string } {
    const result = this.ui.resolve(
      requestId,
      decision,
      options.value === undefined ? {} : { value: options.value },
    );
    for (const record of this.ui.records().slice(-1)) this.onUiRecord?.(record);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, detail: result.detail };
  }

  /**
   * Stop the current run: the protocol first, the process only as a last resort.
   */
  async stop(): Promise<OmpStopOutcome> {
    const steps: string[] = [];
    const errors: string[] = [];
    const run = this.run;
    if (!run || this.state === "idle") {
      return { aborted: false, abortBashSent: false, converged: true, toreDown: false, steps: ["nothing running"], errors };
    }
    this.state = "stopping";
    // Fail closed first: every open dialog is answered "cancelled", so a tool
    // waiting on a user who is now stopping cannot be left mid-decision.
    const cancelled = this.ui.cancelPending("the run was stopped");
    if (cancelled > 0) steps.push(`cancelled ${cancelled} pending request(s)`);

    let aborted = false;
    try {
      const response = await this.runtime.request({ type: "abort" }, { timeoutMs: this.abortTimeoutMs });
      aborted = response.success === true;
      steps.push(aborted ? "abort acknowledged" : `abort refused: ${response.error ?? "unknown"}`);
    } catch (error) {
      errors.push(`abort failed: ${describe(error)}`);
      steps.push("abort did not complete");
    }

    // `abort_bash` is only meaningful while a command is still running: the
    // runtime's own `abortBash` targets the in-flight bash call.
    let abortBashSent = false;
    if (run.bashOpen) {
      try {
        const response = await this.runtime.request({ type: "abort_bash" }, { timeoutMs: this.abortTimeoutMs });
        abortBashSent = response.success === true;
        steps.push(abortBashSent ? "abort_bash acknowledged" : "abort_bash refused");
      } catch (error) {
        errors.push(`abort_bash failed: ${describe(error)}`);
      }
    }

    const converged = aborted && (await this.waitForConvergence(run.generation));
    steps.push(converged ? "turn converged" : "turn did not converge in time");
    if (converged) {
      this.closeRun(run.generation);
      return { aborted, abortBashSent, converged: true, toreDown: false, steps, errors };
    }

    // The protocol could not stop it. The M2 teardown is the fallback and owns
    // the process group from here; the run is closed either way, because the
    // desktop must not keep reporting a turn the user already cancelled.
    let toreDown = false;
    if (this.teardown) {
      try {
        const result = await this.teardown({ abortBash: run.bashOpen });
        toreDown = true;
        steps.push(`process teardown: reaped=${String(result.reaped)} cleaned=${String(result.cleaned)}`);
        if (!result.reaped || !result.cleaned) {
          errors.push("the runtime process group could not be fully reclaimed");
        }
      } catch (error) {
        errors.push(`process teardown failed: ${describe(error)}`);
      }
    } else {
      errors.push("no process teardown is available");
    }
    this.closeRun(run.generation);
    return { aborted, abortBashSent, converged: false, toreDown, steps, errors };
  }

  /**
   * Close the session: cancel every open dialog and detach.
   *
   * Windows closing and application shutdown both land here, so nothing is left
   * waiting on a UI that no longer exists.
   */
  dispose(reason = "the session was closed"): number {
    const cancelled = this.ui.cancelPending(reason);
    this.detachFrame();
    this.detachFailure();
    this.state = "idle";
    this.run = null;
    this.wakeWaiters();
    return cancelled;
  }

  // -------------------------------------------------------------------------

  private onFrame(frame: OmpFrame): void {
    if (frame.type === "extension_ui_request") {
      const request = this.ui.observe(frame);
      if (request && (request.kind === "approval" || request.kind === "question")) {
        this.onUiRequest?.(request, {
          sessionId: this.sessionId,
          generation: this.ui.currentGeneration(),
        });
      }
      for (const record of this.ui.records().slice(-1)) this.onUiRecord?.(record);
      return;
    }
    if (this.state === "idle") {
      // A frame that arrives with no run in flight belongs to a run that was
      // already closed: attributing it to whatever runs next is exactly the
      // cross-run contamination the generation exists to prevent.
      this.lateFrames += 1;
      return;
    }
    let events: AgentEvent[];
    try {
      events = this.converter.convert(frame);
    } catch (error) {
      this.emitEnvelope({
        sessionId: this.sessionId,
        ...(this.run ? { turnId: this.run.turnId } : {}),
        ts: this.now(),
        event: {
          type: "error",
          error: appError("OMP_EVENT_UNROUTABLE", describe(error), { frameType: String(frame.type) }),
        },
      });
      return;
    }
    for (const event of events) {
      this.trackRunState(event);
      this.emitEnvelope({
        sessionId: this.sessionId,
        ...(this.run ? { turnId: this.run.turnId } : {}),
        ts: this.now(),
        event,
      });
      if (event.type === "agent_end") this.closeRun(this.run?.generation ?? 0);
    }
  }

  private trackRunState(event: AgentEvent): void {
    if (!this.run) return;
    if (event.type === "tool_start" && event.toolName === "bash") {
      this.bashCallIds.add(event.toolCallId);
      this.run.bashOpen = true;
      return;
    }
    if (event.type === "tool_end" && this.bashCallIds.delete(event.toolCallId)) {
      // Only the bash calls that are still open count: a parallel tool
      // finishing must not clear the flag for a command that is still running.
      this.run.bashOpen = this.bashCallIds.size > 0;
    }
  }

  private onTransportFailure(error: OmpRuntimeError): void {
    // A dead transport ends the run *and* everything waiting on a dialog: the
    // desktop must see one definite failure rather than a turn that hangs.
    const cancelled = this.ui.cancelPending(`the runtime transport failed: ${error.code}`);
    const run = this.run;
    this.closeRun(run?.generation ?? 0);
    this.emitEnvelope({
      sessionId: this.sessionId,
      ...(run ? { turnId: run.turnId } : {}),
      ts: this.now(),
      event: {
        type: "error",
        error: appError(`OMP_${error.code.toUpperCase().replace(/-/g, "_")}`, error.message, {
          detail: error.detail,
          cancelledRequests: cancelled,
        }),
      },
    });
  }

  private closeRun(generation: number): void {
    this.lastClosedGeneration = Math.max(this.lastClosedGeneration, generation);
    this.state = "idle";
    this.run = null;
    this.bashCallIds.clear();
    this.wakeWaiters();
  }

  /** Wait until the turn reports completion, bounded by `convergeTimeoutMs`. */
  private async waitForConvergence(generation: number): Promise<boolean> {
    const deadline = this.now() + this.convergeTimeoutMs;
    while (this.now() < deadline) {
      if (this.runClosed(generation)) return true;
      const remaining = Math.max(0, deadline - this.now());
      await this.waitForChange(Math.min(250, remaining));
    }
    return this.runClosed(generation);
  }

  /**
   * True when this run is over.
   *
   * Read through a method, not inline: the state changes while this waits, and
   * a narrowed property read would keep the value the loop started with.
   */
  private runClosed(generation: number): boolean {
    return this.state === "idle" || this.run?.generation !== generation;
  }

  private waitForChange(timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.add(wake);
    });
  }

  private wakeWaiters(): void {
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
  }

  /** Frames a closed run received after it ended, for the validation report. */
  lateFrameCount(): number {
    return this.lateFrames;
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new OmpRuntimeError("stopping", `the session runner is closed (${this.disposed.code})`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
