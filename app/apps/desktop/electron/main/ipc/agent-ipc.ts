import { IPC, ErrorCodes, isGlobalPermissionMode, planGoalCursorError, planGoalCursorRefusal, type AgentEventEnvelope, type AgentPromptRequest, type AgentSteerRequest, type UiMessage, type AgentQueuePushRequest, type AgentStopRequest, type AskToolResolution, type GlobalPermissionMode, type MessageUsage, type PlanExecutionFinishStatus, type PlanResolutionResult, type PlanResolveRequest, type PromptEnhancementRequest, type SessionSummarizeTitleRequest, canonicalThinkingLevel, type ThinkingLevel } from "@pi-desktop/shared";
import type { FinishTurn } from "../runtime/plans";
import { expandSlashInvocation, enhancePromptDraft, summarizeSessionTitle, visionFromModelConfig, type ComposerTemplate, type RuntimeProviderConfig } from "@pi-desktop/agent-runtime";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import { appendPromptFallbackPaths, durableUserMessageId, preparePromptAttachments, type PreparedPromptAttachment } from "../prompt-attachments";
import { executionFromResponse, resolveSessionMessageInput } from "@pi-desktop/host-runtime";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { EngineRouter } from "../runtime/engine-router";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { ComposerCommandService } from "./composer-ipc";
import type { IpcRegistrar } from "./types";
import { withPromptEnhancementTimeout } from "../prompt-enhancement-timeout";
import { refuseOutsidePiRuntime } from "../runtime/engine-router";
import type { OmpSessionBridge } from "../runtime/omp-session";

export type AgentIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  logger: Pick<Logger, "app">;
  vendorOAuth: VendorOAuth;
  agentExtensions: AgentExtensionBridge;
  cancelSessionTools: (sessionId: string, reason?: string) => void;
  persistenceOutbox: PersistenceOutbox;
  dataDir: string;
  activeTurns: Map<string, string>;
  /** Whether the named turn can still start or steer host work. */
  isTurnDispatchable: (sessionId: string, turnId: string | null | undefined) => boolean;
  activeTurnUsages: Map<string, MessageUsage>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  /**
   * Engine gate (M2/T10). Every path that would execute work for a session
   * asks here first, so a session belonging to an engine this build cannot
   * drive is refused instead of being served by the Pi path.
   */
  engineRouter: EngineRouter;
  /**
   * The OMP conversation bridge (M3/T11-T13): the runtime a session runs on,
   * the events it streams and the dialogs it asks. Absent in builds and tests
   * that have no OMP runtime; an OMP session notified without one is refused
   * rather than served by the Pi path.
   */
  ompSessions?: OmpSessionBridge | null;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  finishTurn: FinishTurn;
  /**
   * Record a cancellation before the cancel request is issued, so a terminal
   * event arriving while it is in flight cannot restate the abort as a
   * completion. A session without a live turn locks nothing.
   */
  lockAbortReason: (sessionId: string, turnId: string | null | undefined) => void;
  finishApprovedExecution: (executionId: string, status: PlanExecutionFinishStatus, errorCode?: string) => Promise<void>;
  dispatchApprovedPlan: (execution: unknown) => Promise<void>;
  dispatchExecutionForProposal: (proposalId: string) => Promise<void>;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  optionalWorkspaceRoot: () => Promise<string | null>;
  composerCommandService: Pick<ComposerCommandService, "buildComposerCommands">;
  loadComposerTemplatesCached: (root: string | null) => Promise<ComposerTemplate[]>;
};

function rejectNativeAgentOperation(sessionId: string): void {
  if (sessionId.startsWith("native-pi:")) {
    throw Object.assign(new Error("Operation is unsupported for native Pi sessions"), { errorCode: "NATIVE_PI_UNSUPPORTED" });
  }
}

/** Register prompt, agent lifecycle, queue, approval and plan channels. */
export function registerAgentIpc({
  registrar,
  getHost,
  getSidecar,
  getAgentHostBridge,
  logger,
  vendorOAuth,
  agentExtensions,
  cancelSessionTools,
  persistenceOutbox,
  dataDir,
  activeTurns,
  isTurnDispatchable,
  activeTurnUsages,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  resolveAgentRuntimeLaunch,
  engineRouter,
  ompSessions,
  acquireSessionOperation,
  finishTurn,
  lockAbortReason,
  finishApprovedExecution,
  dispatchApprovedPlan,
  dispatchExecutionForProposal,
  emitAgentEvent,
  setNotificationViewingSessionId,
  optionalWorkspaceRoot,
  composerCommandService,
  loadComposerTemplatesCached,
}: AgentIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  let agentHostBridge: AgentHostBridge | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      agentHostBridge = getAgentHostBridge();
      return fn(...args);
    });
  };
  handle(IPC.invoke.promptEnhance, async (req: PromptEnhancementRequest) => {
    if (!host) throw new Error("backend unavailable");
    const draft = typeof req?.draft === "string" ? req.draft : "";
    if (!draft.trim()) {
      throw Object.assign(new Error("Prompt draft must not be empty"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (draft.trim().startsWith("/")) {
      throw Object.assign(new Error("Slash command drafts cannot be enhanced"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }

    const sessionId =
      typeof req.sessionId === "string" ? req.sessionId.trim() : "";
    const session = sessionId
      ? (await host.call<{ session?: any }>("session.get", { id: sessionId })).session
      : {};
    if (sessionId && !session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launchSessionId = sessionId || `prompt-enhancement:${crypto.randomUUID()}`;
    // A pinned enhancement model is a preference, not a hard requirement: a
    // pin whose provider was disabled, whose account was signed out, or whose
    // binding no longer exists must not take the action down. Try the pin,
    // fall back to the Composer's current model, and record why (ADR 0121).
    const pinnedProviderId =
      typeof settings?.promptEnhancementProviderId === "string"
        ? settings.promptEnhancementProviderId.trim()
        : "";
    const pinnedModelId =
      typeof settings?.promptEnhancementModelId === "string"
        ? settings.promptEnhancementModelId.trim()
        : "";
    const composerProviderId =
      typeof req.providerId === "string" ? req.providerId.trim() : undefined;
    const composerModelId =
      typeof req.modelId === "string" ? req.modelId.trim() : undefined;
    // The enhancement carries its own reasoning level and never follows the
    // conversation's: an unset value means "off", because a rewrite rarely
    // benefits from reasoning and reasoning is the slow path.
    const enhancementThinkingLevel =
      typeof settings?.promptEnhancementThinkingLevel === "string"
        ? settings.promptEnhancementThinkingLevel.trim()
        : "";
    const launchFor = (providerId?: string, modelId?: string) =>
      resolveAgentRuntimeLaunch(launchSessionId, session ?? {}, settings, {
        mode: "agent",
        providerId,
        modelId,
        thinkingLevel: (enhancementThinkingLevel || "off") as ThinkingLevel,
      });
    let launch: Awaited<ReturnType<typeof launchFor>>;
    if (pinnedProviderId) {
      try {
        launch = await launchFor(pinnedProviderId, pinnedModelId || undefined);
      } catch (error) {
        logger.app("session", "warn", "prompt enhancement model unavailable", {
          data: {
            pinnedProviderId,
            pinnedModelId: pinnedModelId || undefined,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        launch = await launchFor(composerProviderId, composerModelId);
      }
    } else {
      launch = await launchFor(composerProviderId, composerModelId);
    }
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;
    // A pin, a slow gateway, or a stalled connection would otherwise hold this
    // promise open indefinitely. Aborting is best-effort (the transport only
    // consults the signal between provider retries); racing the promise is what
    // actually guarantees the caller is released on time.
    const enhancedDraft = await withPromptEnhancementTimeout((signal) =>
      enhancePromptDraft(runtimeProvider, draft, canonicalThinkingLevel(launch.sidecarParams.thinkingLevel), {
        signal,
        sessionId: launchSessionId,
        customTemplate: settings?.promptEnhancementCustomTemplate === true,
        userTemplate:
          typeof settings?.promptEnhancementUserTemplate === "string"
            ? settings.promptEnhancementUserTemplate
            : undefined,
      }),
    );
    logger.app("session", "info", "prompt enhanced", {
      sessionId: sessionId || undefined,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return { enhancedDraft };
  });

  handle(IPC.invoke.sessionSummarizeTitle, async (req: SessionSummarizeTitleRequest) => {
    if (!host) throw new Error("backend unavailable");
    const sessionId = typeof req?.sessionId === "string" ? req.sessionId.trim() : "";
    const userPrompt = typeof req?.userPrompt === "string" ? req.userPrompt.trim() : "";
    if (!sessionId || !userPrompt) {
      throw Object.assign(new Error("sessionId and userPrompt required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const session = (await host.call<{ session?: any }>("session.get", { id: sessionId })).session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launch = await resolveAgentRuntimeLaunch(
      `title-summary:${sessionId}`,
      session,
      settings,
      {
        mode: "agent",
        providerId: typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: "off",
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;

    const title = await summarizeSessionTitle(
      runtimeProvider,
      userPrompt,
      req.assistantReply,
      "off",
      { sessionId },
    );
    logger.app("session", "info", "session title summarized", {
      sessionId,
      data: { title, providerId: launch.providerId, modelId: launch.modelId },
    });
    return { title };
  });

  handle(IPC.invoke.agentSteer, async (req: AgentSteerRequest) => {
    if (
      !req?.sessionId || typeof req.content !== "string" || !req.expectedTurnId ||
      (!req.content.trim() && !req.attachments?.length)
    ) {
      throw Object.assign(new Error("Steering input and expectedTurnId required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // Steering reaches into a running turn, so it is gated the same way as the
    // prompt that started it — and gated *before* the Pi runtime is required, so
    // another engine's session is refused with an accurate reason whether or not
    // the Pi sidecar happens to be running.
    await engineRouter.requireForSession(req.sessionId, "steer");
    if (!host || !sidecar) throw new Error("backend unavailable");
    // A steering input belongs to the turn it names: it is refused once that
    // turn was cancelled, has started finalizing, or no longer owns the session.
    if (!isTurnDispatchable(req.sessionId, req.expectedTurnId)) {
      throw Object.assign(new Error("The target turn has ended"), {
        errorCode: ErrorCodes.TURN_NOT_FOUND,
      });
    }
    const context = await sidecar.call<{ projectPath?: string; supportsVision: boolean }>(
      "agent.steeringContext", { sessionId: req.sessionId, expectedTurnId: req.expectedTurnId },
    );
    const prepared = await preparePromptAttachments(
      dataDir, req.sessionId, context.projectPath, req.attachments ?? [], context.supportsVision,
    );
    const session = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", {
      id: req.sessionId, messageLimit: 1,
    });
    const message: UiMessage = {
      id: durableUserMessageId(req.messageId, session.session?.messages ?? []),
      role: "user",
      content: req.content,
      status: "complete",
      createdAt: new Date().toISOString(),
      steering: true,
      ...(prepared.length ? { attachments: prepared.map((attachment) => attachment.message) } : {}),
    };
    // Revalidate inside the runtime after all file/host IO. A stale target must
    // never turn into a normal prompt or alter the next turn's configuration.
    return sidecar.call<{ accepted: boolean; turnId: string }>("agent.steer", {
      sessionId: req.sessionId, expectedTurnId: req.expectedTurnId, message,
      content: appendPromptFallbackPaths(req.content, prepared),
      attachments: prepared.filter((attachment) => attachment.inlineData).map((attachment) => ({
        path: attachment.message.ref, name: attachment.message.name, kind: attachment.message.kind,
        mimeType: attachment.message.mimeType, size: attachment.message.size, data: attachment.inlineData,
      })),
    });
  });

  handle(IPC.invoke.agentPrompt, async (req: AgentPromptRequest) => {
    if (req.sessionId.startsWith("native-pi:")) {
      // A native Pi session is Pi by construction; it has no engine choice to
      // read, so the Pi runtime is required first.
      if (!sidecar) throw new Error("sidecar unavailable");
      if (req.sessionMessageId || req.truncateFromMessageId || req.truncateBefore !== undefined || req.attachments?.length) {
        throw Object.assign(new Error("Native Pi continuation currently supports text prompts only"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      setNotificationViewingSessionId(req.sessionId);
      return sidecar.call("agent.prompt", {
        sessionId: req.sessionId,
        content: req.content,
        userMessageId: req.messageId,
      });
    }
    if (!host) throw new Error("host unavailable");
    const releaseSessionOperation = await acquireSessionOperation(req.sessionId);
    try {
    const sessionMessage = await resolveSessionMessageInput(host, req);
    // Install the renderer's prompt-time snapshot before any asynchronous
    // setup. This closes the gap where a fast completion could beat the
    // effect that reports the active chat session. Missing or mismatched
    // context is deliberately fail-safe.
    const requestedViewingSessionId =
      typeof req.viewingSessionId === "string" ? req.viewingSessionId.trim() : "";
    setNotificationViewingSessionId(
      requestedViewingSessionId && requestedViewingSessionId === req.sessionId
        ? requestedViewingSessionId
        : null,
    );
    const settings = await host.call<any>("settings.get");
    const sessionResult = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
      messageLimit: 1,
    });
    let session = sessionResult.session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    // Engine gate before anything is launched for this session: a session whose
    // engine cannot prompt in this build is refused here, and no later branch
    // may fall back to the Pi runtime for it. The engine is decided from the
    // durable record, so the refusal does not depend on the Pi sidecar being
    // absent or present.
    const promptEngine = engineRouter.require(session, "prompt");
    // Plan/Goal × Cursor product gate (T20-R3C). The durable binding is the
    // authority, so a stale or imported combination (Plan/Goal + the Cursor
    // provider) is refused here — before any runtime work — instead of running
    // a contract mode whose transition contract Cursor's exec channel cannot
    // honour. The refusal names both escape paths; it never rewrites the mode
    // or the model itself.
    const planGoalRefusal = planGoalCursorRefusal(session.mode, session.providerId);
    if (planGoalRefusal) {
      throw planGoalCursorError(planGoalRefusal);
    }
    if (promptEngine === "omp") {
      // The OMP runtime owns this session's transcript, its tools and its
      // approvals; the Pi sidecar and the host turn queue are not part of this
      // path at all. The user's row is echoed so the optimistic bubble settles,
      // but nothing is written to the desktop's own transcript (M2 decision:
      // one writer per session).
      if (!ompSessions) {
        throw Object.assign(new Error("this build has no OMP runtime"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          engine: "omp",
          capability: "prompt",
        });
      }
      if (req.attachments?.length) {
        // Attachments need a projection into the runtime's message format that
        // this release does not implement; silently dropping them would prompt
        // with less than the user attached.
        throw Object.assign(new Error("OMP sessions do not accept attachments yet"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const projectPath =
        typeof session.projectPath === "string" && session.projectPath.trim()
          ? session.projectPath.trim()
          : null;
      // The native-session reference is a main/host-boundary value: it is read
      // here and handed to the runtime for restore, never surfaced to the
      // renderer. The adapter and runtime versions are read too — the restore
      // path refuses a reference this build cannot understand.
      const engineRef = await host
        .call<{
          engineRef?: {
            nativeSessionId?: string | null;
            nativeSessionPath?: string | null;
            adapterVersion?: number | null;
            runtimeVersion?: string | null;
          } | null;
        }>("session.getEngineRef", { id: req.sessionId })
        .then((r) => r.engineRef ?? null)
        .catch(() => null);
      const ompUserMessage: UiMessage = {
        id: req.messageId ?? `omp-user:${req.sessionId}`,
        role: "user",
        content: req.content,
        createdAt: new Date().toISOString(),
        status: "complete",
      };
      emitAgentEvent({
        sessionId: req.sessionId,
        ts: Date.now(),
        event: { type: "message_start", message: ompUserMessage },
      } satisfies AgentEventEnvelope);
      emitAgentEvent({
        sessionId: req.sessionId,
        ts: Date.now(),
        event: { type: "message_end", message: ompUserMessage },
      } satisfies AgentEventEnvelope);
      logger.app("session", "info", "omp prompt accepted", {
        data: { sessionId: req.sessionId, projectPath },
      });
      return ompSessions.prompt({
        sessionId: req.sessionId,
        content: req.content,
        projectPath,
        providerId: typeof session.providerId === "string" ? session.providerId : null,
        modelId: typeof session.modelId === "string" ? session.modelId : null,
        thinkingLevel: typeof session.thinkingLevel === "string" ? session.thinkingLevel : null,
        nativeSessionId: engineRef?.nativeSessionId ?? null,
        nativeSessionPath: engineRef?.nativeSessionPath ?? null,
        adapterVersion: engineRef?.adapterVersion ?? null,
        runtimeVersion: engineRef?.runtimeVersion ?? null,
      });
    }
    if (!sidecar) throw new Error("sidecar unavailable");
    const truncateFromMessageId =
      typeof req.truncateFromMessageId === "string"
        ? req.truncateFromMessageId.trim()
        : "";
    const truncateBefore =
      typeof req.truncateBefore === "number" &&
      Number.isFinite(req.truncateBefore) &&
      req.truncateBefore >= 0
        ? Math.floor(req.truncateBefore)
        : undefined;
    if (truncateFromMessageId || truncateBefore !== undefined) {
      cancelSessionTools(req.sessionId, "Session turn was replaced");
      // Host-owned cut: the kept prefix never crosses the JSON-RPC pipe
      // (issue #211). Abort any leftover running turn first so beginTurn
      // cannot see AGENT_BUSY after a timed-out retry.
      //
      // Capture the target turn and lock the abort reason before the cancel
      // request, as the plain abort path does: a terminal event arriving while
      // the request is in flight must not restate this abort as a completion.
      const regenerateTurnId = activeTurns.get(req.sessionId);
      lockAbortReason(req.sessionId, regenerateTurnId);
      if (sidecar) {
        await sidecar
          .call("agent.abort", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      if (regenerateTurnId) {
        await finishTurn(req.sessionId, "aborted", "TURN_ABORTED", {
          turnId: regenerateTurnId,
        });
      }

      try {
        await persistenceOutbox.flush(() => host);
        const truncated = await host.call<{
          revision?: {
            rootUserId?: string;
            revisionCount?: number;
            activeRevision?: number;
          } | null;
        }>("session.truncateFrom", {
          sessionId: req.sessionId,
          ...(truncateFromMessageId ? { fromMessageId: truncateFromMessageId } : {}),
          ...(truncateBefore !== undefined ? { truncateBefore } : {}),
        });
        const revision = truncated.revision;
        if (
          revision?.rootUserId &&
          typeof revision.revisionCount === "number" &&
          typeof revision.activeRevision === "number"
        ) {
          (req as any).__revisionMeta = {
            rootUserId: revision.rootUserId,
            revisionCount: revision.revisionCount,
            activeRevision: revision.activeRevision,
          };
        }
      } catch (error) {
        logger.app("persistence", "warn", "truncate regenerate transcript failed", {
          sessionId: req.sessionId,
          data: String(error),
        });
        throw error;
      }
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(req.sessionId);
        sidecar.clearVendorAuthBindings(req.sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      const refreshed = await host.call<{ session?: any }>("session.get", {
        id: req.sessionId,
        messageLimit: 1,
      });
      session = refreshed.session ?? session;
    }

    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);

    // Open a durable turn row, then persist the user message under it.
    const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
      sessionId: req.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
      ...(sessionMessage ? { sessionMessageId: sessionMessage.origin.messageId } : {}),
    });
    const durableTurnId = String(turn?.turnId ?? "").trim();
    if (!durableTurnId) {
      throw new Error("session.beginTurn returned no turn");
    }
    activeTurns.set(req.sessionId, durableTurnId);
    activeTurnUsages.delete(req.sessionId);

    // Slash expansion (D123, ADR 0024): templates expand before persistence
    // so reseed replays exactly what the model saw; the typed form rides along
    // as `command` for transcript display. Skill aliases are converted into a
    // short model instruction that makes the existing Skill tool call
    // explicit, while the typed form remains the visible transcript chip.
    // Builtin/plugin slash aliases never reach this channel, and unknown
    // /names stay literal text.
    let promptContent = sessionMessage?.content ?? req.content;
    let slashCommand: string | undefined;
    if (!sessionMessage && req.content.startsWith("/")) {
      try {
        const root = await optionalWorkspaceRoot();
        const commandEnd = req.content.search(/\s/);
        const commandName = req.content.slice(
          1,
          commandEnd === -1 ? undefined : commandEnd,
        );
        const commands = await composerCommandService.buildComposerCommands(
          launch.projectPath ?? root,
        );
        const command = commands.find((item) => item.name === commandName);
        if (command?.kind === "skill" && command.skillId) {
          const body = commandEnd === -1 ? "" : req.content.slice(commandEnd).trim();
          promptContent = [
            `Call the \`Skill\` tool with id ${JSON.stringify(command.skillId)} before answering this request. Follow the loaded skill instructions.`,
            body,
          ]
            .filter(Boolean)
            .join("\n\n");
          slashCommand = req.content;
        } else {
          const templates = await loadComposerTemplatesCached(root);
          const expansion = expandSlashInvocation(req.content, templates);
          if (expansion) {
            promptContent = expansion.expanded;
            slashCommand = expansion.command;
          }
        }
      } catch (error) {
        logger.app("session", "warn", "slash expansion failed; sending literal text", {
          sessionId: req.sessionId,
          data: String(error),
        });
      }
    }

    // The binding's image override already shaped this modelConfig, so the
    // transport gate and the settings switch cannot disagree.
    const supportsVision = visionFromModelConfig(
      launch.sidecarParams.provider.modelConfig,
    );
    let preparedAttachments: PreparedPromptAttachment[];
    try {
      preparedAttachments = await preparePromptAttachments(
        dataDir,
        req.sessionId,
        typeof session.projectPath === "string" && session.projectPath.trim()
          ? session.projectPath.trim()
          : undefined,
        req.attachments ?? [],
        supportsVision,
      );
    } catch (error) {
      await finishTurn(req.sessionId, "error", (error as any)?.errorCode, {
        turnId: durableTurnId,
      });
      throw error;
    }
    const modelContent = appendPromptFallbackPaths(
      promptContent,
      preparedAttachments,
    );

    // Persist user message
    const revisionMeta = (req as any).__revisionMeta as
      | {
          rootUserId?: string;
          revisionCount?: number;
          activeRevision?: number;
        }
      | undefined;
    // The renderer already shows this row under its own id (D288); persisting
    // and echoing under the same id lets the echo replace it in place.
    const userMessage = {
      id: durableUserMessageId(
        req.messageId,
        Array.isArray(session.messages) ? session.messages : [],
      ),

      role: "user" as const,
      content: promptContent,
      ...(sessionMessage ? { sessionMessage: sessionMessage.origin } : {}),
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      ...(preparedAttachments.length
        ? { attachments: preparedAttachments.map((attachment) => attachment.message) }
        : {}),
      ...(slashCommand ? { command: slashCommand } : {}),
      ...(revisionMeta?.revisionCount
        ? {
            revisionRootId: revisionMeta.rootUserId,
            revisionCount: revisionMeta.revisionCount,
            activeRevision: revisionMeta.activeRevision,
          }
        : {}),
    };
    try {
      await host.call("session.appendMessage", {
        sessionId: req.sessionId,
        message: userMessage,
        turnId: durableTurnId,
      });
    } catch (error) {
      await finishTurn(
        req.sessionId,
        "error",
        (error as { data?: { errorCode?: string }; errorCode?: string })?.data
          ?.errorCode ??
          (error as { errorCode?: string })?.errorCode,
        { turnId: durableTurnId },
      );
      // A turn whose user message could not be appended must not be started:
      // restarting it here would run a prompt the transcript does not contain.
      throw error;
    }
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_start", message: userMessage },
    } satisfies AgentEventEnvelope);
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_end", message: userMessage },
    } satisfies AgentEventEnvelope);

    let result: { accepted: boolean; turnId: string };
    try {
      result = await sidecar.call<{ accepted: boolean; turnId: string }>(
        "agent.prompt",
        {
          ...launch.sidecarParams,
          // The host-created durable turn is the approval identity used by
          // Rust. The runtime must not replace it with a provider-local UUID.
          turnId: durableTurnId,
          content: modelContent,
          ...(sessionMessage ? { sessionMessage: sessionMessage.origin } : {}),
          attachments: preparedAttachments
            .filter((attachment) => attachment.inlineData)
            .map((attachment) => ({
              path: attachment.message.ref,
              name: attachment.message.name,
              kind: attachment.message.kind,
              mimeType: attachment.message.mimeType,
              size: attachment.message.size,
              data: attachment.inlineData,
            })),
          userMessageId: userMessage.id,
          // Per-turn permission ceiling override (R1 leftover; spec §7.3). The
          // sidecar records it on the turn context; enforcement of a NARROWER
          // ceiling still routes through the session's stored mode until
          // host-core `session.beginTurn` accepts the scoped param.
          ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
        },
      );
    } catch (e) {
      await finishTurn(req.sessionId, "error", (e as any)?.errorCode, {
        turnId: durableTurnId,
      });
      throw e;
    }
    logger.app("session", "info", "prompt accepted", {
      sessionId: req.sessionId,
      turnId: result.turnId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
    } finally {
      releaseSessionOperation();
    }
  });

  handle(IPC.invoke.agentCompact, async (req: { sessionId: string }) => {
    rejectNativeAgentOperation(req.sessionId);
    // Compaction rewrites the session's context inside its own runtime; the
    // engine is decided before the Pi runtime is required.
    const compactEngine = await engineRouter.requireForSession(req.sessionId, "prompt");
    // Compaction is a Pi-runtime command in this release: an OMP session owns
    // its own context management, and forwarding this to the Pi runtime would
    // compact a transcript that runtime has never seen.
    refuseOutsidePiRuntime(compactEngine, "compaction");
    if (!host || !sidecar) throw new Error("backend unavailable");
    if (activeTurns.has(req.sessionId)) {
      throw Object.assign(new Error("Session already has an active turn"), {
        errorCode: ErrorCodes.AGENT_BUSY,
      });
    }
    const settings = await host.call<any>("settings.get");
    const detail = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
    });
    if (!detail.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      detail.session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);
    const result = await sidecar.call("agent.compact", launch.sidecarParams);
    logger.app("session", "info", "context compacted manually", {
      sessionId: req.sessionId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
  });

  handle(IPC.invoke.agentAbort, async (req: { sessionId: string; turnId?: string }) => {
    const abortEngine = await engineRouter.requireForSession(req.sessionId, "stop");
    if (abortEngine === "omp") {
      if (!ompSessions) {
        throw Object.assign(new Error("this build has no OMP runtime"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          engine: "omp",
          capability: "stop",
        });
      }
      // The runtime's own stop order lives in the bridge: protocol abort first,
      // `abort_bash` only while a command is still running, then M2's process
      // teardown as the fallback. No desktop turn bookkeeping is touched: an
      // OMP turn is not the host's to finish.
      const outcome = await ompSessions.stop(req.sessionId);
      logger.app("session", "info", "omp abort finished", {
        data: {
          sessionId: req.sessionId,
          converged: outcome.converged,
          toreDown: outcome.toreDown,
        },
      });
      return { ok: true, aborted: outcome.converged || outcome.toreDown, steps: outcome.steps };
    }
    if (!sidecar) throw new Error("sidecar unavailable");
    const releaseSessionOperation = req.turnId ? await acquireSessionOperation(req.sessionId) : undefined;
    try {
    const abortedTurnId = activeTurns.get(req.sessionId);
    if (req.turnId && abortedTurnId !== req.turnId) return { ok: false, aborted: false };
    logger.app("session", "info", "prompt aborted", { sessionId: req.sessionId });
    agentHostBridge?.markAborting(req.sessionId);
    // Lock the abort reason before the first await: the cancel RPC can take a
    // while, and a terminal event arriving in that window must not settle the
    // turn as completed.
    lockAbortReason(req.sessionId, abortedTurnId);
    const executionId =
      approvedExecutionIdsBySession.get(req.sessionId) ??
      [...claimedExecutionSessions].find(
        ([, sessionId]) => sessionId === req.sessionId,
      )?.[0];
    let result: unknown;
    try {
      // An open extension prompt resolves with its abort value (spec 16 §9).
      agentExtensions.cancelPrompts(req.sessionId);
      cancelSessionTools(req.sessionId, "Session turn was aborted");
      result = await sidecar.call("agent.abort", req);
    } finally {
      // A turn that already stopped owning the session is refused inside the
      // finalizer, so the identity captured above is the only one used here.
      if (abortedTurnId) {
        await finishTurn(req.sessionId, "aborted", "TURN_ABORTED", {
          turnId: abortedTurnId,
        });
      }
      if (executionId) {
        await finishApprovedExecution(
          executionId,
          "interrupted",
          "PLAN_EXECUTION_INTERRUPTED",
        );
      }
    }
    return result;
    } finally {
      releaseSessionOperation?.();
    }
  });

  handle(IPC.invoke.agentStop, async (req: AgentStopRequest) => {
    const stopEngine = await engineRouter.requireForSession(req.sessionId, "stop");
    if (stopEngine === "omp") {
      if (!ompSessions) {
        throw Object.assign(new Error("this build has no OMP runtime"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          engine: "omp",
          capability: "stop",
        });
      }
      // A graceful stop for OMP is the same sequence as an abort: the runtime
      // decides when the turn ends, and the desktop's `agent_end` envelope is
      // what finishes the row.
      const outcome = await ompSessions.stop(req.sessionId);
      return { accepted: true, status: ompSessions.status(req.sessionId), steps: outcome.steps };
    }
    if (!sidecar) throw new Error("sidecar unavailable");
    logger.app("session", "info", "prompt graceful stop requested", {
      sessionId: req.sessionId,
    });
    // The runtime owns the boundary decision. Do not close the durable turn
    // here: agent_end must arrive after the current reply/tool batch completes
    // and finish it as a normal completed turn.
    return sidecar.call("agent.stop", req);
  });

  handle(IPC.invoke.agentGetStatus, async (sessionId: string) => {
    // A read, answered truthfully by the owning engine: a session executed
    // elsewhere holds no Pi turn, and asking the Pi runtime about it would
    // report a state that belongs to a different runtime. The answer must not
    // depend on whether the Pi sidecar happens to be running.
    const engine = await engineRouter.engineForSession(sessionId);
    if (engine === "omp") {
      // Answered by the runtime that owns the session, so a running OMP turn
      // is reported as running instead of as an idle engine.
      const status = ompSessions?.status(sessionId);
      return {
        status: {
          sessionId,
          isRunning: status?.isRunning === true,
          ...(status?.currentTurnId ? { currentTurnId: status.currentTurnId } : {}),
          pendingToolConfirmations: status?.pendingToolConfirmations ?? 0,
        },
      };
    }
    if (engine !== "pi") {
      return { status: { sessionId, isRunning: false, pendingToolConfirmations: 0 } };
    }
    if (!sidecar) throw new Error("sidecar unavailable");
    return sidecar.call("agent.getStatus", { sessionId });
  });

  // ---------------------------------------------------------------------------
  // OMP runtime subagent reads (T17). These are OMP-only: a Pi session or an
  // OMP session with the capability closed is refused before any host/Pi
  // mutation, and the Pi subagent catalog channels above are untouched.
  // ---------------------------------------------------------------------------

  async function requireOmpSubagentAccess(sessionId: string): Promise<OmpSessionBridge> {
    const engine = await engineRouter.requireForSession(sessionId, "subagentEvents");
    if (engine !== "omp") {
      throw Object.assign(
        new Error("subagent reads are only available for OMP sessions"),
        { errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE, engine, capability: "subagentEvents" },
      );
    }
    if (!ompSessions) {
      throw Object.assign(new Error("this build has no OMP runtime"), {
        errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
        engine: "omp",
        capability: "subagentEvents",
      });
    }
    return ompSessions;
  }

  handle(IPC.invoke.ompSubagentList, async (sessionId: string) => {
    const bridge = await requireOmpSubagentAccess(sessionId);
    return bridge.listSubagents(sessionId);
  });

  handle(IPC.invoke.ompSubagentRead, async (req: { sessionId: string; subagentId: string; fromByte?: number }) => {
    const bridge = await requireOmpSubagentAccess(req.sessionId);
    return bridge.readSubagentTranscript(req.sessionId, req.subagentId, req.fromByte);
  });

  handle(IPC.invoke.ompSubagentStop, async (req: { sessionId: string; subagentId: string }) => {
    const bridge = await requireOmpSubagentAccess(req.sessionId);
    // Refused unconditionally by the bridge: the pinned runtime has no per-child
    // stop command, and there is no trustworthy child-owned process handle.
    return bridge.stopSubagent(req.sessionId, req.subagentId);
  });

  // The Host-owned turn queue (D375 / D386). The renderer mirrors it; the
  // headless module admits, orders, and drains it.
  handle(IPC.invoke.agentQueuePush, async (req: AgentQueuePushRequest) => {
    rejectNativeAgentOperation(req.sessionId);
    // A queued entry becomes a turn, so it needs the same gate as a prompt —
    // and the queue itself is host-owned machinery that drains into the Pi
    // runtime, so an OMP session must not be admitted to it.
    refuseOutsidePiRuntime(await engineRouter.requireForSession(req.sessionId, "prompt"), "the turn queue");
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return agentHostBridge.queue.push(req);
  });
  handle(IPC.invoke.agentQueueList, async (req: { sessionId: string }) => {
    rejectNativeAgentOperation(req.sessionId);
    // A read: the queue drains into the session's engine, so a session this
    // build cannot drive has no entries here — and none can be added (push is
    // gated). Answering without the engine's queue is the truthful read, and it
    // must not depend on the agent host being up.
    const engine = await engineRouter.engineForSession(req.sessionId);
    if (engine !== "pi") return { entries: [] };
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return { entries: agentHostBridge.queue.list(req.sessionId) };
  });
  handle(IPC.invoke.agentQueueRemove, async (req: { turnId: string }) => {
    // Cancels queued work, so it is gated by the engine of the owning session.
    // An unknown turn has no owner; the queue call reports that on its own.
    const owner = agentHostBridge?.queue.sessionOf(req.turnId) ?? null;
    if (owner) refuseOutsidePiRuntime(await engineRouter.requireForSession(owner, "followUp"), "the turn queue");
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.remove(req.turnId);
    return { ok: true };
  });
  handle(IPC.invoke.agentQueuePrioritize, async (req: { turnId: string }) => {
    const owner = agentHostBridge?.queue.sessionOf(req.turnId) ?? null;
    if (owner) refuseOutsidePiRuntime(await engineRouter.requireForSession(owner, "followUp"), "the turn queue");
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.prioritize(req.turnId);
    return { ok: true };
  });

  handle(
    IPC.invoke.agentQueueReorder,
    async (req: { turnId: string; direction: "up" | "down" }) => {
      if (req.direction !== "up" && req.direction !== "down") {
        throw new Error(`unknown queue reorder direction: ${String(req.direction)}`);
      }
      // Reordering decides which queued turn the engine runs next: it is a
      // control path like prioritize and remove, not a read.
      const owner = agentHostBridge?.queue.sessionOf(req.turnId) ?? null;
      if (owner) await engineRouter.requireForSession(owner, "followUp");
      if (!agentHostBridge) throw new Error("agent host unavailable");
      return agentHostBridge.queue.reorder(req.turnId, req.direction);
    },
  );

  handle(IPC.invoke.toolResolvePermission, async (resolution: {
    requestId: string;
    decision: string;
  }) => {
    // An OMP approval is answered by the runtime that is blocked on it. The
    // request id is the runtime's own frame id, so the bridge can refuse a
    // decision it never raised, a duplicate, or one from a stopped run.
    if (
      ompSessions &&
      typeof resolution?.requestId === "string" &&
      (resolution.decision === "allow-once" ||
        resolution.decision === "allow-session" ||
        resolution.decision === "deny") &&
      (ompSessions.hasPendingRequest(resolution.requestId) ||
        ompSessions.hasKnownRequest(resolution.requestId))
    ) {
      // The renderer sends an opaque request id (the Pi path's own contract);
      // the session, run and tool call this decision belongs to are the ones
      // the bridge stored when it raised the request, and it refuses anything
      // that is no longer open, was already answered, or belongs to another
      // kind of dialog.
      const result = ompSessions.resolvePermission(resolution.requestId, resolution.decision);
      if (!result.ok) {
        throw Object.assign(new Error(result.detail ?? "the approval is no longer pending"), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      logger.app("permission", "info", "omp permission resolved", {
        data: { requestId: resolution.requestId, decision: resolution.decision },
      });
      return { resolved: true };
    }
    if (!host) throw new Error("host unavailable");
    logger.app("permission", "info", "permission resolved", {
      data: { requestId: resolution.requestId, decision: resolution.decision },
    });
    const resolved = await host.call("permissions.resolve", resolution);
    agentHostBridge?.settleApproval(resolution.requestId, {
      ...(resolution.decision === "allow-once" ||
      resolution.decision === "allow-session" ||
      resolution.decision === "deny"
        ? { decision: resolution.decision }
        : {}),
    });
    return resolved;
  });

  handle(IPC.invoke.askToolResolve, async (resolution: AskToolResolution) => {
    const sessionId = String(resolution?.sessionId ?? "").trim();
    const requestId = String(resolution?.requestId ?? "").trim();
    if (!sessionId || !requestId) throw new Error("asktool resolution identity required");
    // Answers a question a *running Pi turn* asked; another engine's session
    // has no such question pending here. The engine decides before the Pi
    // runtime is required.
    const askEngine = await engineRouter.requireForSession(sessionId, "structuredQuestions");
    if (askEngine === "omp") {
      if (!ompSessions) {
        throw Object.assign(new Error("this build has no OMP runtime"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          engine: "omp",
          capability: "structuredQuestions",
        });
      }
      const result = ompSessions.resolveAsk({ ...resolution, sessionId, requestId });
      if (!result.ok) {
        throw Object.assign(new Error(result.detail ?? "the question is no longer pending"), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      return { resolved: true };
    }
    if (!sidecar) throw new Error("sidecar unavailable");
    return sidecar.call("asktool.resolve", {
      ...resolution,
      sessionId,
      requestId,
    });
  });

  handle(IPC.invoke.plansPending, async (input: { sessionId?: string } = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plans.pending", {
      ...(typeof input.sessionId === "string" && input.sessionId.trim()
        ? { sessionId: input.sessionId.trim() }
        : {}),
    });
  });

  handle(IPC.invoke.plansResolve, async (resolution: PlanResolveRequest) => {
    if (!host) throw new Error("host unavailable");
    const proposalId = String(resolution?.proposalId ?? "").trim();
    if (!proposalId) throw new Error("proposalId required");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    if (!sessionId) throw new Error("sessionId required");
    const turnId = String(resolution?.turnId ?? "").trim();
    if (!turnId) throw new Error("turnId required");
    const toolCallId = String(resolution?.toolCallId ?? "").trim();
    if (!toolCallId) throw new Error("toolCallId required");
    const action = resolution?.action;
    if (action !== "approve" && action !== "reject") {
      throw new Error("invalid plan approval action");
    }
    let targetPermissionMode: GlobalPermissionMode | undefined;
    if (action === "approve") {
      if (!isGlobalPermissionMode(resolution?.targetPermissionMode)) {
        throw Object.assign(new Error("targetPermissionMode is required for approval"), {
          errorCode: ErrorCodes.PLAN_PERMISSION_MODE_REQUIRED,
        });
      }
      targetPermissionMode = resolution.targetPermissionMode;
    }
    const version =
      typeof resolution?.version === "number" &&
      Number.isSafeInteger(resolution.version) &&
      resolution.version > 0
        ? resolution.version
        : undefined;
    if (action === "approve") {
      // Approval is a transaction that flips the proposal to approved, moves the
      // session to agent mode and queues the follow-up execution (ADR 0052), and
      // it starts a turn in the session's own runtime. The engine is therefore
      // decided *before* the transaction runs: refusing afterwards would leave a
      // session approved and unable to run. Rejection starts nothing and keeps
      // the host's own reject semantics.
      // The plan pipeline is the desktop's own approval machinery for the Pi
      // runtime's plan tool; it has no OMP counterpart until M5 decides one.
      refuseOutsidePiRuntime(
        await engineRouter.requireForSession(sessionId, "prompt"),
        "plan approval",
      );
    }
    const result = await host.call<PlanResolutionResult>("plans.resolve", {
      proposalId,
      sessionId,
      turnId,
      toolCallId,
      action,
      ...(version !== undefined ? { version } : {}),
      ...(targetPermissionMode ? { targetPermissionMode } : {}),
    });
    agentHostBridge?.settleApproval(proposalId, {
      decision: action,
      ...(targetPermissionMode ? { permissionMode: targetPermissionMode } : {}),
    });
    if (action === "approve") {
      const execution = executionFromResponse(result);
      if (execution) {
        void dispatchApprovedPlan(execution);
      } else {
        void dispatchExecutionForProposal(proposalId);
      }
    }
    return result;
  });

}
