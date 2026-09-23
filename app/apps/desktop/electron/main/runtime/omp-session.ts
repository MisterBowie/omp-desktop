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
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import {
  ENGINE_ADAPTER_VERSION,
  ErrorCodes,
  type AgentEventEnvelope,
  type AskToolRequest,
  type AskToolResolution,
  type Risk,
  type ToolPermissionRequest,
  type UiMessage,
} from "@pi-desktop/shared";
import { BUNDLED_GATE_PATH } from "./omp-runtime";
import {
  OmpSessionRunner,
  OmpRuntimeError,
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
  type SubagentListEntry,
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
  /** The reference's adapter version; validated against this build's support. */
  adapterVersion?: number | null;
  /** The runtime version the reference was written with; used for downgrade checks. */
  runtimeVersion?: string | null;
};

/** A native session whose `get_state` handles were validated, ready to persist. */
export type NativeSessionBoundInfo = {
  sessionId: string;
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
  /**
   * Persist the full session configuration in one host `session.configure` call
   * (atomic on the host side): mode, provider, model, thinking and permission
   * mode. `configure` uses this so no field is dropped and a partial write is
   * impossible.
   */
  persistConfig?: (info: {
    sessionId: string;
    mode?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
    permissionMode?: string | null;
  }) => void | Promise<void>;
  /** The app-owned persistent native-session directory (containment root). */
  sessionDir: string;
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
  adapterVersion?: number | null;
  runtimeVersion?: string | null;
};

export type OmpRenameResult = { ok: boolean; reason?: string; inconsistent?: boolean };

export type OmpModelSwitchResult = { ok: boolean; reason?: string; inconsistent?: boolean };

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

/**
 * The canonical on-disk path of `candidate`, or null when it does not exist or
 * cannot be resolved. `realpathSync` resolves every symlink component, so the
 * result can be compared against the session directory without a lexical `..`
 * or an intermediate-directory symlink smuggling the file outside it.
 */
function canonicalizeIfExists(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/**
 * True when `candidate` is `root` or a descendant of it, after resolving both
 * through `realpath` (every symlink component resolved). A candidate whose path
 * or intermediate directory is a symlink resolves to its target, so a symlink
 * escape is refused rather than smuggled past a lexical check.
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const child = canonicalizeIfExists(candidate);
  const parent = canonicalizeIfExists(root);
  if (child === null || parent === null) return false;
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The maximum leading bytes read to locate the fixed OMP session header. */
const HEADER_READ_BYTES = 4096;

/**
 * Read the leading bytes of a file (bounded) and return the `type: "session"`
 * header's `id`, or null when none is found. The pinned OMP format writes a
 * 256-byte title slot as the first line and the `SessionHeader`
 * (`type: "session"`, `id`, `cwd`, `timestamp`) next, so the header is searched
 * over the leading lines rather than assumed to be the first.
 */
function readNativeHeaderId(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const bytes = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
    const head = buffer.subarray(0, bytes).toString("utf8");
    for (const line of head.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (!("type" in parsed) || parsed.type !== "session") continue;
        if (!("id" in parsed) || typeof parsed.id !== "string") continue;
        return parsed.id;
      } catch {
        // The title slot and other leading lines may not be JSON; keep scanning.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Validate a persisted native-session path before it is handed to the runtime.
 *
 * The runtime's `switch_session` takes an arbitrary path, so the desktop must
 * refuse anything that is not an ordinary transcript file inside the app-owned
 * session directory. The rules, each fail-closed:
 *
 *   - canonicalise through `realpath` (every symlink component resolved) and
 *     reject when the result is outside the canonical session directory;
 *   - reject a missing file, a directory, or any non-regular file (`lstat`, so a
 *     final symlink to a regular file is still refused);
 *   - read only the leading bytes and confirm the `type: "session"` header's
 *     `id` matches the persisted native session id.
 *
 * The returned path is the canonical one, which is what `switch_session` and
 * the post-switch identity check compare against.
 */
export function validateNativeSessionPath(
  sessionDir: string,
  nativeSessionId: string | null | undefined,
  nativeSessionPath: string | null | undefined,
): string {
  if (!nativeSessionId || !nativeSessionPath) {
    throw Object.assign(new Error("the persisted native session reference is incomplete"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  const raw = String(nativeSessionPath).trim();
  if (!raw || !isAbsolute(raw)) {
    throw Object.assign(new Error("the persisted native session path is not absolute"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  // A direct symlink is refused outright; intermediate-directory symlinks are
  // caught by the realpath containment check below.
  try {
    if (lstatSync(raw).isSymbolicLink()) {
      throw Object.assign(new Error("the persisted native session path is a symbolic link"), {
        errorCode: "OMP_RESTORE_FAILED",
      });
    }
  } catch (error) {
    if (error instanceof Error && "errorCode" in error) throw error;
    // The lstat may fail because the file does not exist; the canonical check
    // reports that with its own message.
  }
  const canonical = canonicalizeIfExists(raw);
  if (canonical === null) {
    throw Object.assign(new Error("the persisted native session file does not exist"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  // The canonical session directory is resolved once, so a session-dir path
  // that itself traverses a symlink still yields a stable containment root.
  const canonicalRoot = canonicalizeIfExists(sessionDir);
  if (canonicalRoot === null || !isPathWithin(canonical, canonicalRoot)) {
    throw Object.assign(new Error("the persisted native session path is outside the session directory"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  // Reject a directory, a missing file, or any non-regular file (the canonical
  // path has no symlink components, but lstat also refuses a direct symlink).
  let fileStats: ReturnType<typeof lstatSync>;
  try {
    fileStats = lstatSync(canonical);
  } catch {
    throw Object.assign(new Error("the persisted native session file does not exist"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  if (fileStats.isSymbolicLink()) {
    throw Object.assign(new Error("the persisted native session path is a symbolic link"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  if (!fileStats.isFile()) {
    throw Object.assign(new Error("the persisted native session path is not a regular file"), {
      errorCode: "OMP_RESTORE_FAILED",
    });
  }
  const headerId = readNativeHeaderId(canonical);
  if (headerId !== nativeSessionId) {
    throw Object.assign(
      new Error(headerId === null
        ? "the persisted native session file has no readable session header"
        : "the persisted native session file belongs to a different native session"),
      { errorCode: "OMP_RESTORE_FAILED" },
    );
  }
  return canonical;
}

/** Compare two dotted versions; returns 0 (equal), +1 (a newer), -1 (a older). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * The adapter/runtime version contract, fail-closed.
 *
 * `adapterVersion` must be a positive integer this build understands (the
 * shared `ENGINE_ADAPTER_VERSION`); a larger value describes a reference shape
 * this build cannot read. `runtimeVersion` is the runtime the reference was
 * written with: a reference written by a *newer* runtime than the one running
 * now is a downgrade and is refused, so an incompatible session is never opened
 * on a runtime too old to read it.
 */
export function validateEngineVersions(
  adapterVersion: number | null | undefined,
  persistedRuntimeVersion: string | null | undefined,
  runningRuntimeVersion: string | null | undefined,
): void {
  if (adapterVersion !== null && adapterVersion !== undefined) {
    if (!Number.isInteger(adapterVersion) || adapterVersion < 1 || adapterVersion > ENGINE_ADAPTER_VERSION) {
      throw Object.assign(
        new Error(`unsupported session-engine adapter version ${adapterVersion}; this build supports 1..=${ENGINE_ADAPTER_VERSION}`),
        { errorCode: "OMP_RESTORE_FAILED" },
      );
    }
  }
  if (persistedRuntimeVersion && runningRuntimeVersion) {
    if (compareVersions(persistedRuntimeVersion, runningRuntimeVersion) > 0) {
      throw Object.assign(
        new Error(`the session was written by runtime ${persistedRuntimeVersion}, newer than the running ${runningRuntimeVersion}`),
        { errorCode: "OMP_RESTORE_FAILED" },
      );
    }
  }
}

export type OmpSessionBridge = {
  gatePath(): string | null;
  prompt(input: OmpPromptInput): Promise<OmpPromptResult>;
  rename(sessionId: string, title: string): Promise<OmpRenameResult>;
  /** Branch the session at the renderer's selected point (or the head). */
  branch(sessionId: string, throughMessageId?: string | null): Promise<{ sessionId: string }>;
  /** Apply a provider/model/thinking/mode change consistently (runtime + host DB). */
  configure(
    sessionId: string,
    config: {
      mode?: string | null;
      providerId?: string | null;
      modelId?: string | null;
      thinkingLevel?: string | null;
      permissionMode?: string | null;
    },
  ): Promise<OmpModelSwitchResult>;
  setModel(sessionId: string, providerId: string, modelId: string): Promise<OmpModelSwitchResult>;
  setThinkingLevel(sessionId: string, level: string): Promise<OmpModelSwitchResult>;
  stop(sessionId: string): Promise<OmpStopOutcome>;
  resolvePermission(requestId: string, decision: OmpUiDecision): OmpResolution;
  resolveAsk(resolution: AskToolResolution): OmpResolution;
  status(sessionId: string): OmpSessionStatus;
  hasPendingRequest(requestId: string): boolean;
  hasKnownRequest(requestId: string): boolean;
  workingDirectory(sessionId: string): string | null;
  /** Live child list (opaque ids, never a native path). */
  listSubagents(sessionId: string): Promise<SubagentListEntry[]>;
  /** Bounded child-transcript read by opaque id (native `sessionFile` stays internal). */
  readSubagentTranscript(
    sessionId: string,
    subagentId: string,
    fromByte?: number,
  ): Promise<{ cursor: { fromByte: number; nextByte: number; reset: boolean }; messages: UiMessage[] }>;
  /** Always refuses: the pinned runtime has no per-child stop command. */
  stopSubagent(sessionId: string, subagentId: string): SubagentStopResult;
  disposeSession(sessionId: string, reason?: string): Promise<OmpDisposeResult>;
  /** Reclaim every session's runtime; used by application shutdown. */
  dispose(reason?: string): Promise<OmpDisposeResult>;
  diagnostics(): {
    sessionId: string | null;
    lateFrames: number;
    conversion: OmpConversionDiagnostics;
    uiRecords: readonly OmpUiRecord[];
    state: OmpRunState;
    sessions: Array<{ sessionId: string; state: OmpRunState; lateFrames: number }>;
  };
};

/** The observable outcome of reclaiming every session on shutdown. */
export type OmpDisposeResult = {
  ok: boolean;
  failures: Array<{ sessionId: string; detail: string }>;
};

/** A per-child stop is refused: the pinned runtime exposes no such command. */
export type SubagentStopResult = {
  ok: false;
  reason: "capability-unavailable";
  detail: string;
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
  /** Single-flight build: concurrent prompts share one runtime + runner. */
  private runnerBuild: Promise<OmpSessionRunner> | null = null;
  /** Single-flight native-session establishment (switch/new + identity check). */
  private nativeSessionBuild: Promise<void> | null = null;
  nativeSessionId: string | null = null;
  nativeSessionPath: string | null = null;
  /** True once the CURRENT runtime process is on this session (switch/new). */
  private nativeSessionBound = false;
  /**
   * The runner instance the native session is bound to. Restoring a session
   * binds the process the runner drives; when the runner is retired and
   * replaced, the replacement must re-issue `switch_session`/`get_state`, so
   * the bound runner is remembered rather than trusting `nativeSessionBound`
   * alone after a replacement.
   */
  private nativeSessionRunner: OmpSessionRunner | null = null;
  /** Turn counter seed for the next runner, carried across runtime replacement. */
  private generationSeed = 0;
  /** Live message-id sequence seed for the next runner, carried across replacement. */
  private messageSequenceSeed = 0;
  /**
   * Bumped on every stop or dispose. A prompt reads it when it begins and
   * re-checks it immediately before submission, so a stop that raced the
   * prompt's startup/restore cannot let the prompt submit content afterwards.
   */
  private stopEpoch = 0;
  /**
   * The single-flight stop operation, owned from synchronous entry through the
   * startup/restore waits and the runner teardown/retirement. A new prompt or
   * runtime preparation is refused while this is unresolved, because the stop
   * has already bumped the epoch and a prompt arriving afterwards would pass
   * the epoch equality check.
   */
  private stopping: Promise<OmpStopOutcome> | null = null;
  /**
   * True once `dispose` begins, set synchronously before its first await: the
   * entry can never run a runtime again. A prompt (or a rename/configure that
   * would prepare a runtime) is refused while this is set, so a disposal that
   * is still awaiting its reclaim cannot be resurrected by a new operation.
   */
  private closed = false;
  runtimeVersion: string | null = null;
  /** The app-owned persistent native-session directory (containment root). */
  private readonly sessionDir: string;
  /** The model binding this session's runtime was projected with. */
  binding: { providerId: string | null; modelId: string | null; thinkingLevel: string | null };

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
    sessionDir: string;
    binding: { providerId: string | null; modelId: string | null; thinkingLevel: string | null };
  }) {
    this.sessionId = deps.sessionId;
    this.projectDirectory = deps.projectDirectory;
    this.supervisor = deps.supervisor;
    this.emitAgentEvent = deps.emitAgentEvent;
    this.logger = deps.logger;
    this.now = deps.now;
    this.runnerFactory = deps.runnerFactory;
    this.persistNativeSession = deps.persistNativeSession;
    this.sessionDir = deps.sessionDir;
    this.binding = deps.binding;
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

  /**
   * Refuse admission to a disposed entry, or one whose stop is unresolved.
   *
   * `closed` is permanent (set synchronously by `dispose` before its first
   * await), while the in-flight stop operation is transient. Both must refuse a
   * NEW prompt or runtime preparation: a disposed entry has no runtime to run,
   * and a stop that already bumped the epoch would otherwise be bypassed by a
   * prompt that captured the new epoch. Work admitted earlier is not re-checked
   * here — it is invalidated by the epoch re-check immediately before
   * submission, so it stays distinguishable from new admission.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new OmpRuntimeError(
        "not-started",
        "this OMP session has been disposed and cannot start another runtime",
      );
    }
    if (this.stopping) {
      throw new OmpRuntimeError(
        "stopping",
        "a stop is in progress; wait for it to finish before prompting",
      );
    }
  }

  /**
   * Return the runner for this session, building runtime + runner once.
   *
   * A runner whose runtime was fully reclaimed is stale: it is retired here so
   * the next prompt rebuilds a fresh process and runner. A converged protocol
   * stop keeps the live process, and a failed teardown keeps its retryable
   * obligation, so neither is retired — and an in-flight stop owns the
   * lifecycle, so a concurrent prompt must not start a second runtime.
   */
  async ensureRunner(gate: string): Promise<OmpSessionRunner> {
    if (this.runner && this.shouldRetireRunner()) {
      this.retireRunner();
    }
    if (this.runner) return this.runner;
    if (this.runnerBuild) return this.runnerBuild;
    this.runnerBuild = this.buildRunner(gate);
    try {
      return await this.runnerBuild;
    } finally {
      this.runnerBuild = null;
    }
  }

  /**
   * True when the current runner wraps a runtime the supervisor no longer owns.
   *
   * Only a fully reclaimed runtime retires the runner: a stop still in flight
   * (even after `agent_end` made the visible state idle, the stop still owns
   * the child snapshot and the teardown), or a teardown that left a retryable
   * obligation, keeps it — the supervisor's ownership must not be dropped
   * merely because `currentRuntime` is null mid-cleanup, and no second runtime
   * may start while that stop is unresolved.
   */
  private shouldRetireRunner(): boolean {
    if (!this.runner) return false;
    if (this.runner.isStopping()) return false;
    if (this.runner.runState() === "stopping") return false;
    if (this.runner.hasPendingReclaim()) return false;
    return this.supervisor.currentRuntime() === null;
  }

  /** Detach the retired runner's handlers and forget it. */
  private retireRunner(): void {
    const retired = this.runner;
    this.runner = null;
    this.nativeSessionBound = false;
    this.nativeSessionRunner = null;
    if (retired) {
      this.generationSeed = retired.currentGeneration();
      this.messageSequenceSeed = retired.currentMessageSequence();
      retired.dispose("the runtime was reclaimed");
    }
  }

  /** Start the runtime (once) and construct the runner over it. */
  private async buildRunner(gate: string): Promise<OmpSessionRunner> {
    this.supervisor.setWorkingDirectory(this.projectDirectory);
    if (this.supervisor.status().phase !== "idle") {
      await this.supervisor.start();
    }
    const runtime = this.runtimeHandle();
    this.runner = this.runnerFactory({
      sessionId: this.sessionId,
      runtime,
      generationSeed: this.generationSeed,
      messageSequenceSeed: this.messageSequenceSeed,
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
        const stop = await this.supervisor.stop({ abortBash: teardownOptions.abortBash });
        // A run whose group was reaped but whose directory survived is a
        // directory-only debt — and on a retry, with no live runtime left,
        // `stop` reports "nothing owned" while that retained directory debt is
        // still owed. Only the sweep (`reclaimAll`) can finish either, so
        // reconcile whenever a reaped stop leaves anything retained, and judge
        // the verdict by whether any debt actually remains.
        if (stop.reaped && (!stop.cleaned || this.supervisor.pendingCleanup.length > 0)) {
          await this.supervisor.reclaimAll();
          return { reaped: true, cleaned: this.supervisor.pendingCleanup.length === 0 };
        }
        return { reaped: stop.reaped, cleaned: stop.cleaned };
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
    // A rename/configure can prepare a runtime directly, outside the prompt's
    // epoch re-check, so the same admission gate applies here.
    this.assertOpen();
    // The current runtime process is already on this exact session: re-switching
    // would reopen the transcript, which OMP's `switch_session` treats as a
    // session transition. The check names the *runner* the session is bound to
    // (`nativeSessionRunner`), not just the boolean: `ensureRunner` may retire
    // and rebuild a runner after the bind, and a replacement process must
    // re-issue `switch_session` instead of reusing a stale bind.
    if (
      this.nativeSessionBound &&
      this.nativeSessionRunner === this.runner &&
      this.nativeSessionId === spec.nativeSessionId &&
      this.nativeSessionPath
    ) {
      return;
    }
    if (this.nativeSessionBuild) return this.nativeSessionBuild;
    this.nativeSessionBuild = this.establishNativeSession(gate, spec);
    try {
      await this.nativeSessionBuild;
    } finally {
      this.nativeSessionBuild = null;
    }
  }

  /** Switch to (or create) the native session on the live runtime. */
  private async establishNativeSession(gate: string, spec: OmpSessionRuntimeSpec): Promise<void> {
    await this.ensureRunner(gate);
    const runtime = this.runtimeHandle();

    if (spec.nativeSessionPath || spec.nativeSessionId) {
      // Restore: validate the persisted reference before handing its path to
      // the runtime, then verify the runtime actually opened that identity.
      validateEngineVersions(spec.adapterVersion, spec.runtimeVersion, this.supervisor.status().runtimeVersion);
      const canonicalPath = validateNativeSessionPath(
        this.sessionDir,
        spec.nativeSessionId,
        spec.nativeSessionPath,
      );
      const switched = await runtime.request({ type: "switch_session", sessionPath: canonicalPath }, { timeoutMs: 20_000 });
      const switchData = switched.data as { cancelled?: boolean } | undefined;
      if (switched.success === false || switchData?.cancelled === true) {
        throw Object.assign(
          new Error(`the native session could not be restored: ${switched.error ?? "cancelled"}`),
          { errorCode: "OMP_RESTORE_FAILED" },
        );
      }
      // The runtime may report a different state than the one we asked it to
      // open (a path collision, a stale file). Verify the identity it reports,
      // and stop the runtime rather than persist a mismatched reference.
      const state = await runtime.request({ type: "get_state" }, { timeoutMs: 20_000 });
      const stateData = state.data as { sessionId?: string; sessionFile?: string } | undefined;
      const openedId = typeof stateData?.sessionId === "string" ? stateData.sessionId : "";
      const openedPath = typeof stateData?.sessionFile === "string" ? stateData.sessionFile : "";
      // The runtime must report BOTH the persisted id and the exact canonical
      // path: a missing path, an empty id, or a different path is a restore
      // failure, never a silently accepted partial match.
      const openedCanonical = openedPath ? canonicalizeIfExists(openedPath) : null;
      if (openedId !== spec.nativeSessionId || openedCanonical !== canonicalPath) {
        await this.supervisor.stop().catch(() => undefined);
        throw Object.assign(
          new Error(
            openedId !== spec.nativeSessionId
              ? `the runtime opened a different native session (${openedId || "none"}) than the persisted reference`
              : "the runtime opened the native session at a different path than the persisted reference",
          ),
          { errorCode: "OMP_RESTORE_FAILED" },
        );
      }
      this.nativeSessionId = spec.nativeSessionId ?? null;
      this.nativeSessionPath = canonicalPath;
      this.runtimeVersion = this.supervisor.status().runtimeVersion;
      this.nativeSessionBound = true;
      this.nativeSessionRunner = this.runner;
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
    // The created path must pass the same containment/file-type/identity checks
    // before anything is persisted: a path outside the session directory, a
    // symlink, or a file whose header disagrees is refused.
    const canonicalPath = validateNativeSessionPath(this.sessionDir, sessionId, sessionFile);
    this.nativeSessionId = sessionId;
    this.nativeSessionPath = canonicalPath;
    this.runtimeVersion = this.supervisor.status().runtimeVersion;
    this.nativeSessionBound = true;
    this.nativeSessionRunner = this.runner;
    await this.persistNativeSession?.({
      sessionId: this.sessionId,
      nativeSessionId: sessionId,
      nativeSessionPath: canonicalPath,
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

  /**
   * Prepare this session's runtime and native identity, then submit one prompt.
   *
   * The whole preparation is gated by the stop epoch: `stop`/`dispose` bump it
   * synchronously, and this re-checks it immediately before submission, so a
   * stop that raced a startup/restore cannot let the prompt land afterwards.
   */
  async prompt(gate: string, spec: OmpSessionRuntimeSpec, content: string): Promise<OmpPromptResult> {
    this.assertOpen();
    const epoch = this.stopEpoch;
    await this.ensureNativeSession(gate, spec);
    const runner = await this.ensureRunner(gate);
    // Enable the subagent subscription once the runtime is ready and the native
    // session is established. A refused subscription is logged but does not fail
    // the prompt: the turn still runs, and the child list/read paths report a
    // typed capability-unavailable instead of presenting a partial picture.
    const subscription = await runner.enableSubagentSubscription("events");
    if (!subscription.ok) {
      this.logger?.app("omp", "warn", "subagent subscription unavailable", {
        data: { sessionId: this.sessionId, error: subscription.error ?? "refused" },
      });
    }
    if (this.stopEpoch !== epoch) {
      throw new OmpRuntimeError("stopping", "a stop was requested while the prompt was being prepared");
    }
    const started = await runner.prompt(content);
    return { accepted: started.accepted, turnId: started.turnId };
  }

  async stop(): Promise<OmpStopOutcome> {
    // Concurrent stops join one operation: the gate must not reopen early, and
    // a second caller must observe the same outcome as the first.
    if (this.stopping) return this.stopping;
    const attempt = this.performStop();
    this.stopping = attempt;
    try {
      return await attempt;
    } finally {
      if (this.stopping === attempt) this.stopping = null;
    }
  }

  private async performStop(): Promise<OmpStopOutcome> {
    // A stop owns the lifecycle for its whole span, including work that has not
    // produced a runner yet. Bump the epoch first (synchronously) so a prompt
    // that is mid-startup/mid-restore sees it and refuses to submit; then await
    // any in-flight build so the runtime it started is owned rather than left
    // to a late completion.
    this.stopEpoch += 1;
    if (this.runnerBuild) await this.runnerBuild.catch(() => undefined);
    if (this.nativeSessionBuild) await this.nativeSessionBuild.catch(() => undefined);
    if (!this.runner) {
      return { aborted: false, abortBashSent: false, converged: true, toreDown: false, steps: ["nothing running"], errors: [] };
    }
    const outcome = await this.runner.stop();
    // A teardown that fully reclaimed the process retires the runner: its
    // runtime handle is dead, and the next prompt must rebuild runtime + runner
    // over a fresh process. A converged stop keeps the live process, and a
    // failed teardown keeps the runner so its retryable obligation stays
    // reachable — `shouldRetireRunner` distinguishes the three.
    if (this.shouldRetireRunner()) {
      this.retireRunner();
    }
    return outcome;
  }

  async dispose(reason: string): Promise<Array<{ sessionId: string; detail: string }>> {
    // Mark the entry closed synchronously, before any await: a prompt (or a
    // rename/configure runtime preparation) that races this disposal must be
    // refused, not allowed to build a fresh runtime that the bridge then
    // forgets when it deletes the entry after a "successful" reclaim.
    this.closed = true;
    // Invalidate any prompt that is still preparing, and own a runtime that is
    // still starting or restoring, before the runner is detached and reclaimed.
    this.stopEpoch += 1;
    this.approvalRequests.clear();
    this.askRequests.clear();
    this.generations.clear();
    // Join any in-flight stop so its teardown/retirement and this disposal do
    // not overlap on the same runner/supervisor; admission stays closed via
    // `closed` for the whole span.
    if (this.stopping) await this.stopping.catch(() => undefined);
    if (this.runnerBuild) await this.runnerBuild.catch(() => undefined);
    if (this.nativeSessionBuild) await this.nativeSessionBuild.catch(() => undefined);
    if (this.runner) this.runner.dispose(reason);
    this.runner = null;
    this.nativeSessionBound = false;
    this.nativeSessionRunner = null;
    const failures: Array<{ sessionId: string; detail: string }> = [];
    try {
      const results = await this.supervisor.reclaimAll();
      for (const result of results) {
        if (!result.stopped) {
          failures.push({
            sessionId: this.sessionId,
            detail: `reclaim incomplete: ${result.errors.join("; ") || "process group or run directory survived"}`,
          });
        }
      }
    } catch (error) {
      failures.push({ sessionId: this.sessionId, detail: String((error as Error)?.message ?? error) });
    }
    return failures;
  }
}

export function createOmpSessionBridge(options: OmpSessionBridgeOptions): OmpSessionBridge {
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const resolveGate = options.gateResolver ?? ((startDir: string) => findGateExtension(startDir));
  const runnerFactory = options.runnerFactory ?? ((runnerOptions) => new OmpSessionRunner(runnerOptions));

  const entries = new Map<string, SessionEntry>();
  /**
   * True once application shutdown begins. A new session must not be created
   * after the shutdown sweep has taken its snapshot, or its runtime would
   * outlive the shutdown that was supposed to reclaim it. Per-session disposal
   * does not set this: a later operation may still create a fresh entry.
   */
  let shuttingDown = false;

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
    const binding = {
      providerId: spec.providerId,
      modelId: spec.modelId,
      thinkingLevel: spec.thinkingLevel,
    };
    const existing = entries.get(spec.sessionId);
    if (existing) {
      if (existing.projectDirectory !== spec.projectDirectory) {
        throw Object.assign(
          new Error(`this OMP session already runs in ${existing.projectDirectory}; a different project directory is not supported`),
          { errorCode: REFUSAL },
        );
      }
      // A model/thinking binding change means the runtime's projection is stale:
      // the entry must not be reused for a different binding. The caller
      // (configure) disposes the old runtime before the binding is changed, so
      // a mismatch here is a caller error and is refused rather than papered over.
      if (
        existing.binding.providerId !== binding.providerId ||
        existing.binding.modelId !== binding.modelId ||
        existing.binding.thinkingLevel !== binding.thinkingLevel
      ) {
        throw Object.assign(
          new Error("this OMP session's model binding changed; reconfigure it before prompting"),
          { errorCode: REFUSAL },
        );
      }
      return existing;
    }
    if (shuttingDown) {
      throw Object.assign(
        new Error("the OMP runtime is shutting down; no new session can start"),
        { errorCode: ErrorCodes.ENGINE_UNAVAILABLE },
      );
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
      sessionDir: options.sessionDir,
      binding,
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
      adapterVersion: input.adapterVersion ?? null,
      runtimeVersion: input.runtimeVersion ?? null,
    };
    const entry = entryFor(spec);
    return entry.prompt(gate, spec, input.content);
  }

  /** The runtime handle for a session's runner (fails loudly if absent). */
  function runtimeOf(entry: SessionEntry): OmpSessionRuntime {
    return entry.runtimeHandle();
  }

  /** The session context a control operation needs to (re)start a runtime. */
  type OperationContext = {
    projectPath?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
    nativeSessionId?: string | null;
    nativeSessionPath?: string | null;
    adapterVersion?: number | null;
    runtimeVersion?: string | null;
  };

  /**
   * Establish the entry and its native session for a control operation that may
   * run against an idle or not-yet-started session.
   *
   * Returns `{ entry, startedForOperation }`: `startedForOperation` is true when
   * the runtime was started on this call's behalf (no prior runner), so the
   * caller can dispose it again rather than leave a runtime running for a
   * one-shot rename.
   */
  async function ensureEntryForOperation(
    sessionId: string,
    context: OperationContext,
  ): Promise<{ entry: SessionEntry; startedForOperation: boolean }> {
    const gate = requireGate();
    requireLauncher();
    const projectDirectory = resolveProjectDirectory(context.projectPath ?? null);
    const spec: OmpSessionRuntimeSpec = {
      sessionId,
      projectDirectory,
      providerId: typeof context.providerId === "string" && context.providerId.trim() ? context.providerId : null,
      modelId: typeof context.modelId === "string" && context.modelId.trim() ? context.modelId : null,
      thinkingLevel: typeof context.thinkingLevel === "string" && context.thinkingLevel.trim() ? context.thinkingLevel : null,
      nativeSessionId: context.nativeSessionId ?? null,
      nativeSessionPath: context.nativeSessionPath ?? null,
      adapterVersion: context.adapterVersion ?? null,
      runtimeVersion: context.runtimeVersion ?? null,
    };
    const existing = entries.get(sessionId);
    const hadRunner = existing?.activeRunner() != null;
    const entry = entryFor(spec);
    if (!entry.nativeSessionId && spec.nativeSessionPath) {
      await entry.ensureNativeSession(gate, spec);
    }
    return { entry, startedForOperation: !hadRunner };
  }

  async function rename(
    sessionId: string,
    title: string,
    context: OperationContext = {},
  ): Promise<OmpRenameResult> {
    const { entry, startedForOperation } = await ensureEntryForOperation(sessionId, context);
    let result: OmpRenameResult = { ok: true };
    try {
      const gate = requireGate();
      await entry.ensureNativeSession(gate, {
        sessionId,
        projectDirectory: entry.projectDirectory,
        providerId: entry.binding.providerId,
        modelId: entry.binding.modelId,
        thinkingLevel: entry.binding.thinkingLevel,
        nativeSessionId: context.nativeSessionId ?? entry.nativeSessionId,
        nativeSessionPath: context.nativeSessionPath ?? entry.nativeSessionPath,
        adapterVersion: context.adapterVersion ?? null,
        runtimeVersion: context.runtimeVersion ?? null,
      });
      const runtime = runtimeOf(entry);
      // Record the current name so a failed host persist can be reverted. An
      // empty name is a legitimate prior state; the rollback is always
      // attempted, and its failure (the runtime refuses an empty name) is
      // reported as an inconsistent state rather than a silent fork.
      const before = await runtime.request({ type: "get_state" }, { timeoutMs: 20_000 });
      const beforeData = before.data as { sessionName?: string } | undefined;
      const beforeName = typeof beforeData?.sessionName === "string" ? beforeData.sessionName : "";
      const setResult = await runtime.request({ type: "set_session_name", name: title }, { timeoutMs: 20_000 });
      if (setResult.success === false) {
        result = { ok: false, reason: setResult.error ?? "the runtime refused the name" };
        return result;
      }
      try {
        await options.persistRename?.({ sessionId, title });
      } catch (error) {
        // Revert the native name so the desktop row and the transcript never
        // fork: the two-phase rename either lands on both or neither.
        let rolledBack = true;
        let rollbackError: string | null = null;
        try {
          const revert = await runtime.request({ type: "set_session_name", name: beforeName }, { timeoutMs: 20_000 });
          rolledBack = revert.success !== false;
          if (revert.success === false) rollbackError = revert.error ?? "the runtime refused the revert";
        } catch (revertError) {
          rolledBack = false;
          rollbackError = String((revertError as Error)?.message ?? revertError);
        }
        if (!rolledBack) {
          result = {
            ok: false,
            reason: `${String((error as Error)?.message ?? error)}; the native title could not be reverted (${rollbackError ?? "unknown"})`,
            inconsistent: true,
          };
          return result;
        }
        result = { ok: false, reason: String((error as Error)?.message ?? error) };
        return result;
      }
      result = { ok: true };
      return result;
    } finally {
      if (startedForOperation) {
        const cleanup = await disposeSession(sessionId, "rename finished");
        if (!cleanup.ok) {
          const cleanupFailure = cleanup.failures.map((failure) => failure.detail).join("; ");
          logger?.app("omp", "error", "omp rename cleanup incomplete", { data: { sessionId, cleanupFailure } });
          // A rename whose one-shot runtime could not be reclaimed has leaked a
          // runtime; the caller must see that, never a clean success.
          if (result.ok) {
            result.ok = false;
            result.reason = `the rename applied but its runtime could not be reclaimed: ${cleanupFailure}`;
            result.inconsistent = true;
          }
        }
      }
    }
  }

  /**
   * Branching is closed (see `OMP_ENGINE_CAPABILITIES`): the pinned runtime's
   * `branch(userEntryId)` is a redo-from-user fork that switches the running
   * runtime to the new child, and the rpc-ui event stream carries no OMP entry
   * ids, so a faithful fork cannot be mapped without an adapter extension. The
   * method exists only to keep the surface typed; it always refuses.
   */
  function branch(_sessionId: string, _throughMessageId?: string | null): Promise<{ sessionId: string }> {
    return Promise.reject(
      Object.assign(new Error("branching is not available for OMP sessions in this build"), {
        errorCode: REFUSAL,
        engine: "omp",
        capability: "branch",
      }),
    );
  }

  async function configure(
    sessionId: string,
    config: {
      mode?: string | null;
      providerId?: string | null;
      modelId?: string | null;
      thinkingLevel?: string | null;
      permissionMode?: string | null;
    },
  ): Promise<OmpModelSwitchResult> {
    if (!options.persistConfig) {
      return { ok: false, reason: "configuration persistence is not wired in this build" };
    }
    const entry = entryOf(sessionId);
    const providerId = config.providerId ?? null;
    const modelId = config.modelId ?? null;
    const thinkingLevel = config.thinkingLevel ?? null;
    // The full configuration is persisted in one host `session.configure` call,
    // so mode/permissionMode are never dropped and the host write is atomic.
    const persistAll = () =>
      options.persistConfig?.({
        sessionId,
        mode: config.mode ?? null,
        providerId: providerId ?? entry?.binding.providerId ?? null,
        modelId: modelId ?? entry?.binding.modelId ?? null,
        thinkingLevel: thinkingLevel ?? entry?.binding.thinkingLevel ?? null,
        permissionMode: config.permissionMode ?? null,
      });

    if (!entry) {
      // No runtime has ever run this session: the host DB is the authority and
      // the next prompt will project the new binding.
      try {
        await persistAll();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String((error as Error)?.message ?? error) };
      }
    }

    const modelChanged =
      (providerId !== null && providerId !== entry.binding.providerId) ||
      (modelId !== null && modelId !== entry.binding.modelId);
    const thinkingChanged = thinkingLevel !== null && thinkingLevel !== entry.binding.thinkingLevel;

    try {
      if (modelChanged) {
        // Offline switch: the projection is minimal (one model), so the running
        // OMP catalog cannot `set_model` to a different model. The transaction
        // is "reclaim first, persist second": if the old runtime cannot be
        // reclaimed, the host DB is left untouched (no fork), and the next
        // prompt re-projects the still-persisted old binding.
        const disposed = await disposeSession(sessionId, "model reconfigured");
        if (!disposed.ok) {
          return {
            ok: false,
            reason: `the old runtime could not be reclaimed, so the model binding was not changed: ${disposed.failures.map((failure) => failure.detail).join("; ")}`,
          };
        }
        try {
          await persistAll();
        } catch (error) {
          // The runtime is already reclaimed; the host DB still holds the old
          // binding, so the next prompt re-projects it. The failure is reported
          // and no partial state is left.
          return { ok: false, reason: String((error as Error)?.message ?? error) };
        }
        return { ok: true };
      }
      if (thinkingChanged) {
        // Thinking is a runtime state that does not need re-projection: apply it
        // to a running runtime, persist, and revert on a failed persist. The
        // prior level is always a valid string (the session default is "off").
        const oldLevel = entry.binding.thinkingLevel ?? "off";
        if (entry.activeRunner()) {
          const result = await runtimeOf(entry).request({ type: "set_thinking_level", level: thinkingLevel }, { timeoutMs: 20_000 });
          if (result.success === false) {
            return { ok: false, reason: result.error ?? "the runtime refused the thinking change" };
          }
        }
        try {
          await persistAll();
        } catch (error) {
          // Revert the runtime thinking so the transcript and the DB never fork.
          let rolledBack = true;
          let rollbackError: string | null = null;
          if (entry.activeRunner()) {
            try {
              const revert = await runtimeOf(entry).request({ type: "set_thinking_level", level: oldLevel }, { timeoutMs: 20_000 });
              rolledBack = revert.success !== false;
              if (revert.success === false) rollbackError = revert.error ?? "the runtime refused the revert";
            } catch (revertError) {
              rolledBack = false;
              rollbackError = String((revertError as Error)?.message ?? revertError);
            }
          }
          if (!rolledBack) {
            return {
              ok: false,
              reason: `${String((error as Error)?.message ?? error)}; the thinking level could not be reverted (${rollbackError ?? "unknown"})`,
              inconsistent: true,
            };
          }
          return { ok: false, reason: String((error as Error)?.message ?? error) };
        }
        entry.binding.thinkingLevel = thinkingLevel;
        return { ok: true };
      }
      // A pure mode/permissionMode change has no runtime impact; persist it.
      await persistAll();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String((error as Error)?.message ?? error) };
    }
  }

  function setModel(sessionId: string, providerId: string, modelId: string): Promise<OmpModelSwitchResult> {
    return configure(sessionId, { providerId, modelId });
  }

  function setThinkingLevel(sessionId: string, level: string): Promise<OmpModelSwitchResult> {
    return configure(sessionId, { thinkingLevel: level });
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
    if (!entry) {
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

  async function listSubagents(sessionId: string): Promise<SubagentListEntry[]> {
    const entry = entryOf(sessionId);
    const runner = entry?.activeRunner() ?? null;
    if (!runner) {
      // No live runtime: the registry cannot answer, and claiming an empty list
      // would read as "no children ever existed". The caller distinguishes this
      // from a live empty list.
      throw Object.assign(new Error("the OMP runtime is not running for this session"), {
        errorCode: "NOT_STARTED",
      });
    }
    return runSubagentRead(() => runner.listSubagents());
  }

  async function readSubagentTranscript(
    sessionId: string,
    subagentId: string,
    fromByte?: number,
  ): Promise<{ cursor: { fromByte: number; nextByte: number; reset: boolean }; messages: UiMessage[] }> {
    const entry = entryOf(sessionId);
    const runner = entry?.activeRunner() ?? null;
    if (!runner) {
      throw Object.assign(new Error("the OMP runtime is not running for this session"), {
        errorCode: "NOT_STARTED",
      });
    }
    if (typeof subagentId !== "string" || !subagentId.trim()) {
      throw Object.assign(new Error("a subagent id is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    return runSubagentRead(() => runner.readSubagentTranscript(subagentId, fromByte));
  }

  /**
   * Run a child-surface read, mapping a typed runtime capability failure to the
   * desktop's engine-capability error so the renderer receives a real
   * capability-unavailable rather than an internal error.
   */
  async function runSubagentRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof OmpRuntimeError && error.code === "capability-unavailable") {
        throw Object.assign(new Error(error.message), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          capability: "subagentEvents",
        });
      }
      throw error;
    }
  }

  function stopSubagent(_sessionId: string, _subagentId: string): SubagentStopResult {
    // No entry lookup is needed: the refusal is unconditional. The pinned RPC
    // command union has no per-subagent stop, and a child session has
    // `hasUI=false`, so there is no trustworthy child-owned process handle to
    // terminate without risking the parent or siblings.
    return {
      ok: false,
      reason: "capability-unavailable",
      detail:
        "the pinned OMP runtime exposes no per-child stop command; a child can only be stopped by stopping the parent run",
    };
  }

  async function disposeSession(sessionId: string, reason = "session disposed"): Promise<OmpDisposeResult> {
    const entry = entries.get(sessionId);
    if (!entry) return { ok: true, failures: [] };
    // The entry is removed only after a fully successful reclaim. A failed
    // reclaim leaves the supervisor owning a live process group / uncleaned run;
    // dropping the entry here would orphan that ownership (the next prompt could
    // start a second runtime, and no later retry could reach the supervisor).
    const failures = await entry.dispose(reason);
    for (const failure of failures) {
      logger?.app("omp", "error", "omp session runtime reclaim incomplete", { data: failure });
    }
    if (failures.length === 0) {
      entries.delete(sessionId);
    }
    return { ok: failures.length === 0, failures };
  }

  async function dispose(reason = "application shutdown"): Promise<OmpDisposeResult> {
    // Close admission before the snapshot: a new session arriving after the
    // sweep passed its position must not start a runtime that outlives the
    // shutdown.
    shuttingDown = true;
    // Reclaim every session, but only forget the ones that were fully reclaimed:
    // a session whose runtime could not be reclaimed keeps its entry so a later
    // dispose (or status) can retry the same supervisor instead of losing it.
    const failures: Array<{ sessionId: string; detail: string }> = [];
    for (const [sessionId, entry] of [...entries.entries()]) {
      try {
        const entryFailures = await entry.dispose(reason);
        if (entryFailures.length === 0) entries.delete(sessionId);
        failures.push(...entryFailures);
      } catch (error) {
        failures.push({ sessionId, detail: String((error as Error)?.message ?? error) });
      }
    }
    for (const failure of failures) {
      logger?.app("omp", "error", "omp session runtime reclaim failed", { data: failure });
    }
    return { ok: failures.length === 0, failures };
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
    configure,
    setModel,
    setThinkingLevel,
    stop,
    resolvePermission,
    resolveAsk,
    status,
    hasPendingRequest,
    hasKnownRequest,
    workingDirectory,
    listSubagents,
    readSubagentTranscript,
    stopSubagent,
    disposeSession,
    dispose,
    diagnostics,
  };
}
