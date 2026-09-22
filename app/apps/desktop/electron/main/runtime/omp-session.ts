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
import { existsSync } from "node:fs";
import { join } from "node:path";

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

export type OmpSessionBridge = {
  /** Resolve the gate path this build would load (diagnostics and tests). */
  gatePath(): string | null;
  prompt(input: { sessionId: string; content: string; projectPath: string | null }): Promise<OmpPromptResult>;
  stop(sessionId: string): Promise<OmpStopOutcome>;
  resolveUi(
    sessionId: string | undefined,
    requestId: string,
    decision: OmpUiDecision,
  ): { ok: boolean; reason?: string; detail?: string };
  resolveAsk(resolution: AskToolResolution): { ok: boolean; reason?: string; detail?: string };
  status(sessionId: string): OmpSessionStatus;
  /** Whether a dialog with this id is still waiting (resolution routing). */
  hasPendingRequest(requestId: string): boolean;
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
  /** The wire identity of each open approval, for the resolution IPC. */
  const approvalRequests = new Map<string, { request: OmpUiRequest; sessionId: string }>();
  const askRequests = new Map<string, { request: OmpUiRequest; sessionId: string }>();

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
    const supervisor = options.supervisor;
    if (!runner) {
      const status = supervisor.status();
      if (status.phase !== "idle") {
        await supervisor.start();
      }
      const runtime = runtimeHandle(supervisor);
      runner = (options.runnerFactory ?? ((runnerOptions) => new OmpSessionRunner(runnerOptions)))({
        sessionId: input.sessionId,
        runtime,
        emit: (envelope) => options.emitAgentEvent(envelope),
        onUiRequest: (request, info) => surfaceUiRequest(request, info.sessionId),
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
      logger?.app("omp", "info", "omp session runtime started", {
        data: { sessionId: input.sessionId, projectPath: input.projectPath, gate },
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

  function surfaceUiRequest(request: OmpUiRequest, sessionId: string): void {
    const ts = now();
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
      approvalRequests.set(request.frameId, { request, sessionId });
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
      askRequests.set(request.frameId, { request, sessionId });
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
      askRequests.set(request.frameId, { request, sessionId });
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

  function resolveUi(
    sessionId: string | undefined,
    requestId: string,
    decision: OmpUiDecision,
  ): { ok: boolean; reason?: string; detail?: string } {
    const active = runner;
    if (!active) return { ok: false, reason: "unknown", detail: "no OMP session is running" };
    if (sessionId && boundSessionId && sessionId !== boundSessionId) {
      return { ok: false, reason: "unknown", detail: "the decision names another session" };
    }
    const result = active.resolveUiRequest(requestId, decision);
    approvalRequests.delete(requestId);
    askRequests.delete(requestId);
    return result;
  }

  async function stop(sessionId: string): Promise<OmpStopOutcome> {
    approvalRequests.clear();
    askRequests.clear();
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
    if (runner) runner.dispose(reason);
    await options.supervisor.reclaimAll().catch(() => undefined);
    runner = null;
    boundSessionId = null;
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
    if (!runner) return false;
    return runner.openRequests().some((entry) => entry.requestId === requestId);
  }

  return {
    gatePath,
    prompt,
    stop,
    resolveUi,
    resolveAsk,
    status,
    hasPendingRequest,
    dispose,
    diagnostics,
  };

  /** A plain ask answer from the desktop's card maps onto a select decision. */
  function resolveAsk(resolution: AskToolResolution): { ok: boolean; reason?: string; detail?: string } {
    const entry = askRequests.get(resolution.requestId);
    if (!entry) {
      return { ok: false, reason: "unknown", detail: "no OMP question is waiting for this id" };
    }
    if (resolution.sessionId !== entry.sessionId) {
      return { ok: false, reason: "unknown", detail: "the answer names another session" };
    }
    const answers = resolution.answers ?? [];
    const first = answers[0];
    if (!first || first.length === 0) {
      // A skipped question is not an approval: cancel it, which the runtime
      // resolves as "no answer" for that dialog.
      return resolveUi(entry.sessionId, resolution.requestId, "deny");
    }
    const chosen = first[0] ?? "";
    if (entry.request.kind === "question" && entry.request.method === "confirm") {
      return resolveUi(entry.sessionId, resolution.requestId, chosen === "Yes" ? "allow-once" : "deny");
    }
    const offered = entry.request.kind === "question" ? (entry.request.options ?? []) : [];
    if (!offered.includes(chosen)) {
      // An answer the runtime never offered is not a decision; refusing keeps
      // the dialog open instead of sending a value the requester cannot parse.
      return { ok: false, reason: "unknown", detail: "the answer is not one of the offered options" };
    }
    const active = runner;
    if (!active) return { ok: false, reason: "unknown", detail: "the OMP runtime is not running" };
    const result = active.resolveUiRequest(resolution.requestId, "allow-once", { value: chosen });
    approvalRequests.delete(resolution.requestId);
    askRequests.delete(resolution.requestId);
    return result;
  }
}
