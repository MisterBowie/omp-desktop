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
import type { AgentEvent, AgentEventEnvelope, AppError } from "@pi-desktop/shared";

import { OmpRuntimeError } from "../errors.js";
import type { OmpFrame } from "../protocol.js";
import { appError, OmpEventConverter } from "./events.js";
import { classifyUiRequest } from "./ui-requests.js";
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
   * A dialog is no longer answerable (retracted by the runtime, or cancelled
   * because its run ended, stopped, failed or was replaced).
   *
   * The desktop's own bookkeeping is keyed by request id and must forget it in
   * step with this registry, or a later question would report a dialog as
   * pending that the runtime has already abandoned.
   */
  onUiClosed?: (requestId: string, reason: string) => void;
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
  private readonly onUiClosed: ((requestId: string, reason: string) => void) | undefined;
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
  /**
   * Generations that presented at least one dialog to the desktop.
   *
   * A dialog the user can see must be withdrawn when its run dies; a run that
   * never showed one needs no terminal event of its own (its caller already
   * received the failure).
   */
  private readonly generationsWithDialogs = new Set<number>();
  /** Generations whose terminal event was already emitted (emit at most once). */
  private readonly terminalSignalled = new Set<number>();
  private lateFrames = 0;
  private readonly waiters = new Set<() => void>();
  private disposed: { code: string; message: string } | null = null;

  constructor(options: OmpSessionRunnerOptions) {
    this.sessionId = options.sessionId;
    this.runtime = options.runtime;
    this.emitEnvelope = options.emit;
    this.onUiRequest = options.onUiRequest;
    this.onUiRecord = options.onUiRecord;
    this.onUiClosed = options.onUiClosed;
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
    // Defence in depth: a dialog from an earlier run can never be answered into
    // this one, so it is closed before the new generation exists.
    this.cancelOpenDialogs("the run was replaced by a new prompt");
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
    try {
      const response = await this.runtime.request({ type: "prompt", message }, { timeoutMs: 30_000 });
      if (response.success === false) {
        throw new OmpRuntimeError(
          "not-started",
          `the runtime refused the prompt: ${response.error ?? "unknown error"}`,
        );
      }
      return { accepted: true, turnId, generation };
    } catch (error) {
      // The run never started, so anything it raised on the way is unanswerable:
      // close the generation (cancelling its dialogs exactly once) and leave the
      // runner idle before the original failure reaches the caller.
      this.closeGeneration(generation, "the prompt was refused by the runtime", {
        error: appError(
          `OMP_${(error as OmpRuntimeError)?.code
            ? String((error as OmpRuntimeError).code).toUpperCase().replace(/-/g, "_")
            : "PROMPT_FAILED"}`,
          error instanceof Error ? error.message : String(error),
        ),
        whenCardsPresented: true,
      });
      throw error;
    }
  }

  /**
   * Answer one open dialog with the user's decision.
   *
   * `value` names the option a question's user actually picked; approvals
   * ignore it, because their meaning is the decision, not a label.
   *
   * `sessionId` and `generation` are the identity the *desktop* stored when it
   * surfaced the request. Supplying them is how a decision is bound to the
   * session and run it was raised for: a decision that names another session,
   * or whose dialog was raised by a run that has since been superseded, is
   * refused here rather than being delivered to whatever is running now.
   */
  resolveUiRequest(
    requestId: string,
    decision: OmpUiDecision,
    options: { value?: string; sessionId?: string; generation?: number } = {},
  ): { ok: boolean; reason?: string; detail?: string } {
    if (options.sessionId !== undefined && options.sessionId !== this.sessionId) {
      return { ok: false, reason: "unknown", detail: "the decision names another session" };
    }
    const result = this.ui.resolve(requestId, decision, {
      ...(options.value === undefined ? {} : { value: options.value }),
      ...(options.generation === undefined ? {} : { generation: options.generation }),
    });
    for (const record of this.ui.records().slice(-1)) this.onUiRecord?.(record);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, detail: result.detail };
  }

  /**
   * Fail closed for one dialog the desktop can no longer deliver an answer to.
   *
   * Used when a user skips a question or picks something the runtime's protocol
   * cannot carry: the request is answered `cancelled` and both layers forget it,
   * so the runtime is never left waiting on a card the user has dismissed.
   */
  cancelUiRequest(requestId: string, reason: string): boolean {
    const cancelled = this.ui.cancel(requestId, reason);
    if (cancelled) this.onUiClosed?.(requestId, reason);
    return cancelled;
  }

  /** Cancel every open dialog, notifying the owner of each id. */
  private cancelOpenDialogs(reason: string): string[] {
    const cancelled = this.ui.cancelPending(reason);
    for (const requestId of cancelled) this.onUiClosed?.(requestId, reason);
    return cancelled;
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
    const cancelled = this.cancelOpenDialogs("the run was stopped");
    if (cancelled.length > 0) steps.push(`cancelled ${cancelled.length} pending request(s)`);

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
    const cancelled = this.cancelOpenDialogs(reason).length;
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
      const classified = classifyUiRequest(frame);
      if (!classified) return;
      if (classified.kind === "approval" || classified.kind === "question") {
        // A dialog belongs to the run that raised it. With no run in flight —
        // not started, already ended, or stopping — it can never be answered
        // into anything, so it is refused immediately: presenting it would
        // create a card whose decision the runtime has no turn to apply to.
        if (this.state !== "running") {
          this.ui.decline(
            classified,
            this.state === "stopping"
              ? "the run was stopping when the dialog arrived"
              : "no run is active for this dialog",
          );
          for (const record of this.ui.records().slice(-1)) this.onUiRecord?.(record);
          return;
        }
        this.ui.observe(frame);
        this.generationsWithDialogs.add(this.ui.currentGeneration());
        this.onUiRequest?.(classified, {
          sessionId: this.sessionId,
          generation: this.ui.currentGeneration(),
        });
        for (const record of this.ui.records().slice(-1)) this.onUiRecord?.(record);
        return;
      }
      const request = this.ui.observe(frame);
      if (request?.kind === "cancel") {
        // The runtime withdrew its own request; the dialog disappears from the
        // runtime's side, so the desktop must forget it too.
        this.onUiClosed?.(request.targetId, "the runtime retracted its request");
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
      if (event.type === "agent_end") {
        // The run is over: any dialog it raised can no longer be answered into
        // it, so it is cancelled rather than left pending for the next run.
        this.cancelOpenDialogs("the run ended before the dialog was answered");
        this.closeRun(this.run?.generation ?? 0);
      }
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
    const cancelled = this.ui.open().length;
    const run = this.run;
    this.closeGeneration(
      run?.generation ?? this.ui.currentGeneration(),
      `the runtime transport failed: ${error.code}`,
      {
        error: appError(`OMP_${error.code.toUpperCase().replace(/-/g, "_")}`, error.message, {
          detail: error.detail,
          cancelledRequests: cancelled,
        }),
        // A dead runtime is a failure of the run itself: the desktop is told
        // even when no dialog was involved.
        whenCardsPresented: false,
      },
    );
  }

  /**
   * Emit the one event that tells the desktop this run is over.
   *
   * The transcript's terminal events (`agent_end`, `error`) are what the store
   * clears a session's pending permissions and asks on, so a run that presented
   * a dialog and then failed must emit exactly one of them — otherwise the card
   * the user can see stays queued for a run that no longer exists. Emitting is
   * idempotent per generation: a prompt failure and a transport failure can
   * race, and the user must not see two errors for one failure.
   */
  private signalTerminal(generation: number, error: AppError): void {
    if (this.terminalSignalled.has(generation)) return;
    this.terminalSignalled.add(generation);
    if (this.terminalSignalled.size > 16) {
      const oldest = this.terminalSignalled.values().next().value;
      if (oldest !== undefined) this.terminalSignalled.delete(oldest);
    }
    this.emitEnvelope({
      sessionId: this.sessionId,
      ...(this.run && this.run.generation === generation ? { turnId: this.run.turnId } : {}),
      ts: this.now(),
      event: { type: "error", error },
    });
  }

  /**
   * Close one generation: cancel its dialogs, forget the run, go idle.
   *
   * Idempotent on purpose — a prompt failure and a transport failure can race,
   * and the second caller must not write a second cancellation or re-close a
   * run that is already gone.
   */
  private closeGeneration(
    generation: number,
    reason: string,
    failure: { error: AppError; whenCardsPresented: boolean } | null = null,
  ): void {
    const presented = this.generationsWithDialogs.delete(generation);
    const open = this.ui.open();
    if (open.length > 0) this.cancelOpenDialogs(reason);
    if (failure && (!failure.whenCardsPresented || presented)) {
      // The run's dialogs are gone, so the desktop needs the terminal event that
      // withdraws them; the failure itself is reported either way by the caller
      // that received the exception.
      this.signalTerminal(generation, failure.error);
    }
    if (this.run?.generation === generation || this.state !== "idle") {
      this.closeRun(generation);
    }
    // A concurrent path already closed the run; the dialogs (if any survived it)
    // were cancelled above, so there is nothing left to do.
  }

  private closeRun(generation: number): void {
    this.lastClosedGeneration = Math.max(this.lastClosedGeneration, generation);
    this.state = "idle";
    this.run = null;
    this.bashCallIds.clear();
    this.generationsWithDialogs.delete(generation);
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
