/**
 * Desktop side of one OMP conversation: start the runtime for a session, stream
 * its events into the desktop's vocabulary, and answer its dialogs.
 *
 * The pieces below it already exist and are not re-implemented here: M2's
 * supervisor owns the process, its isolated home and the process-group
 * teardown; the runtime package owns framing, the event translation and the
 * decision registry. This module is the wiring, plus the three product
 * decisions that wiring has to make:
 *
 *   1. **One runtime, one session (M3).** An OMP process hosts one native
 *      session with its own transcript. This build binds the runtime to the
 *      first session that prompts it, runs in that session's project directory,
 *      and refuses a different session instead of pretending two projects share
 *      a runtime. Engine-side session switching is M4.
 *   2. **The gate is loaded, or the engine stays closed.** A runtime started
 *      without `--extension <gate>` would execute native tools with no
 *      pre-execution approval at all. If the gate cannot be found, the prompt
 *      is refused and the reason is reported; there is no unguarded fallback.
 *   3. **Approvals and questions reach the existing cards.** A gate approval
 *      becomes the desktop's `tool_permission_request` envelope and a question
 *      becomes `asktool_request` — the same events the Pi path emits, so
 *      `PermissionCard` / `AskToolCard` and their resolution IPC work unchanged.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import {
  ErrorCodes,
  type AgentEventEnvelope,
  type AskToolRequest,
  type AskToolResolution,
  type MessageUsage,
  type Risk,
  type ToolPermissionRequest,
  type UiMessage,
} from "@pi-desktop/shared";
import { BUNDLED_GATE_PATH } from "./omp-runtime";
import {
  OmpSessionRunner,
  descriptorRisk,
  findGateExtension,
  type OmpRunState,
  type OmpRuntimeSupervisor,
  type OmpSessionRuntime,
  type OmpStopOutcome,
  type OmpUiDecision,
  type OmpUiRequest,
} from "@pi-desktop/omp-runtime";

export type OmpSessionBridgeLogger = {
  app(
    scope: string,
    level: "info" | "warn" | "error",
    message: string,
    fields?: { data?: Record<string, unknown> },
  ): void;
};

export type OmpSessionBridgeOptions = {
  supervisor: OmpRuntimeSupervisor;
  /** Absolute launcher path, or null when this build has none. */
  launcher: string | null;
  isPackaged: boolean;
  resourcesPath?: string | null;
  /** Start of the development walk-up for the gate extension. */
  appPath: string;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  logger?: OmpSessionBridgeLogger;
  now?: () => number;
  /** Gate policy for this run; defaults to the runtime package's own list. */
  gateTools?: string;
  gateTimeoutMs?: number;
  /** Test seams. */
  runnerFactory?: (options: ConstructorParameters<typeof OmpSessionRunner>[0]) => OmpSessionRunner;
  gateResolver?: (startDir: string) => string | null;
};

export type OmpSessionStatus = {
  isRunning: boolean;
  currentTurnId?: string;
  pendingToolConfirmations: number;
  engine: "omp";
  state: OmpRunState;
};

export type OmpPromptResult = { accepted: boolean; turnId: string };

/** The outcome of answering a dialog; a refusal never reached the runtime. */
export type OmpResolution =
  | { ok: true }
  | { ok: false; reason: "unknown" | "duplicate" | "wrong-kind" | "stale" | "refused"; detail: string };

/**
 * The working directory a session's runtime must run in.
 *
 * The runtime's own session is rooted at the process's working directory, so
 * this is the one place the desktop turns a stored project path into a
 * directory the runtime will use — and the path is checked, not trusted: an
 * empty or relative value would silently root a session in the run directory
 * (or wherever the app happens to have been launched), which is exactly the
 * "writes went somewhere unexpected" failure this validation exists to prevent.
 */
export function resolveProjectDirectory(projectPath: string | null | undefined): string {
  const raw = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!raw) {
    throw Object.assign(
      new Error("this session has no project directory; refusing to start an OMP runtime without one"),
      { errorCode: ErrorCodes.INVALID_ARGUMENT },
    );
  }
  if (!isAbsolute(raw)) {
    throw Object.assign(
      new Error("the session's project directory must be an absolute path"),
      { errorCode: ErrorCodes.INVALID_ARGUMENT },
    );
  }
  const absolute = normalize(raw);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolute);
  } catch {
    throw Object.assign(new Error("the session's project directory does not exist"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  if (!stats.isDirectory()) {
    throw Object.assign(new Error("the session's project directory is not a directory"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  return absolute;
}

export type OmpSessionBridge = {
  /** Resolve the gate path this build would load (diagnostics and tests). */
  gatePath(): string | null;
  prompt(input: { sessionId: string; content: string; projectPath: string | null }): Promise<OmpPromptResult>;
  stop(sessionId: string): Promise<OmpStopOutcome>;
  /**
   * Answer a tool approval.
   *
   * The renderer sends only the request id and the decision (the Pi path's own
   * contract: the id is an opaque routing token). The session, run and tool
   * call this decision belongs to are the ones the bridge stored when it
   * surfaced the request — the caller cannot name them, and cannot redirect the
   * decision to another session, run or kind of request.
   */
  resolvePermission(requestId: string, decision: OmpUiDecision): OmpResolution;
  /** Answer a question. Never consumes an approval's id, and vice versa. */
  resolveAsk(resolution: AskToolResolution): OmpResolution;
  status(sessionId: string): OmpSessionStatus;
  /** Whether a dialog with this id is still waiting (resolution routing). */
  hasPendingRequest(requestId: string): boolean;
  /** Whether this build ever raised a dialog with this id (routing + refusal). */
  hasKnownRequest(requestId: string): boolean;
  /** The working directory the runtime was started in, once bound. */
  workingDirectory(): string | null;
  /** Reclaim the runtime; used by application shutdown. */
  dispose(reason?: string): Promise<void>;
  /** Diagnostics for the validation report. */
  diagnostics(): ReturnType<OmpSessionRunner["diagnostics"]> & { sessionId: string | null };
};

const REFUSAL = ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE;

export function createOmpSessionBridge(options: OmpSessionBridgeOptions): OmpSessionBridge {
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const resolveGate = options.gateResolver ?? ((startDir: string) => findGateExtension(startDir));

  let runner: OmpSessionRunner | null = null;
  let boundSessionId: string | null = null;
  /** The directory the runtime was started in; a session may not change it. */
  let boundProjectDirectory: string | null = null;
  /**
   * The identity each surfaced dialog is answered under.
   *
   * `generation` is the run that raised it: a decision arriving after that run
   * was stopped or superseded is refused by the runner's own registry, so a
   * decision can never be replayed onto a later run of the same session.
   */
  type PendingDialog = { request: OmpUiRequest; sessionId: string; generation: number };
  const approvalRequests = new Map<string, PendingDialog>();
  const askRequests = new Map<string, PendingDialog>();
  /** Bounded memory of every id this bridge raised, for routing and refusals. */
  const knownRequests = new Map<string, "approval" | "ask">();
  /** Run generation each surfaced dialog belongs to. */
  const generations = new Map<string, number>();

  function generationOf(frameId: string): number {
    return generations.get(frameId) ?? 0;
  }
  const KNOWN_REQUEST_LIMIT = 200;

  function rememberRequest(id: string, kind: "approval" | "ask"): void {
    knownRequests.set(id, kind);
    if (knownRequests.size > KNOWN_REQUEST_LIMIT) {
      const oldest = knownRequests.keys().next().value;
      if (oldest !== undefined) knownRequests.delete(oldest);
    }
  }

  type OmpRefusalReason = "unknown" | "duplicate" | "wrong-kind" | "stale" | "refused";

  function refuse(reason: OmpRefusalReason, detail: string): OmpResolution {
    return { ok: false, reason, detail };
  }

  function gatePath(): string | null {
    if (options.isPackaged && options.resourcesPath) {
      const bundled = join(options.resourcesPath, BUNDLED_GATE_PATH);
      if (existsSync(bundled)) return bundled;
      return null;
    }
    if (!options.launcher) return null;
    return resolveGate(options.appPath);
  }

  function requireRunner(): OmpSessionRunner {
    if (!runner) {
      throw Object.assign(new Error("no OMP runtime is running for this session"), {
        errorCode: "NOT_FOUND",
      });
    }
    return runner;
  }

  async function prompt(input: {
    sessionId: string;
    content: string;
    projectPath: string | null;
  }): Promise<OmpPromptResult> {
    if (!options.launcher) {
      throw Object.assign(
        new Error("this build has no OMP runtime executable; run from a checkout or set OMP_DESKTOP_RUNTIME"),
        { errorCode: "NOT_FOUND" },
      );
    }
    const gate = gatePath();
    if (!gate) {
      // Without the gate the runtime would execute native tools unapproved.
      throw Object.assign(
        new Error("the OMP tool gate extension could not be found; refusing to start an unguarded runtime"),
        { errorCode: REFUSAL },
      );
    }
    if (boundSessionId && boundSessionId !== input.sessionId) {
      throw Object.assign(
        new Error(
          "this runtime already hosts a different OMP session; switching sessions is not available in this build",
        ),
        { errorCode: REFUSAL },
      );
    }
    // The runtime's session is rooted at the process's working directory, so a
    // project directory the runtime is not already running in can only be
    // honoured before it starts. A relative or missing path is refused rather
    // than resolved against wherever the app was launched.
    const projectDirectory = resolveProjectDirectory(input.projectPath);
    if (boundProjectDirectory && boundProjectDirectory !== projectDirectory) {
      throw Object.assign(
        new Error(
          `this OMP runtime already runs in ${boundProjectDirectory}; a different project directory is not supported yet`,
        ),
        { errorCode: REFUSAL },
      );
    }
    const supervisor = options.supervisor;
    if (!runner) {
      try {
        supervisor.setWorkingDirectory(projectDirectory);
      } catch (error) {
        throw Object.assign(
          new Error(
            `the OMP runtime is already running with another working directory: ${(error as Error).message}`,
          ),
          { errorCode: REFUSAL },
        );
      }
      const status = supervisor.status();
      if (status.phase !== "idle") {
        await supervisor.start();
      }
      const runtime = runtimeHandle(supervisor);
      runner = (options.runnerFactory ?? ((runnerOptions) => new OmpSessionRunner(runnerOptions)))({
        sessionId: input.sessionId,
        runtime,
        emit: (envelope) => options.emitAgentEvent(envelope),
        onUiRequest: (request, info) =>
          surfaceUiRequest(request, info.sessionId, info.generation),
        onUiRecord: (record) => {
          logger?.app("omp", "info", "ui request decision", {
            data: {
              sessionId: input.sessionId,
              frameId: record.frameId,
              kind: record.kind,
              outcome: record.outcome,
              decision: record.decision,
            },
          });
        },
        teardown: async (teardownOptions) => {
          const result = await supervisor.stop({ abortBash: teardownOptions.abortBash });
          return { reaped: result.reaped, cleaned: result.cleaned };
        },
        now,
      });
      boundSessionId = input.sessionId;
      boundProjectDirectory = projectDirectory;
      logger?.app("omp", "info", "omp session runtime started", {
        data: { sessionId: input.sessionId, projectDirectory, gate },
      });
    }
    const active = requireRunner();
    const started = await active.prompt(input.content);
    return { accepted: started.accepted, turnId: started.turnId };
  }

  /**
   * The supervisor's live runtime, as the runner's narrow interface.
   *
   * `start()` already proved it exists; a missing handle here would mean the
   * supervisor lost ownership between start and use, which is a bug worth
   * failing loudly on rather than papering over.
   */
  function runtimeHandle(supervisor: OmpRuntimeSupervisor): OmpSessionRuntime {
    const runtime = supervisor.currentRuntime();
    if (!runtime) {
      throw Object.assign(new Error("the OMP runtime is not available after start"), {
        errorCode: "NOT_STARTED",
      });
    }
    return runtime;
  }

  function surfaceUiRequest(
    request: OmpUiRequest,
    sessionId: string,
    generation: number,
  ): void {
    const ts = now();
    // The generation is captured here, with the request: a decision for this
    // dialog is only valid while the run that raised it is the current one.
    generations.set(request.frameId, generation);
    if (request.kind === "approval") {
      const descriptor = request.descriptor;
      const permission: ToolPermissionRequest = {
        requestId: request.frameId,
        sessionId,
        toolCallId: descriptor?.toolCallId ?? request.frameId,
        toolName: descriptor?.toolName ?? "tool",
        argsPreview: descriptor?.argsPreview,
        risk: riskForApproval(request),
        reason: descriptor?.reason ?? request.title,
      };
      approvalRequests.set(request.frameId, { request, sessionId, generation: generationOf(request.frameId) });
      rememberRequest(request.frameId, "approval");
      options.emitAgentEvent({ sessionId, ts, event: { type: "tool_permission_request", request: permission } });
      return;
    }
    if (request.kind === "question" && request.method === "select") {
      const ask: AskToolRequest = {
        requestId: request.frameId,
        sessionId,
        toolCallId: request.frameId,
        questions: [
          {
            question: request.title,
            options: request.options ?? [],
            // The runtime's select answers with exactly one value.
            multiSelect: false,
          },
        ],
      };
      askRequests.set(request.frameId, { request, sessionId, generation: generationOf(request.frameId) });
      rememberRequest(request.frameId, "ask");
      options.emitAgentEvent({ sessionId, ts, event: { type: "asktool_request", request: ask } });
      return;
    }
    if (request.kind === "question" && request.method === "confirm") {
      const ask: AskToolRequest = {
        requestId: request.frameId,
        sessionId,
        toolCallId: request.frameId,
        questions: [
          {
            question: [request.title, request.message].filter(Boolean).join("\n\n"),
            options: ["Yes", "No"],
            multiSelect: false,
          },
        ],
      };
      askRequests.set(request.frameId, { request, sessionId, generation: generationOf(request.frameId) });
      rememberRequest(request.frameId, "ask");
      options.emitAgentEvent({ sessionId, ts, event: { type: "asktool_request", request: ask } });
      return;
    }
    // Free-text dialogs have no card in this build. The registry already
    // answered them fail-closed; say so instead of leaving the user guessing.
    logger?.app("omp", "warn", "unsupported OMP dialog", {
      data: { sessionId, frameId: request.frameId, kind: request.kind },
    });
  }

  function riskForApproval(request: OmpUiRequest): Risk {
    if (request.kind !== "approval") return "high";
    if (request.source === "runtime") {
      // The runtime's own prompt carries no structured risk; the fact that the
      // runtime stopped to ask at all is the signal, so it is treated as high.
      return "high";
    }
    return descriptorRisk(request.descriptor);
  }

  /**
   * Find one pending dialog of the expected kind.
   *
   * The lookup is the authority on identity: the id must be an *open* dialog of
   * this kind, and the session/run it belongs to are read from what the bridge
   * stored when it surfaced the request — never from the caller. A dialog is
   * only consumed once every check has passed: an answer the runtime never
   * offered, or one that names another session, must leave the request open
   * rather than stranding a runtime that is still waiting for it.
   */
  function lookupDialog(
    requestId: string,
    expected: "approval" | "ask",
  ): { ok: true; entry: PendingDialog } | { ok: false; result: OmpResolution } {
    const pending = expected === "approval" ? approvalRequests : askRequests;
    const other = expected === "approval" ? askRequests : approvalRequests;
    const entry = pending.get(requestId);
    if (!entry) {
      if (other.has(requestId)) {
        return {
          ok: false,
          result: refuse(
            "wrong-kind",
            expected === "approval"
              ? "this id belongs to a question, not a tool approval"
              : "this id belongs to a tool approval, not a question",
          ),
        };
      }
      if (knownRequests.has(requestId)) {
        return {
          ok: false,
          result: refuse("duplicate", "this request was already answered or cancelled"),
        };
      }
      return {
        ok: false,
        result: refuse("unknown", "no dialog with this id was raised by this session"),
      };
    }
    if (boundSessionId && entry.sessionId !== boundSessionId) {
      // Belt and braces: the stored entry already names the bound session, so a
      // mismatch means the bridge's own bookkeeping moved under the request.
      return { ok: false, result: refuse("stale", "the request belongs to another session") };
    }
    return { ok: true, entry };
  }

  /** Consume a dialog, so no second reply can reach the runtime. */
  function consume(requestId: string): void {
    approvalRequests.delete(requestId);
    askRequests.delete(requestId);
    generations.delete(requestId);
  }

  function resolvePermission(requestId: string, decision: OmpUiDecision): OmpResolution {
    const found = lookupDialog(requestId, "approval");
    if (!found.ok) return found.result;
    const { entry } = found;
    if (entry.request.kind !== "approval") {
      return refuse("wrong-kind", "the stored dialog is not a tool approval");
    }
    const active = runner;
    if (!active) return refuse("unknown", "no OMP session is running");
    consume(requestId);
    const result = active.resolveUiRequest(requestId, decision, {
      sessionId: entry.sessionId,
      generation: entry.generation,
    });
    if (!result.ok) {
      return refuse(
        result.reason === "stale" ? "stale" : result.reason === "duplicate" ? "duplicate" : "refused",
        result.detail ?? "the runtime refused the decision",
      );
    }
    return { ok: true };
  }

  /**
   * A question's answer from the desktop's card.
   *
   * Confirms become the boolean decision the runtime's `confirm` resolves;
   * selects carry the label the user picked. Neither path can consume an
   * approval, and an empty answer is a cancellation rather than a yes.
   */
  function resolveAsk(resolution: AskToolResolution): OmpResolution {
    const found = lookupDialog(resolution.requestId, "ask");
    if (!found.ok) return found.result;
    const { entry } = found;
    if (entry.request.kind !== "question") {
      return refuse("wrong-kind", "the stored dialog is not a question");
    }
    if (resolution.sessionId !== entry.sessionId) {
      return refuse("stale", "the answer names another session");
    }
    const first = (resolution.answers ?? [])[0];
    const chosen = first && first.length > 0 ? (first[0] ?? "") : "";
    const active = runner;
    if (!active) return refuse("unknown", "no OMP session is running");
    if (entry.request.method === "confirm") {
      if (chosen !== "Yes" && chosen !== "No") {
        return refuse("refused", "a confirmation answer must be Yes or No");
      }
      consume(resolution.requestId);
      const result = active.resolveUiRequest(
        resolution.requestId,
        chosen === "Yes" ? "allow-once" : "deny",
        { sessionId: entry.sessionId, generation: entry.generation },
      );
      return result.ok
        ? { ok: true }
        : refuse("refused", result.detail ?? "the runtime refused the answer");
    }
    const offered = entry.request.options ?? [];
    if (!offered.includes(chosen)) {
      // An answer the runtime never offered is not a decision: refusing keeps
      // the dialog open instead of sending a value the requester cannot parse.
      return refuse("refused", "the answer is not one of the offered options");
    }
    consume(resolution.requestId);
    const result = active.resolveUiRequest(resolution.requestId, "allow-once", {
      sessionId: entry.sessionId,
      generation: entry.generation,
      value: chosen,
    });
    return result.ok ? { ok: true } : refuse("refused", result.detail ?? "the runtime refused the answer");
  }

  /**
   * Stop the current run.
   *
   * The runtime's own order lives in the runner: dialogs cancelled first, then
   * `abort`, then `abort_bash` while a command is still open, then a bounded
   * wait, and only then M2's process teardown.
   */
  async function stop(sessionId: string): Promise<OmpStopOutcome> {
    // The runtime cancels every dialog it is waiting on; the bridge forgets the
    // same ids so a late reply is refused by kind and by identity rather than
    // being replayed into the next run.
    approvalRequests.clear();
    askRequests.clear();
    generations.clear();
    if (!runner) {
      return {
        aborted: false,
        abortBashSent: false,
        converged: true,
        toreDown: false,
        steps: ["nothing running"],
        errors: [],
      };
    }
    if (boundSessionId && boundSessionId !== sessionId) {
      throw Object.assign(new Error("this runtime hosts a different session"), { errorCode: REFUSAL });
    }
    const outcome = await runner.stop();
    logger?.app("omp", "info", "omp stop finished", {
      data: {
        sessionId,
        converged: outcome.converged,
        toreDown: outcome.toreDown,
        steps: outcome.steps,
        errors: outcome.errors,
      },
    });
    return outcome;
  }

  function status(sessionId: string): OmpSessionStatus {
    if (!runner || (boundSessionId && boundSessionId !== sessionId)) {
      return {
        isRunning: false,
        pendingToolConfirmations: 0,
        engine: "omp",
        state: "idle",
      };
    }
    const current = runner.status();
    return {
      isRunning: current.isRunning,
      ...(current.currentTurnId ? { currentTurnId: current.currentTurnId } : {}),
      pendingToolConfirmations: current.pendingToolConfirmations,
      engine: "omp",
      state: runner.runState(),
    };
  }

  async function dispose(reason = "application shutdown"): Promise<void> {
    approvalRequests.clear();
    askRequests.clear();
    generations.clear();
    if (runner) runner.dispose(reason);
    await options.supervisor.reclaimAll().catch(() => undefined);
    runner = null;
    boundSessionId = null;
    boundProjectDirectory = null;
  }

  function diagnostics(): ReturnType<OmpSessionRunner["diagnostics"]> & { sessionId: string | null } {
    if (!runner) {
      return {
        sessionId: boundSessionId,
        lateFrames: 0,
        conversion: { unmappedFrames: {}, toolResultMessages: {}, droppedParts: {}, notes: [] },
        uiRecords: [],
        state: "idle",
      };
    }
    return { sessionId: boundSessionId, ...runner.diagnostics() };
  }

  function hasPendingRequest(requestId: string): boolean {
    return approvalRequests.has(requestId) || askRequests.has(requestId);
  }

  function hasKnownRequest(requestId: string): boolean {
    return knownRequests.has(requestId);
  }

  function workingDirectory(): string | null {
    return boundProjectDirectory;
  }

  return {
    gatePath,
    prompt,
    stop,
    resolvePermission,
    resolveAsk,
    status,
    hasPendingRequest,
    hasKnownRequest,
    workingDirectory,
    dispose,
    diagnostics,
  };
}
