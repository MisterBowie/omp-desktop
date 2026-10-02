import { ErrorCodes, IPC, type AgentEventEnvelope, type AppNotification, type EngineId, type PlanExecution, type PlanExecutionFinishStatus, type UiMessage } from "@pi-desktop/shared";
import { approvedPlanInstruction } from "@pi-desktop/agent-runtime";
import { executionFromResponse, executionListFromResponse, planExecutionFromUnknown } from "@pi-desktop/host-runtime";
import { refuseOutsidePiRuntime, type EngineRouter } from "./engine-router";
import type { RuntimeState } from "./context";
import type { OmpSessionBridge } from "./omp-session";
import type {
  SessionCoordination,
  TurnEndedPayload,
  TurnEndReason,
} from "./session-coordination";

/**
 * Identity and per-call switches of one turn finalization. `turnId` is
 * required: a terminal event, an abort, a crash or a failed start must name the
 * turn it belongs to, and the finalizer never infers it from whichever turn
 * happens to be active.
 */
export type FinishTurnOptions = {
  turnId: string;
  createNotification?: boolean;
  recoverInflight?: boolean;
};

/**
 * The single entry point every terminal path funnels through, so exactly one
 * announcement is made per host turn and the turn's state is released once.
 */
export type FinishTurn = (
  sessionId: string,
  status: TurnEndReason,
  errorCode: string | undefined,
  options: FinishTurnOptions,
) => Promise<void>;

export type PlanRuntimeState = {
  approvedExecutionDrain: Promise<void> | null;
};

export type PlanRuntimeDependencies = {
  runtimeState: RuntimeState;
  planState: PlanRuntimeState;
  logger: { app: (...args: any[]) => void };
  sendToRenderer: (channel: string, payload: unknown) => void;
  /**
   * The single turn coordination instance: active turns, their usage, the
   * finalization records, the abort locks and the identity queries all come
   * from here, so this module never keeps a second copy of that state.
   */
  coordination: SessionCoordination;
  scheduledRunsBySession: Map<string, string>;
  activeToolCalls: Map<string, any>;
  planSubmissionTurnIds: Set<string>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  approvedExecutionTurns: Map<string, any>;
  startedApprovedExecutions: Set<string>;
  finishedApprovedExecutions: Set<string>;
  dispatchingApprovedExecutions: Set<string>;
  inFlightExecutionFinishes: Set<string>;
  pendingExecutionFinishes: Map<string, any>;
  /**
   * Announce a finished turn to the plugin surfaces. Composed by the plugin
   * services factory; this module never reaches a global plugin instance.
   */
  announceTurnEnded: (payload: TurnEndedPayload) => void;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  /**
   * The engine gate (ADR 0300). Resolved lazily because the plan runtime is
   * constructed before the engine runtime exists in the boot sequence.
   *
   * A plan execution starts a turn in the session's own runtime, so every entry
   * into it — the interactive approval and the restore/drain path — passes the
   * same gate as a prompt.
   */
  getEngineRouter: () => EngineRouter | null;
  /**
   * The OMP session bridge, resolved lazily because the registry is wired
   * after the plan runtime in the boot sequence. Null when this build has no
   * OMP runtime: an approved execution for an OMP session is then skipped with
   * nothing changed (the row stays queued), never claimed.
   */
  getOmpSessions: () => OmpSessionBridge | null;
  isQuitting: () => boolean;
  onTurnSettled?: (sessionId: string, turnId: string) => Promise<void>;
};

export function createPlanRuntime({
  runtimeState,
  getEngineRouter,
  getOmpSessions,
  planState,
  logger,
  sendToRenderer,
  coordination,
  scheduledRunsBySession,
  activeToolCalls,
  planSubmissionTurnIds,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  approvedExecutionTurns,
  startedApprovedExecutions,
  finishedApprovedExecutions,
  dispatchingApprovedExecutions,
  inFlightExecutionFinishes,
  pendingExecutionFinishes,
  announceTurnEnded,
  emitAgentEvent,
  acquireSessionOperation,
  resolveAgentRuntimeLaunch,
  isQuitting,
  onTurnSettled,
}: PlanRuntimeDependencies): {
  finishTurn: FinishTurn;
  finishApprovedExecution: (executionId: string, status: PlanExecutionFinishStatus, errorCode?: string) => Promise<void>;
  dispatchApprovedPlan: (rawExecution: unknown) => Promise<void>;
  drainApprovedPlanExecutions: () => Promise<void>;
  dispatchExecutionForProposal: (proposalId: string) => Promise<void>;
  settleOmpTurnEnd: (info: {
    sessionId: string;
    hostTurnId: string | null;
    reason: "completed" | "aborted" | "error";
  }) => void;
} {
// Read the shared turn state once, by the names the finalizer below uses. The
// instance is owned by the coordination factory; this module only reads it.
const {
  activeTurns,
  activeTurnUsages,
  turnFinalizations,
  turnSettlements,
  waitForTurnSettlement,
  planSubmissionTurnKey,
  shouldCreateTaskNotification,
  isActiveTurn,
  peekAbortReason,
  clearAbortReason,
  releaseTurnClaims,
} = coordination;
/** The Agent Host turn state for one settled turn. */
function hostTurnStatus(
  reason: TurnEndReason,
): "completed" | "failed" | "interrupted" {
  if (reason === "aborted") return "interrupted";
  return reason === "error" ? "failed" : "completed";
}

/**
 * The error a settled failing turn carries into Agent Host. The terminal event
 * owns the real message; this path only runs when that event never landed, so the
 * code the settlement recorded is the best available description.
 */
function hostTurnError(
  reason: TurnEndReason,
  errorCode: string | undefined,
): { code: string; message: string; retriable: boolean; traceId: string } | undefined {
  if (reason !== "error") return undefined;
  const code = errorCode ?? "TURN_ERROR";
  return { code, message: code, retriable: false, traceId: "" };
}

/**
 * Settle one host turn: attempt its durable end, release its local state,
 * announce it to the plugin surfaces, then release the claim.
 *
 * The order is part of the contract. Ownership is claimed and the terminal
 * reason frozen synchronously, before any await, so that a concurrent terminal
 * event joins this finalization instead of starting a second one, and so that a
 * cancellation recorded earlier cannot be restated as a completion later.
 */
function finishTurn(
  sessionId: string,
  status: TurnEndReason,
  errorCode: string | undefined,
  options: FinishTurnOptions,
): Promise<void> {
  const id = sessionId.trim();
  // A missing identity cannot be attributed to any turn, so it settles nothing:
  // inferring it from whichever turn is active would let a late event close a
  // turn it does not own. Callers still persist the event as history.
  const turnId = String(options?.turnId ?? "").trim();
  if (!id || !turnId) return Promise.resolve();

  const finalizationKey = planSubmissionTurnKey(id, turnId);
  // A second call joins the first claim. That is what stops a late abort from
  // restating a completion, and what makes the announcement fire once per turn
  // when both agent_end and error arrive.
  const existing = turnFinalizations.get(finalizationKey);
  if (existing) return existing;
  // A turn that no longer owns its session was already settled by whoever took
  // it over. Recreating a record here would release the newer turn's queue, so
  // the settlement is refused — but this turn can no longer finalize itself
  // either, so its records are dropped rather than left behind: its settlement
  // waiters would never resolve, and a later turn on this session would inherit
  // its cancellation lock.
  if (!isActiveTurn(id, turnId)) {
    planSubmissionTurnIds.delete(finalizationKey);
    releaseTurnClaims(id, turnId);
    return Promise.resolve();
  }

  // Set once the durable end settled, so the collaboration hook below only runs
  // for a turn whose durable row really was closed.
  let settledTurnId: string | undefined;

  // Freeze the reason and snapshot the session-keyed data synchronously.
  // Nothing below may read or delete state by session id again: a newer turn can
  // start while this one unwinds, and everything keyed by the session alone is
  // then its data.
  const reason = peekAbortReason(id, turnId) ?? status;
  const turnUsage = activeTurnUsages.get(id);
  activeTurnUsages.delete(id);
  const runId = scheduledRunsBySession.get(id);
  if (runId) scheduledRunsBySession.delete(id);
  const wasPlanSubmission = planSubmissionTurnIds.has(finalizationKey);
  const createNotification =
    options.createNotification ??
    (!wasPlanSubmission && shouldCreateTaskNotification(id));
  const recoverInflight = options.recoverInflight === true;

  const runFinalization = async (): Promise<void> => {
    try {
      if (runtimeState.host) {
        try {
          const result = await runtimeState.host.call<{
            ok: boolean;
            notification?: AppNotification;
            recovered?: UiMessage;
          }>("session.endTurn", {
            turnId,
            status: reason,
            errorCode,
            createNotification,
            ...(turnUsage ? { usage: turnUsage } : {}),
            // The reply can no longer finish on its own: promote its last
            // checkpoint instead of waiting for a final row that never comes.
            ...(recoverInflight ? { recoverInflight: true } : {}),
          });
          settledTurnId = turnId;
          if (result.notification) {
            sendToRenderer(IPC.event.notificationChanged, {
              notification: result.notification,
            });
          }
          if (result.recovered) {
            // Settle the renderer's streaming row the same way a final
            // message_end would have, so it does not stay "streaming" forever.
            emitAgentEvent({
              sessionId: id,
              turnId,
              ts: Date.now(),
              event: { type: "message_end", message: result.recovered },
            } satisfies AgentEventEnvelope);
          }
        } catch (e) {
          logger.app("persistence", "warn", "endTurn failed", {
            sessionId: id,
            data: String(e),
          });
        }
      }

      if (runId && runtimeState.host) {
        await runtimeState.host
          .call("scheduled.finishRun", { runId, status: reason, errorCode })
          .catch((e) =>
            logger.app("persistence", "warn", "finishRun failed", {
              sessionId: id,
              data: String(e),
            }),
          );
      }
    } finally {
      // Do not release local ownership until the durable endTurn request above
      // has settled. Ownership is checked by identity, so this teardown can
      // never release a newer turn.
      if (activeTurns.get(id) === turnId) activeTurns.delete(id);
      planSubmissionTurnIds.delete(finalizationKey);
      // A host tool can finish shortly after the turn is aborted. Keep metadata
      // long enough for a late tool_end to persist a readable historical row,
      // but never clear a newer turn's long-running tools (TaskWait may span
      // this window).
      const toolPrefix = `${id}:`;
      setTimeout(() => {
        for (const [key, call] of activeToolCalls) {
          if (key.startsWith(toolPrefix) && call.turnId === turnId) {
            activeToolCalls.delete(key);
          }
        }
      }, 5 * 60 * 1000).unref();
    }

    // The turn can no longer start a plugin tool, and its finalization record
    // still holds the queue, so the announcement observes a settled turn. Every
    // delivery failure is isolated inside the announcement itself.
    announceTurnEnded({ sessionId: id, turnId, reason });
  };

  let record: Promise<void> | undefined;
  /**
   * Release the claim last, so that a failed persistence attempt or a throwing
   * announcement cannot leave the queue held forever. Only the record this call
   * registered may be removed.
   */
  const releaseFinalization = (): void => {
    if (!record || turnFinalizations.get(finalizationKey) !== record) return;
    turnFinalizations.delete(finalizationKey);
    // The turn is over: its cancellation lock must not outlive it, or a later
    // turn on this session would inherit a stale cancellation.
    clearAbortReason(id, turnId);
    const waiters = turnSettlements.get(finalizationKey);
    if (waiters) {
      turnSettlements.delete(finalizationKey);
      for (const resolve of waiters) resolve();
    }
    // Main is authoritative about the turn's end: the terminal event may have
    // been dropped as stale (`isStaleTerminalEvent`) or never emitted at all, and
    // a turn left active in Agent Host holds that session's queue forever. So the
    // settlement closes the turn in the module, which also releases the queue it
    // was holding. `kick` stays as the belt-and-braces retry for a turn the module
    // never saw.
    if (!isQuitting()) {
      runtimeState.agentHostBridge?.endTurn(
        id,
        turnId,
        hostTurnStatus(reason),
        hostTurnError(reason, errorCode),
      );
      runtimeState.agentHostBridge?.agentHost.kick(id);
    }
    // Settlement of the durable turn is the trigger for the collaborators that
    // follow it; a turn with no durable end has nothing to settle.
    if (!isQuitting() && settledTurnId && typeof onTurnSettled === "function") {
      void onTurnSettled(id, settledTurnId).catch((error: unknown) => {
        logger.app("persistence", "warn", "session collaboration settlement failed", {
          sessionId: id,
          data: String(error),
        });
      });
    }
  };
  // Register the record before the body runs, so a concurrent caller observes
  // the same promise even when this turn had no persistence step to await.
  // `finally` releases the claim after the body settles without swallowing a
  // rejected body: a caller that awaits this promise still sees the failure.
  const finalization = Promise.resolve()
    .then(runFinalization)
    .finally(releaseFinalization);
  record = finalization;
  turnFinalizations.set(finalizationKey, finalization);
  return finalization;
}

async function finishApprovedExecution(
  executionId: string,
  status: PlanExecutionFinishStatus,
  errorCode?: string,
): Promise<void> {
  if (finishedApprovedExecutions.has(executionId)) return;
  if (inFlightExecutionFinishes.has(executionId)) return;
  if (!pendingExecutionFinishes.has(executionId)) {
    pendingExecutionFinishes.set(executionId, { status, errorCode });
  }
  inFlightExecutionFinishes.add(executionId);
  if (!runtimeState.host) {
    inFlightExecutionFinishes.delete(executionId);
    return;
  }
  try {
    const pending = pendingExecutionFinishes.get(executionId) ?? {
      status,
      errorCode,
    };
    await runtimeState.host.call("plans.finishExecution", {
      executionId,
      status: pending.status,
      ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
    });
    finishedApprovedExecutions.add(executionId);
    startedApprovedExecutions.delete(executionId);
    pendingExecutionFinishes.delete(executionId);
    const turn = approvedExecutionTurns.get(executionId);
    const sessionId = turn?.sessionId ?? claimedExecutionSessions.get(executionId);
    if (sessionId && approvedExecutionIdsBySession.get(sessionId) === executionId) {
      approvedExecutionIdsBySession.delete(sessionId);
    }
    approvedExecutionTurns.delete(executionId);
    claimedExecutionSessions.delete(executionId);
  } catch (error) {
    logger.app("runtime", "warn", "approved plan execution finalization failed", {
      data: { executionId, error: String(error) },
    });
  } finally {
    inFlightExecutionFinishes.delete(executionId);
  }
}

async function dispatchApprovedPlan(rawExecution: unknown): Promise<void> {
  const initial = planExecutionFromUnknown(rawExecution);
  if (!initial) {
    logger.app("runtime", "warn", "approved plan execution descriptor was invalid");
    return;
  }
  const releaseSessionOperation = await acquireSessionOperation(initial.sessionId);
  try {
  if (
    initial.state === "running" ||
    initial.state === "interrupted" ||
    initial.state === "completed" ||
    startedApprovedExecutions.has(initial.id) ||
    finishedApprovedExecutions.has(initial.id) ||
    dispatchingApprovedExecutions.has(initial.id)
  ) {
    return;
  }
  if (!runtimeState.host) return;
  dispatchingApprovedExecutions.add(initial.id);
  let claimed = false;
  let turnId: string | undefined;
  try {
    const activeTurnId = activeTurns.get(initial.sessionId);
    if (
      activeTurnId &&
      planSubmissionTurnIds.has(
        planSubmissionTurnKey(initial.sessionId, activeTurnId),
      )
    ) {
      await waitForTurnSettlement(initial.sessionId, activeTurnId);
    }
    if (activeTurns.has(initial.sessionId)) {
      const retry = setTimeout(() => {
        void dispatchApprovedPlan(initial);
      }, 250);
      retry.unref();
      return;
    }
    // Decide the engine before anything durable changes. `plans.claimExecution`
    // moves the row from queued to running, so gating afterwards would leave an
    // execution marked running for a session this build cannot drive — and the
    // failure path would rewrite it as interrupted.
    const sessionResult = await runtimeState.host.call<{ session?: any }>("session.get", {
      id: initial.sessionId,
      messageLimit: 1,
    });
    const session = sessionResult?.session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const engineRouter = getEngineRouter();
    if (!engineRouter) {
      throw Object.assign(new Error("the engine gate is not available"), {
        errorCode: ErrorCodes.ENGINE_UNAVAILABLE,
      });
    }
    // The engine is decided before anything durable changes: `plans.claimExecution`
    // moves the row from queued to running, so gating afterwards would leave an
    // execution marked running for a session this build cannot drive — and the
    // failure path would rewrite it as interrupted. A refusal here (a closed
    // capability, an engine the gate cannot route, a runtime this build cannot
    // drive) skips exactly this execution with nothing changed, so the rest of
    // the drain continues.
    const skipExecution = (refusal: unknown): void => {
      logger.app("runtime", "warn", "approved plan execution skipped", {
        sessionId: initial.sessionId,
        code: (refusal as { errorCode?: string })?.errorCode,
        data: { executionId: initial.id, reason: String((refusal as Error)?.message ?? refusal) },
      });
    };
    let engine: EngineId | undefined;
    try {
      engine = engineRouter.require(session, "prompt");
      // Draining a plan execution into the Pi runtime is Pi-runtime machinery;
      // every other engine is refused before the claim.
      if (engine !== "omp") refuseOutsidePiRuntime(engine, "plan execution");
    } catch (refusal) {
      skipExecution(refusal);
      return;
    }
    if (engine === "omp") {
      await dispatchApprovedPlanToOmp(initial, session);
      return;
    }
    // Only now is the Pi runtime required: the engine is known to be Pi.
    if (!runtimeState.sidecar) return;

    const claimResponse = await runtimeState.host.call("plans.claimExecution", {
      executionId: initial.id,
    });
    const claimedExecution = executionFromResponse(claimResponse);
    if (
      claimedExecution?.state === "interrupted" ||
      claimedExecution?.state === "completed" ||
      claimedExecution?.state === "running"
    ) {
      // A running descriptor is the host's durable ownership signal. It may
      // belong to a previous process and must never be replayed here.
      if (claimedExecution.state !== "running") return;
    }
    const execution: PlanExecution = {
      ...(claimedExecution ?? initial),
      state: "running",
    };
    claimed = true;
    claimedExecutionSessions.set(execution.id, execution.sessionId);

    const settings = await runtimeState.host.call("settings.get");
    const launch = await resolveAgentRuntimeLaunch(
      execution.sessionId,
      session,
      settings,
      { mode: "agent" },
    );
    const turn = await runtimeState.host.call<{ turnId: string }>("session.beginTurn", {
      sessionId: execution.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    turnId = String(turn.turnId || "").trim();
    if (!turnId) throw new Error("execution turn was not created");
    activeTurns.set(execution.sessionId, turnId);
    activeTurnUsages.delete(execution.sessionId);
    approvedExecutionIdsBySession.set(execution.sessionId, execution.id);
    approvedExecutionTurns.set(execution.id, {
      sessionId: execution.sessionId,
      turnId,
    });
    startedApprovedExecutions.add(execution.id);
    const accepted = await runtimeState.sidecar.call<{ accepted: boolean }>(
      "agent.executeApprovedPlan",
      {
        ...launch.sidecarParams,
        mode: "agent",
        turnId,
        execution,
      },
    );
    if (accepted?.accepted !== true) {
      throw new Error("approved plan execution was not accepted");
    }
    logger.app("runtime", "info", "approved plan execution started", {
      sessionId: execution.sessionId,
      data: { executionId: execution.id, turnId },
    });
  } catch (error: any) {
    const errorCode =
      error?.data?.errorCode || error?.errorCode || ErrorCodes.PLAN_EXECUTION_INTERRUPTED;
    // The identity captured before the awaits is the one this turn owns; the
    // finalizer refuses it when the session has moved on.
    if (turnId) {
      await finishTurn(initial.sessionId, "error", errorCode, { turnId });
    }
    if (claimed) {
      await finishApprovedExecution(initial.id, "interrupted", errorCode);
    }
    logger.app("runtime", "warn", "approved plan execution failed to start", {
      sessionId: initial.sessionId,
      data: { executionId: initial.id, error: String(error) },
    });
  } finally {
      dispatchingApprovedExecutions.delete(initial.id);
    }  } finally {
    releaseSessionOperation();
  }

}

/**
 * Dispatch one approved Plan/Goal execution into the OMP runtime.
 *
 * The engine is already known to be OMP. The queued row is claimed exactly
 * once (host CAS), then the shared PI instruction for the immutable artifact is
 * submitted through the bridge's own prompt path — the same prompt path the
 * user entry uses, so the durable host turn is opened exactly once and the
 * session's admitted policy (mode `agent`, the permission mode the approval
 * selected) reaches the runtime. A CAS loser, or a row the host already marked
 * interrupted/completed, never prompts. The execution is settled when the
 * bridge announces that host turn's end (`index.ts`), keyed by the durable
 * host turn id recorded here, so a later turn on the same session can never
 * finish the wrong execution.
 */
async function dispatchApprovedPlanToOmp(
  initial: PlanExecution,
  session: {
    projectPath?: unknown;
    providerId?: unknown;
    modelId?: unknown;
    thinkingLevel?: unknown;
  },
): Promise<void> {
  const omp = getOmpSessions();
  const host = runtimeState.host;
  if (!omp || !host) {
    logger.app("runtime", "warn", "approved plan execution skipped", {
      sessionId: initial.sessionId,
      data: {
        executionId: initial.id,
        reason: !host ? "the host is unavailable" : "the OMP runtime is not wired in this build",
      },
    });
    return;
  }
  // A live OMP turn owns the session's runtime; the runner accepts one prompt
  // at a time, so wait for it exactly like the Pi path waits for its active
  // turn. The row stays queued (nothing claimed) while waiting.
  if (omp.status(initial.sessionId).isRunning) {
    const retry = setTimeout(() => void dispatchApprovedPlan(initial), 250);
    retry.unref();
    return;
  }
  const claimResponse = await host.call("plans.claimExecution", {
    executionId: initial.id,
  });
  const execution = executionFromResponse(claimResponse);
  if (!execution || execution.state !== "running") {
    // The CAS was lost (another dispatcher claimed it) or the row is a durable
    // recovery outcome. Neither may prompt.
    logger.app("runtime", "warn", "approved plan execution claim did not yield a running row", {
      sessionId: initial.sessionId,
      data: { executionId: initial.id, state: execution?.state ?? "missing" },
    });
    return;
  }
  claimedExecutionSessions.set(execution.id, execution.sessionId);
  try {
    // Restore the session's own native identity: without it the bridge would
    // open a new native session and fork the transcript.
    const engineRef = await host
      .call<{
        engineRef?: {
          nativeSessionId?: string | null;
          nativeSessionPath?: string | null;
          adapterVersion?: number | null;
          runtimeVersion?: string | null;
        } | null;
      }>("session.getEngineRef", { id: execution.sessionId })
      .then((response) => response.engineRef ?? null)
      .catch(() => null);
    const started = await omp.prompt({
      sessionId: execution.sessionId,
      content: approvedPlanInstruction(execution),
      projectPath:
        typeof session.projectPath === "string" && session.projectPath.trim()
          ? session.projectPath.trim()
          : null,
      providerId: typeof session.providerId === "string" ? session.providerId : null,
      modelId: typeof session.modelId === "string" ? session.modelId : null,
      thinkingLevel: typeof session.thinkingLevel === "string" ? session.thinkingLevel : null,
      nativeSessionId: engineRef?.nativeSessionId ?? null,
      nativeSessionPath: engineRef?.nativeSessionPath ?? null,
      adapterVersion: engineRef?.adapterVersion ?? null,
      runtimeVersion: engineRef?.runtimeVersion ?? null,
    });
    if (started.accepted !== true || !started.hostTurnId) {
      throw new Error("approved plan execution was not accepted");
    }
    approvedExecutionIdsBySession.set(execution.sessionId, execution.id);
    approvedExecutionTurns.set(execution.id, {
      sessionId: execution.sessionId,
      turnId: started.hostTurnId,
    });
    startedApprovedExecutions.add(execution.id);
    logger.app("runtime", "info", "approved plan execution started", {
      sessionId: execution.sessionId,
      data: { executionId: execution.id, turnId: started.hostTurnId },
    });
  } catch (error: unknown) {
    const errorCode =
      (error as { data?: { errorCode?: string } })?.data?.errorCode ||
      (error as { errorCode?: string })?.errorCode ||
      ErrorCodes.PLAN_EXECUTION_INTERRUPTED;
    await finishApprovedExecution(initial.id, "interrupted", errorCode);
    logger.app("runtime", "warn", "approved plan execution failed to start", {
      sessionId: initial.sessionId,
      data: { executionId: initial.id, error: String(error) },
    });
  }
}

async function drainApprovedPlanExecutions(): Promise<void> {
  if (planState.approvedExecutionDrain) return planState.approvedExecutionDrain;
  planState.approvedExecutionDrain = (async () => {
    // The drain serves both engines: each dispatch resolves the session's
    // engine and refuses/skips before claiming when that engine cannot run the
    // row. Requiring the Pi sidecar here would strand every OMP queued
    // execution (the pre-B2 behavior this replaces).
    if (!runtimeState.host) return;
    for (const [executionId, finish] of pendingExecutionFinishes) {
      await finishApprovedExecution(executionId, finish.status, finish.errorCode);
    }
    const response = await runtimeState.host.call("plans.queuedExecutions");
    for (const execution of executionListFromResponse(response)) {
      // Only queued rows are dispatchable. Running/interrupted rows are durable
      // recovery outcomes and must remain untouched on startup.
      if (execution.state !== "queued") continue;
      await dispatchApprovedPlan(execution);
    }
  })();
  try {
    await planState.approvedExecutionDrain;
  } finally {
    planState.approvedExecutionDrain = null;
  }
}

/**
 * Settle an approved OMP execution whose durable host turn just ended.
 *
 * The bridge calls this exactly once per closed host turn (from its
 * `onTurnEnd`, which `index.ts` composes with the plugin announcement). The Pi
 * path finishes executions from its persisted `agent_end`
 * (`event-persistence.ts`); OMP events never enter that path, so this is the
 * single settlement point for an OMP execution — keyed by the durable host
 * turn id recorded at dispatch, never by session liveness, so a later turn on
 * the same session can never finish the wrong execution.
 */
function settleOmpTurnEnd(info: { sessionId: string; hostTurnId: string | null; reason: "completed" | "aborted" | "error" }): void {
  const executionId = info.hostTurnId
    ? approvedExecutionIdsBySession.get(info.sessionId)
    : undefined;
  if (!executionId) return;
  const executionTurn = approvedExecutionTurns.get(executionId);
  if (executionTurn?.turnId !== info.hostTurnId) return;
  void finishApprovedExecution(
    executionId,
    info.reason === "completed" ? "completed" : "interrupted",
    info.reason === "completed" ? undefined : "PLAN_EXECUTION_INTERRUPTED",
  ).catch((error: unknown) => {
    logger.app("runtime", "warn", "OMP approved execution finalization failed", {
      data: { executionId, error: String(error) },
    });
  });
}

async function dispatchExecutionForProposal(proposalId: string): Promise<void> {
  if (!runtimeState.host) return;
  try {
    const response = await runtimeState.host.call("plans.queuedExecutions");
    const execution = executionListFromResponse(response).find(
      (candidate) => candidate.proposalId === proposalId,
    );
    if (execution?.state === "queued") {
      await dispatchApprovedPlan(execution);
    }
  } catch (error) {
    logger.app("runtime", "warn", "approved plan lookup after resolution failed", {
      data: String(error),
    });
  }
}
  return {
    finishTurn,
    finishApprovedExecution,
    dispatchApprovedPlan,
    drainApprovedPlanExecutions,
    dispatchExecutionForProposal,
    settleOmpTurnEnd,
  };
}
