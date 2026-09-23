/**
 * Desktop side of OMP conversations: one runtime per desktop session, streamed
 * into the desktop's event vocabulary, with dialogs answered per session.
 *
 * M3 shipped "one runtime, one session" as a single bound runtime that refused a
 * second session. M4 turns that into a registry: each desktop session gets its
 * own supervisor, its own runtime process, its own native transcript, its own
 * working directory and its own model projection, and the foreground sidebar
 * switch never moves another session's runtime. The pieces below still exist and
 * are not re-implemented here: the supervisor owns the process, its isolated
 * home and the process-group teardown; the runtime package owns framing, the
 * event translation and the decision registry.
 *
 * Three product decisions stay with this module:
 *
 *   1. **A session's runtime is bound to its project.** The working directory
 *      and the model projection are fixed when the runtime is first started; a
 *      later prompt for the same session reuses them, and a prompt that names a
 *      different project is refused rather than re-pointed.
 *   2. **The native transcript is restored, not replayed.** A session with a
 *      persisted native reference reopens it with `switch_session` before any
 *      prompt; a session without one creates it with `new_session` and persists
 *      the validated `get_state` handles through `persistNativeSession`.
 *   3. **The gate is loaded, or the engine stays closed.** A runtime started
 *      without `--extension <gate>` would execute native tools with no
 *      pre-execution approval. If the gate cannot be found, the prompt is
 *      refused and the reason is reported.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import {
  ErrorCodes,
  type AgentEventEnvelope,
  type AskToolRequest,
  type AskToolResolution,
  type Risk,
  type ToolPermissionRequest,
} from "@pi-desktop/shared";
import { BUNDLED_GATE_PATH } from "./omp-runtime";
import {
  OmpSessionRunner,
  descriptorRisk,
  findGateExtension,
  type OmpConversionDiagnostics,
  type OmpRunState,
  type OmpRuntimeSupervisor,
  type OmpSessionRuntime,
  type OmpStopOutcome,
  type OmpUiDecision,
  type OmpUiRecord,
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

/** The per-session facts a supervisor factory needs before the process starts. */
export type OmpSessionRuntimeSpec = {
  sessionId: string;
  /** Absolute project directory the runtime runs in (validated by the registry). */
  projectDirectory: string;
  providerId: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  /** Restore target: present when the session already has a native reference. */
  nativeSessionId?: string | null;
  nativeSessionPath?: string | null;
};

/** A native session whose `get_state` handles were validated, ready to persist. */
export type NativeSessionBoundInfo = {
  sessionId: string;
  nativeSessionId: string;
  nativeSessionPath: string;
  runtimeVersion: string | null;
};

/** What a branch produced, for the desktop to create a new session row. */
export type BranchSessionInfo = {
  parentSessionId: string;
  nativeSessionId: string;
  nativeSessionPath: string;
  runtimeVersion: string | null;
};

export type OmpSessionBridgeOptions = {
  /**
   * Create a fresh supervisor per session (M4: one runtime per session). The
   * factory receives the session's fixed project and model binding and returns
   * a supervisor configured with that session's `--session-dir` and model
   * projection; the registry does not read providers or secrets itself.
   */
  createSupervisor: (spec: OmpSessionRuntimeSpec) => OmpRuntimeSupervisor;
  /** Absolute launcher path, or null when this build has none. */
  launcher: string | null;
  isPackaged: boolean;
  resourcesPath?: string | null;
  /** Start of the development walk-up for the gate extension. */
  appPath: string;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  logger?: OmpSessionBridgeLogger;
  now?: () => number;
  /** Gate policy for a run; defaults to the runtime package's own list. */
  gateTools?: string;
  gateTimeoutMs?: number;
  /** Persist a validated native session reference (host `session.bindEngine`). */
  persistNativeSession?: (info: NativeSessionBoundInfo) => void | Promise<void>;
  /** Persist a rename after `set_session_name` succeeds. */
  persistRename?: (info: { sessionId: string; title: string }) => void | Promise<void>;
  /** Persist a model switch after `set_model` succeeds. */
  persistModelBinding?: (info: { sessionId: string; providerId: string; modelId: string }) => void | Promise<void>;
  /** Persist a thinking-level switch after `set_thinking_level` succeeds. */
  persistThinkingLevel?: (info: { sessionId: string; level: string }) => void | Promise<void>;
  /** Create a branch session row and resolve with its new desktop session id. */
  createBranchSession?: (info: BranchSessionInfo) => Promise<string>;
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

export type OmpPromptInput = {
  sessionId: string;
  content: string;
  projectPath: string | null;
  providerId?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  nativeSessionId?: string | null;
  nativeSessionPath?: string | null;
};

export type OmpRenameResult = { ok: boolean; reason?: string };

export type OmpModelSwitchResult = { ok: boolean; reason?: string };

/**
 * The outcome of answering a dialog.
 *
 * `answered` means the user's decision reached the runtime; `cancelled` means
 * the dialog was failed closed instead — a skipped question, an answer the
 * runtime's protocol cannot carry, or a run that ended first. A refusal means
 * nothing was written, because the id was not this registry's to answer.
 */
export type OmpResolution =
  | { ok: true; outcome: "answered" | "cancelled" }
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
  gatePath(): string | null;
  prompt(input: OmpPromptInput): Promise<OmpPromptResult>;
  rename(sessionId: string, title: string): Promise<OmpRenameResult>;
  /** Branch the session at its native head; resolves with the new session id. */
  branch(sessionId: string): Promise<{ sessionId: string }>;
  setModel(sessionId: string, providerId: string, modelId: string): Promise<OmpModelSwitchResult>;
  setThinkingLevel(sessionId: string, level: string): Promise<OmpModelSwitchResult>;
  stop(sessionId: string): Promise<OmpStopOutcome>;
  resolvePermission(requestId: string, decision: OmpUiDecision): OmpResolution;
  resolveAsk(resolution: AskToolResolution): OmpResolution;
  status(sessionId: string): OmpSessionStatus;
  hasPendingRequest(requestId: string): boolean;
  hasKnownRequest(requestId: string): boolean;
  workingDirectory(sessionId: string): string | null;
  disposeSession(sessionId: string, reason?: string): Promise<void>;
  /** Reclaim every session's runtime; used by application shutdown. */
  dispose(reason?: string): Promise<void>;
  diagnostics(): {
    sessionId: string | null;
    lateFrames: number;
    conversion: OmpConversionDiagnostics;
    uiRecords: readonly OmpUiRecord[];
    state: OmpRunState;
    sessions: Array<{ sessionId: string; state: OmpRunState; lateFrames: number }>;
  };
};

const REFUSAL = ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE;

type PendingDialog = { request: OmpUiRequest; sessionId: string; generation: number };

/**
 * One desktop session's runtime and the bookkeeping that answers its dialogs.
 *
 * The registry keeps one of these per session id; the supervisor and the runner
 * inside it are never shared, so stopping or crashing one session cannot touch
 * another session's pending state, process or working directory.
 */
class SessionEntry {
  readonly sessionId: string;
  readonly projectDirectory: string;
  private readonly supervisor: OmpRuntimeSupervisor;
  private readonly emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  private readonly logger: OmpSessionBridgeLogger | undefined;
  private readonly now: () => number;
  private readonly runnerFactory: NonNullable<OmpSessionBridgeOptions["runnerFactory"]>;
  private readonly persistNativeSession: OmpSessionBridgeOptions["persistNativeSession"];

  private runner: OmpSessionRunner | null = null;
  nativeSessionId: string | null = null;
  nativeSessionPath: string | null = null;
  runtimeVersion: string | null = null;

  readonly approvalRequests = new Map<string, PendingDialog>();
  readonly askRequests = new Map<string, PendingDialog>();
  readonly knownRequests = new Map<string, "approval" | "ask">();
  readonly generations = new Map<string, number>();

  constructor(deps: {
    sessionId: string;
    projectDirectory: string;
    supervisor: OmpRuntimeSupervisor;
    emitAgentEvent: (envelope: AgentEventEnvelope) => void;
    logger: OmpSessionBridgeLogger | undefined;
    now: () => number;
    runnerFactory: NonNullable<OmpSessionBridgeOptions["runnerFactory"]>;
    persistNativeSession: OmpSessionBridgeOptions["persistNativeSession"];
  }) {
    this.sessionId = deps.sessionId;
    this.projectDirectory = deps.projectDirectory;
    this.supervisor = deps.supervisor;
    this.emitAgentEvent = deps.emitAgentEvent;
    this.logger = deps.logger;
    this.now = deps.now;
    this.runnerFactory = deps.runnerFactory;
    this.persistNativeSession = deps.persistNativeSession;
  }

  supervisorHandle(): OmpRuntimeSupervisor {
    return this.supervisor;
  }

  rememberRequest(id: string, kind: "approval" | "ask"): void {
    this.knownRequests.set(id, kind);
    if (this.knownRequests.size > 200) {
      const oldest = this.knownRequests.keys().next().value;
      if (oldest !== undefined) this.knownRequests.delete(oldest);
    }
  }

  generationOf(frameId: string): number {
    return this.generations.get(frameId) ?? 0;
  }

  /** Start the runtime (once) and construct the runner over it. */
  async ensureRunner(gate: string): Promise<OmpSessionRunner> {
    if (this.runner) return this.runner;
    this.supervisor.setWorkingDirectory(this.projectDirectory);
    if (this.supervisor.status().phase !== "idle") {
      await this.supervisor.start();
    }
    const runtime = this.runtimeHandle();
    this.runner = this.runnerFactory({
      sessionId: this.sessionId,
      runtime,
      emit: (envelope) => this.emitAgentEvent(envelope),
      onUiRequest: (request, info) => this.surfaceUiRequest(request, info.sessionId, info.generation),
      onUiClosed: (requestId, reason) => {
        this.approvalRequests.delete(requestId);
        this.askRequests.delete(requestId);
        this.generations.delete(requestId);
        this.logger?.app("omp", "info", "omp dialog closed", { data: { requestId, reason } });
      },
      onUiRecord: (record) => {
        this.logger?.app("omp", "info", "ui request decision", {
          data: {
            sessionId: this.sessionId,
            frameId: record.frameId,
            kind: record.kind,
            outcome: record.outcome,
            decision: record.decision,
          },
        });
      },
      teardown: async (teardownOptions) => {
        const result = await this.supervisor.stop({ abortBash: teardownOptions.abortBash });
        return { reaped: result.reaped, cleaned: result.cleaned };
      },
    });
    this.logger?.app("omp", "info", "omp session runtime started", {
      data: { sessionId: this.sessionId, projectDirectory: this.projectDirectory, gate },
    });
    return this.runner;
  }

  runtimeHandle(): OmpSessionRuntime {
    const runtime = this.supervisor.currentRuntime();
    if (!runtime) {
      throw Object.assign(new Error("the OMP runtime is not available after start"), {
        errorCode: "NOT_STARTED",
      });
    }
    return runtime;
  }

  /** Establish the native session: restore by path, or create and persist. */
  async ensureNativeSession(gate: string, spec: OmpSessionRuntimeSpec): Promise<void> {
    const runner = await this.ensureRunner(gate);
    const runtime = this.runtimeHandle();

    if (spec.nativeSessionPath) {
      // Restore: reopen the persisted native transcript before any prompt. A
      // cancelled switch (the runtime refused the path) is a restore failure,
      // not a reason to fabricate a new session.
      const switched = await runtime.request({ type: "switch_session", sessionPath: spec.nativeSessionPath }, { timeoutMs: 20_000 });
      const switchData = switched.data as { cancelled?: boolean } | undefined;
      if (switched.success === false || switchData?.cancelled === true) {
        throw Object.assign(
          new Error(`the native session could not be restored: ${switched.error ?? "cancelled"}`),
          { errorCode: "OMP_RESTORE_FAILED" },
        );
      }
      this.nativeSessionId = spec.nativeSessionId ?? null;
      this.nativeSessionPath = spec.nativeSessionPath;
      this.runtimeVersion = this.supervisor.status().runtimeVersion;
      return;
    }

    // Fresh session: create it, read back the validated handles, and persist.
    const created = await runtime.request({ type: "new_session" }, { timeoutMs: 20_000 });
    const createdData = created.data as { cancelled?: boolean } | undefined;
    if (created.success === false || createdData?.cancelled === true) {
      throw Object.assign(
        new Error(`the native session could not be created: ${created.error ?? "cancelled"}`),
        { errorCode: "OMP_SESSION_CREATE_FAILED" },
      );
    }
    const state = await runtime.request({ type: "get_state" }, { timeoutMs: 20_000 });
    const stateData = state.data as { sessionId?: string; sessionFile?: string } | undefined;
    const sessionId = typeof stateData?.sessionId === "string" ? stateData.sessionId : "";
    const sessionFile = typeof stateData?.sessionFile === "string" ? stateData.sessionFile : "";
    if (!sessionId || !sessionFile) {
      throw Object.assign(
        new Error("the runtime returned no native session handles to persist"),
        { errorCode: "OMP_SESSION_CREATE_FAILED" },
      );
    }
    this.nativeSessionId = sessionId;
    this.nativeSessionPath = sessionFile;
    this.runtimeVersion = this.supervisor.status().runtimeVersion;
    await this.persistNativeSession?.({
      sessionId: this.sessionId,
      nativeSessionId: sessionId,
      nativeSessionPath: sessionFile,
      runtimeVersion: this.runtimeVersion,
    });
  }

  surfaceUiRequest(request: OmpUiRequest, sessionId: string, generation: number): void {
    const ts = this.now();
    this.generations.set(request.frameId, generation);
    if (request.kind === "approval") {
      const descriptor = request.descriptor;
      const permission: ToolPermissionRequest = {
        requestId: request.frameId,
        sessionId,
        toolCallId: descriptor?.toolCallId ?? request.frameId,
        toolName: descriptor?.toolName ?? "tool",
        argsPreview: descriptor?.argsPreview,
        risk: this.riskForApproval(request),
        reason: descriptor?.reason ?? request.title,
      };
      this.approvalRequests.set(request.frameId, { request, sessionId, generation });
      this.rememberRequest(request.frameId, "approval");
      this.emitAgentEvent({ sessionId, ts, event: { type: "tool_permission_request", request: permission } });
      return;
    }
    if (request.kind === "question" && request.method === "select") {
      const ask: AskToolRequest = {
        requestId: request.frameId,
        sessionId,
        toolCallId: request.frameId,
        questions: [{ question: request.title, options: request.options ?? [], multiSelect: false }],
      };
      this.askRequests.set(request.frameId, { request, sessionId, generation });
      this.rememberRequest(request.frameId, "ask");
      this.emitAgentEvent({ sessionId, ts, event: { type: "asktool_request", request: ask } });
      return;
    }
    if (request.kind === "question" && request.method === "confirm") {
      const ask: AskToolRequest = {
        requestId: request.frameId,
        sessionId,
        toolCallId: request.frameId,
        questions: [{
          question: [request.title, request.message].filter(Boolean).join("\n\n"),
          options: ["Yes", "No"],
          multiSelect: false,
        }],
      };
      this.askRequests.set(request.frameId, { request, sessionId, generation });
      this.rememberRequest(request.frameId, "ask");
      this.emitAgentEvent({ sessionId, ts, event: { type: "asktool_request", request: ask } });
      return;
    }
    this.logger?.app("omp", "warn", "unsupported OMP dialog", {
      data: { sessionId, frameId: request.frameId, kind: request.kind },
    });
  }

  riskForApproval(request: OmpUiRequest): Risk {
    if (request.kind !== "approval") return "high";
    if (request.source === "runtime") return "high";
    return descriptorRisk(request.descriptor);
  }

  runnerState(): OmpRunState {
    return this.runner?.runState() ?? "idle";
  }

  /** The live runner, or null when the runtime has not started a turn yet. */
  activeRunner(): OmpSessionRunner | null {
    return this.runner;
  }

  async stop(): Promise<OmpStopOutcome> {
    if (!this.runner) {
      return { aborted: false, abortBashSent: false, converged: true, toreDown: false, steps: ["nothing running"], errors: [] };
    }
    return this.runner.stop();
  }

  async dispose(reason: string): Promise<void> {
    this.approvalRequests.clear();
    this.askRequests.clear();
    this.generations.clear();
    if (this.runner) this.runner.dispose(reason);
    this.runner = null;
    await this.supervisor.reclaimAll().catch(() => undefined);
  }
}

export function createOmpSessionBridge(options: OmpSessionBridgeOptions): OmpSessionBridge {
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const resolveGate = options.gateResolver ?? ((startDir: string) => findGateExtension(startDir));
  const runnerFactory = options.runnerFactory ?? ((runnerOptions) => new OmpSessionRunner(runnerOptions));

  const entries = new Map<string, SessionEntry>();

  function gatePath(): string | null {
    if (options.isPackaged && options.resourcesPath) {
      const bundled = join(options.resourcesPath, BUNDLED_GATE_PATH);
      if (existsSync(bundled)) return bundled;
      return null;
    }
    if (!options.launcher) return null;
    return resolveGate(options.appPath);
  }

  function requireGate(): string {
    const gate = gatePath();
    if (!gate) {
      throw Object.assign(
        new Error("the OMP tool gate extension could not be found; refusing to start an unguarded runtime"),
        { errorCode: REFUSAL },
      );
    }
    return gate;
  }

  function requireLauncher(): void {
    if (!options.launcher) {
      throw Object.assign(
        new Error("this build has no OMP runtime executable; run from a checkout or set OMP_DESKTOP_RUNTIME"),
        { errorCode: "NOT_FOUND" },
      );
    }
  }

  /** Get or create the per-session entry, refusing a project change. */
  function entryFor(spec: OmpSessionRuntimeSpec): SessionEntry {
    const existing = entries.get(spec.sessionId);
    if (existing) {
      if (existing.projectDirectory !== spec.projectDirectory) {
        throw Object.assign(
          new Error(`this OMP session already runs in ${existing.projectDirectory}; a different project directory is not supported`),
          { errorCode: REFUSAL },
        );
      }
      return existing;
    }
    const supervisor = options.createSupervisor(spec);
    const entry = new SessionEntry({
      sessionId: spec.sessionId,
      projectDirectory: spec.projectDirectory,
      supervisor,
      emitAgentEvent: options.emitAgentEvent,
      logger,
      now,
      runnerFactory,
      persistNativeSession: options.persistNativeSession,
    });
    entries.set(spec.sessionId, entry);
    return entry;
  }

  function entryOf(sessionId: string): SessionEntry | null {
    return entries.get(sessionId) ?? null;
  }

  async function prompt(input: OmpPromptInput): Promise<OmpPromptResult> {
    requireLauncher();
    const gate = requireGate();
    const projectDirectory = resolveProjectDirectory(input.projectPath);
    const spec: OmpSessionRuntimeSpec = {
      sessionId: input.sessionId,
      projectDirectory,
      providerId: typeof input.providerId === "string" && input.providerId.trim() ? input.providerId : null,
      modelId: typeof input.modelId === "string" && input.modelId.trim() ? input.modelId : null,
      thinkingLevel: typeof input.thinkingLevel === "string" && input.thinkingLevel.trim() ? input.thinkingLevel : null,
      nativeSessionId: input.nativeSessionId ?? null,
      nativeSessionPath: input.nativeSessionPath ?? null,
    };
    const entry = entryFor(spec);
    await entry.ensureNativeSession(gate, spec);
    const runner = await entry.ensureRunner(gate);
    const started = await runner.prompt(input.content);
    return { accepted: started.accepted, turnId: started.turnId };
  }

  /** The runtime handle for a session's runner (fails loudly if absent). */
  function runtimeOf(entry: SessionEntry): OmpSessionRuntime {
    return entry.runtimeHandle();
  }

  async function rename(sessionId: string, title: string): Promise<OmpRenameResult> {
    const entry = entryOf(sessionId);
    if (!entry || !entry.activeRunner()) {
      return { ok: false, reason: "no OMP runtime is running for this session" };
    }
    const runtime = runtimeOf(entry);
    const result = await runtime.request({ type: "set_session_name", name: title }, { timeoutMs: 20_000 });
    if (result.success === false) {
      return { ok: false, reason: result.error ?? "the runtime refused the name" };
    }
    await options.persistRename?.({ sessionId, title });
    return { ok: true };
  }

  async function branch(sessionId: string): Promise<{ sessionId: string }> {
    const entry = entryOf(sessionId);
    if (!entry) {
      throw Object.assign(new Error("no OMP runtime is running for this session"), { errorCode: "NOT_FOUND" });
    }
    const runtime = runtimeOf(entry);
    const branchable = await runtime.request({ type: "get_branch_messages" }, { timeoutMs: 20_000 });
    const branchData = branchable.data as { messages?: Array<{ entryId?: string }> } | undefined;
    const entryId = branchData?.messages?.[0]?.entryId;
    if (typeof entryId !== "string" || !entryId) {
      throw Object.assign(new Error("the runtime reported no branchable entry"), { errorCode: "OMP_BRANCH_FAILED" });
    }
    const branched = await runtime.request({ type: "branch", entryId }, { timeoutMs: 30_000 });
    const branchResult = branched.data as { cancelled?: boolean } | undefined;
    if (branched.success === false || branchResult?.cancelled === true) {
      throw Object.assign(
        new Error(`the runtime refused to branch: ${branched.error ?? "cancelled"}`),
        { errorCode: "OMP_BRANCH_FAILED" },
      );
    }
    const state = await runtime.request({ type: "get_state" }, { timeoutMs: 20_000 });
    const stateData = state.data as { sessionId?: string; sessionFile?: string } | undefined;
    const nativeSessionId = typeof stateData?.sessionId === "string" ? stateData.sessionId : "";
    const nativeSessionPath = typeof stateData?.sessionFile === "string" ? stateData.sessionFile : "";
    if (!nativeSessionId || !nativeSessionPath || nativeSessionPath === entry.nativeSessionPath) {
      throw Object.assign(
        new Error("the runtime did not produce a distinct native session for the branch"),
        { errorCode: "OMP_BRANCH_FAILED" },
      );
    }
    if (!options.createBranchSession) {
      throw Object.assign(new Error("branching is not wired in this build"), { errorCode: REFUSAL });
    }
    const newSessionId = await options.createBranchSession({
      parentSessionId: sessionId,
      nativeSessionId,
      nativeSessionPath,
      runtimeVersion: entry.runtimeVersion,
    });
    return { sessionId: newSessionId };
  }

  async function switchModel(
    sessionId: string,
    command: { type: "set_model"; provider: string; modelId: string } | { type: "set_thinking_level"; level: string },
    persist?: () => void | Promise<void>,
  ): Promise<OmpModelSwitchResult> {
    const entry = entryOf(sessionId);
    if (!entry || !entry.activeRunner()) {
      return { ok: false, reason: "no OMP runtime is running for this session" };
    }
    const runtime = runtimeOf(entry);
    const result = await runtime.request(command, { timeoutMs: 20_000 });
    if (result.success === false) {
      return { ok: false, reason: result.error ?? "the runtime refused the change" };
    }
    await persist?.();
    return { ok: true };
  }

  function setModel(sessionId: string, providerId: string, modelId: string): Promise<OmpModelSwitchResult> {
    return switchModel(sessionId, { type: "set_model", provider: providerId, modelId }, options.persistModelBinding
      ? () => options.persistModelBinding?.({ sessionId, providerId, modelId })
      : undefined);
  }

  function setThinkingLevel(sessionId: string, level: string): Promise<OmpModelSwitchResult> {
    return switchModel(sessionId, { type: "set_thinking_level", level }, options.persistThinkingLevel
      ? () => options.persistThinkingLevel?.({ sessionId, level })
      : undefined);
  }

  function resolvePermission(requestId: string, decision: OmpUiDecision): OmpResolution {
    for (const entry of entries.values()) {
      const pending = entry.approvalRequests.get(requestId);
      if (!pending) continue;
      if (entry.askRequests.has(requestId)) {
        return { ok: false, reason: "wrong-kind", detail: "this id belongs to a question, not a tool approval" };
      }
      entry.approvalRequests.delete(requestId);
      entry.generations.delete(requestId);
      const runner = entry.activeRunner();
      if (!runner) return { ok: false, reason: "unknown", detail: "no OMP session is running" };
      const result = runner.resolveUiRequest(requestId, decision, {
        sessionId: pending.sessionId,
        generation: pending.generation,
      });
      if (!result.ok) {
        return { ok: false, reason: result.reason === "stale" ? "stale" : result.reason === "duplicate" ? "duplicate" : "refused", detail: result.detail ?? "the runtime refused the decision" };
      }
      return { ok: true, outcome: "answered" };
    }
    // Not a live approval: a question, an already-answered id, or unknown.
    for (const entry of entries.values()) {
      if (entry.askRequests.has(requestId)) {
        return { ok: false, reason: "wrong-kind", detail: "this id belongs to a question, not a tool approval" };
      }
      if (entry.knownRequests.has(requestId)) {
        return { ok: false, reason: "duplicate", detail: "this request was already answered or cancelled" };
      }
    }
    return { ok: false, reason: "unknown", detail: "no dialog with this id was raised" };
  }

  function resolveAsk(resolution: AskToolResolution): OmpResolution {
    for (const entry of entries.values()) {
      const pending = entry.askRequests.get(resolution.requestId);
      if (!pending) continue;
      if (pending.request.kind !== "question") {
        return { ok: false, reason: "wrong-kind", detail: "the stored dialog is not a question" };
      }
      if (resolution.sessionId !== pending.sessionId) {
        return { ok: false, reason: "stale", detail: "the answer names another session" };
      }
      const first = (resolution.answers ?? [])[0];
      const chosen = first?.[0] ?? "";
      const runner = entry.activeRunner();
      const cancel = (reason: string): OmpResolution => {
        if (runner) runner.cancelUiRequest(resolution.requestId, reason);
        entry.askRequests.delete(resolution.requestId);
        entry.generations.delete(resolution.requestId);
        return { ok: true, outcome: "cancelled" };
      };
      if (!first || first.length === 0 || !chosen) {
        return cancel("the user skipped the question");
      }
      if (!runner) {
        return cancel("the OMP runtime is no longer running");
      }
      if (pending.request.method === "confirm") {
        if (chosen !== "Yes" && chosen !== "No") {
          return cancel("the confirmation was dismissed");
        }
        entry.askRequests.delete(resolution.requestId);
        entry.generations.delete(resolution.requestId);
        const result = runner.resolveUiRequest(resolution.requestId, chosen === "Yes" ? "allow-once" : "deny", {
          sessionId: pending.sessionId,
          generation: pending.generation,
        });
        return result.ok ? { ok: true, outcome: "answered" } : { ok: false, reason: "refused", detail: result.detail ?? "the runtime refused the answer" };
      }
      const offered = pending.request.options ?? [];
      if (!offered.includes(chosen)) {
        return cancel("the answer is not one of the options this dialog can return");
      }
      entry.askRequests.delete(resolution.requestId);
      entry.generations.delete(resolution.requestId);
      const result = runner.resolveUiRequest(resolution.requestId, "allow-once", {
        sessionId: pending.sessionId,
        generation: pending.generation,
        value: chosen,
      });
      return result.ok ? { ok: true, outcome: "answered" } : { ok: false, reason: "refused", detail: result.detail ?? "the runtime refused the answer" };
    }
    for (const entry of entries.values()) {
      if (entry.approvalRequests.has(resolution.requestId)) {
        return { ok: false, reason: "wrong-kind", detail: "this id belongs to a tool approval, not a question" };
      }
      if (entry.knownRequests.has(resolution.requestId)) {
        return { ok: false, reason: "duplicate", detail: "this request was already answered or cancelled" };
      }
    }
    return { ok: false, reason: "unknown", detail: "no dialog with this id was raised" };
  }

  async function stop(sessionId: string): Promise<OmpStopOutcome> {
    const entry = entryOf(sessionId);
    if (!entry || !entry.activeRunner()) {
      return { aborted: false, abortBashSent: false, converged: true, toreDown: false, steps: ["nothing running"], errors: [] };
    }
    const outcome = await entry.stop();
    logger?.app("omp", "info", "omp stop finished", {
      data: { sessionId, converged: outcome.converged, toreDown: outcome.toreDown, steps: outcome.steps, errors: outcome.errors },
    });
    return outcome;
  }

  function status(sessionId: string): OmpSessionStatus {
    const entry = entryOf(sessionId);
    const runner = entry?.activeRunner() ?? null;
    if (!entry || !runner) {
      return { isRunning: false, pendingToolConfirmations: 0, engine: "omp", state: "idle" };
    }
    const current = runner.status();
    return {
      isRunning: current.isRunning,
      ...(current.currentTurnId ? { currentTurnId: current.currentTurnId } : {}),
      pendingToolConfirmations: current.pendingToolConfirmations,
      engine: "omp",
      state: entry.runnerState(),
    };
  }

  function hasPendingRequest(requestId: string): boolean {
    for (const entry of entries.values()) {
      if (entry.approvalRequests.has(requestId) || entry.askRequests.has(requestId)) return true;
    }
    return false;
  }

  function hasKnownRequest(requestId: string): boolean {
    for (const entry of entries.values()) {
      if (entry.knownRequests.has(requestId)) return true;
    }
    return false;
  }

  function workingDirectory(sessionId: string): string | null {
    return entryOf(sessionId)?.projectDirectory ?? null;
  }

  async function disposeSession(sessionId: string, reason = "session disposed"): Promise<void> {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    await entry.dispose(reason);
  }

  async function dispose(reason = "application shutdown"): Promise<void> {
    const retained = [...entries.entries()];
    entries.clear();
    const failures: string[] = [];
    for (const [sessionId, entry] of retained) {
      try {
        await entry.dispose(reason);
      } catch (error) {
        failures.push(`${sessionId}: ${(error as Error)?.message ?? String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw Object.assign(
        new Error(`failed to reclaim ${failures.length} OMP session runtime(s): ${failures.join("; ")}`),
        { errorCode: "OMP_RUNTIME_CLEANUP_FAILED" },
      );
    }
  }

  function diagnostics() {
    const sessions = [...entries.entries()].map(([sessionId, entry]) => ({
      sessionId,
      state: entry.runnerState(),
      lateFrames: entry.activeRunner()?.diagnostics().lateFrames ?? 0,
    }));
    const first = entries.values().next().value as SessionEntry | undefined;
    const runnerDiagnostics = first?.activeRunner()?.diagnostics();
    return {
      sessionId: first?.sessionId ?? null,
      lateFrames: runnerDiagnostics?.lateFrames ?? 0,
      conversion: runnerDiagnostics?.conversion ?? { unmappedFrames: {}, toolResultMessages: {}, droppedParts: {}, notes: [] },
      uiRecords: runnerDiagnostics?.uiRecords ?? [],
      state: first?.runnerState() ?? "idle",
      sessions,
    };
  }

  return {
    gatePath,
    prompt,
    rename,
    branch,
    setModel,
    setThinkingLevel,
    stop,
    resolvePermission,
    resolveAsk,
    status,
    hasPendingRequest,
    hasKnownRequest,
    workingDirectory,
    disposeSession,
    dispose,
    diagnostics,
  };
}
