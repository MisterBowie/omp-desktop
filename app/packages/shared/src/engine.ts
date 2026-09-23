/**
 * The engine boundary: who executes a session, what that engine can do, and the
 * versioned reference the desktop persists for it (M2/T08).
 *
 * `EngineId` answers "which agent runtime runs this session". It is a different
 * axis from `SessionSource` (`desktop` | `pi-native` | `remote`), which answers
 * "who owns this transcript": a remote or native session is still executed by an
 * engine, and neither `pi-native` nor `remote` names one. Keeping the axes
 * separate is what stops the new engine field from re-routing native Pi or
 * remote sessions.
 *
 * Only the two engines this product actually ships are declared. A third engine
 * needs its own capability evidence, not a new string in this union.
 */

import { ErrorCodes } from "./errors.js";

export type EngineId = "pi" | "omp";

/** Every engine this build knows, in navigation order. */
export const ENGINE_IDS = ["pi", "omp"] as const satisfies readonly EngineId[];

/**
 * The engine of a session that predates the engine field, and of every session
 * created without an explicit choice.
 *
 * Legacy records must resolve here: an absent field means "Pi created it", not
 * "pick the newest engine". `normalizeEngineId` therefore never returns `omp`
 * for an unknown input.
 */
export const DEFAULT_ENGINE_ID: EngineId = "pi";

export function isEngineId(value: unknown): value is EngineId {
  return value === "pi" || value === "omp";
}

/**
 * Resolve a persisted or caller-supplied engine value.
 *
 * Unknown, absent and malformed values all fall back to `DEFAULT_ENGINE_ID`;
 * callers that must reject a bad request validate with `isEngineId` first
 * (see the host's `session.create`).
 */
export function normalizeEngineId(value: unknown): EngineId {
  return isEngineId(value) ? value : DEFAULT_ENGINE_ID;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a session can do on its engine. Every key is required in an
 * `EngineCapabilities` value, so a new capability cannot be introduced without
 * stating which engines have it.
 */
export type EngineCapability =
  /** Send a user message and receive a streamed turn. */
  | "prompt"
  /** Stop a running turn and reclaim what it started. */
  | "stop"
  /** Reopen a session whose runtime state is already durable. */
  | "resume"
  /** Continue a conversation on a new branch with a new native identity. */
  | "branch"
  /** Inject into a running turn. */
  | "steer"
  /** Queue a message behind the running turn. */
  | "followUp"
  /** Change model for the next turn of the same session. */
  | "modelSwitch"
  /** Ask the user a structured question from inside a turn. */
  | "structuredQuestions"
  /** Approve or refuse a tool call before it executes. */
  | "toolApproval"
  /** Surface child-agent lifecycle and progress. */
  | "subagentEvents";

export const ENGINE_CAPABILITY_KEYS = [
  "prompt",
  "stop",
  "resume",
  "branch",
  "steer",
  "followUp",
  "modelSwitch",
  "structuredQuestions",
  "toolApproval",
  "subagentEvents",
] as const satisfies readonly EngineCapability[];

export type EngineCapabilities = Readonly<Record<EngineCapability, boolean>>;

/**
 * The Pi engine is the product's long-standing engine (agent sidecar over the
 * Rust host); every capability above exists on it today.
 */
export const PI_ENGINE_CAPABILITIES: EngineCapabilities = {
  prompt: true,
  stop: true,
  resume: true,
  branch: true,
  steer: true,
  followUp: true,
  modelSwitch: true,
  structuredQuestions: true,
  toolApproval: true,
  subagentEvents: true,
};

/**
 * M4 truth for the OMP engine: prompting, stopping, questions, approvals,
 * restore (native `switch_session`) and model/thinking switching are
 * implemented and verified.
 *
 * Still closed, and closed means closed:
 *
 *   - `branch` is closed. The pinned runtime's `branch(userEntryId)` is a
 *     redo-from-user operation that forks at the *parent* of the selected user
 *     entry and returns the selected text to re-prompt — it is not PI's
 *     `fork_session_through`, which copies the transcript *through* a message.
 *     The desktop also cannot yet persist a desktop-message-id → OMP-entry-id
 *     mapping (the rpc-ui event stream does not carry entry ids), and the RPC
 *     switches the running runtime to the new child, which forks the parent's
 *     in-process state. Until the adapter carries entry ids and a faithful
 *     full-fork, an OMP fork is refused rather than silently producing the
 *     wrong child.
 *   - `steer`/`followUp`/`compact` are not wired to the OMP RPC queue.
 *   - `subagentEvents` belongs to M5/T17.
 */
export const OMP_ENGINE_CAPABILITIES: EngineCapabilities = {
  prompt: true,
  stop: true,
  resume: true,
  branch: false,
  steer: false,
  followUp: false,
  modelSwitch: true,
  structuredQuestions: true,
  toolApproval: true,
  subagentEvents: false,
};

export const ENGINE_CAPABILITIES: Readonly<Record<EngineId, EngineCapabilities>> = {
  pi: PI_ENGINE_CAPABILITIES,
  omp: OMP_ENGINE_CAPABILITIES,
};

export function engineCapabilities(engine: EngineId): EngineCapabilities {
  return ENGINE_CAPABILITIES[normalizeEngineId(engine)];
}

/** Static declaration only; live availability comes from `EngineRuntimeStatus`. */
export function engineSupports(engine: EngineId, capability: EngineCapability): boolean {
  return engineCapabilities(engine)[capability];
}

/** Refusal a caller returns (or throws as `errorCode`) when a capability is closed. */
export type EngineCapabilityRefusal = {
  errorCode: typeof ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE;
  engine: EngineId;
  capability: EngineCapability;
  message: string;
};

export function engineCapabilityRefusal(
  engine: EngineId,
  capability: EngineCapability,
): EngineCapabilityRefusal {
  const normalized = normalizeEngineId(engine);
  return {
    errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
    engine: normalized,
    capability,
    message: `The ${normalized} engine does not support "${capability}" in this build`,
  };
}

// ---------------------------------------------------------------------------
// Versioned runtime / session reference
// ---------------------------------------------------------------------------

/**
 * Bump when the meaning of a persisted `SessionEngineRef` changes (fields
 * added, renamed, or reinterpreted). Readers refuse references they do not
 * understand instead of guessing what an older or newer field meant.
 */
export const ENGINE_ADAPTER_VERSION = 1;

/**
 * What the desktop persists to bind a session to its engine and to the native
 * runtime state that carries its transcript.
 *
 * `runtimeVersion` is the engine's own version (`null` until the runtime
 * reports it); `nativeSessionId`/`nativeSessionPath` are the native handles the
 * engine resumes from, which the desktop never writes itself.
 */
export type SessionEngineRef = {
  engine: EngineId;
  adapterVersion: number;
  runtimeVersion: string | null;
  nativeSessionId: string | null;
  nativeSessionPath: string | null;
};

export type SessionEngineRefInput = {
  engine?: unknown;
  adapterVersion?: unknown;
  runtimeVersion?: unknown;
  nativeSessionId?: unknown;
  nativeSessionPath?: unknown;
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build a reference from persisted or partial input.
 *
 * A missing or unknown engine resolves to Pi (legacy records), a missing
 * adapter version resolves to the current one, and unknown fields are dropped —
 * the result is always a complete, typed reference.
 */
export function sessionEngineRef(input: SessionEngineRefInput = {}): SessionEngineRef {
  return {
    engine: normalizeEngineId(input.engine),
    adapterVersion:
      typeof input.adapterVersion === "number" &&
      Number.isInteger(input.adapterVersion) &&
      input.adapterVersion > 0
        ? input.adapterVersion
        : ENGINE_ADAPTER_VERSION,
    runtimeVersion: nullableString(input.runtimeVersion),
    nativeSessionId: nullableString(input.nativeSessionId),
    nativeSessionPath: nullableString(input.nativeSessionPath),
  };
}

/** True when a persisted value is a reference this build can act on. */
export function isSessionEngineRef(value: unknown): value is SessionEngineRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    isEngineId(ref.engine) &&
    typeof ref.adapterVersion === "number" &&
    Number.isInteger(ref.adapterVersion) &&
    ref.adapterVersion > 0 &&
    ref.adapterVersion <= ENGINE_ADAPTER_VERSION
  );
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export type EngineRuntimePhase = "stopped" | "starting" | "idle" | "running" | "failed";

/** Why an engine cannot run a turn right now, when it cannot. */
export type EngineUnavailableReason =
  /** The product has no implementation for this engine yet (M2: OMP turns). */
  | "not-implemented"
  /** No runtime process is running. */
  | "not-started"
  /** The runtime process failed to start; `detail` says how. */
  | "start-failed"
  /** The runtime reported a different version than the one this build pins. */
  | "version-mismatch"
  /** The runtime refused the protocol version this build requires. */
  | "protocol-unsupported"
  /** The stream the runtime was using is unusable; the runtime must be rebuilt. */
  | "transport-failed"
  /**
   * A previous runtime of this engine could not be reclaimed: its process group
   * is still populated, or its run directory survived. The engine must not be
   * started again until that ownership is disposed of, so this is a blocking
   * state rather than a transient one.
   */
  | "unreclaimed";

/**
 * What the desktop tells its own UI and its gates about one engine.
 *
 * `capabilities` already folds in the live half: a statically supported
 * capability is still false while the runtime is down.
 */
export type EngineRuntimeStatus = {
  engine: EngineId;
  phase: EngineRuntimePhase;
  runtimeVersion: string | null;
  protocolVersion: number | null;
  reason: EngineUnavailableReason | null;
  detail?: string;
  capabilities: EngineCapabilities;
};

/** Every capability closed; the value a status carries while nothing runs. */
export function closedEngineCapabilities(): EngineCapabilities {
  return Object.fromEntries(
    ENGINE_CAPABILITY_KEYS.map((key) => [key, false]),
  ) as unknown as EngineCapabilities;
}

/**
 * Capabilities usable right now: a statically supported capability is still
 * closed until the runtime is up, so a caller cannot act on a session whose
 * engine has stopped.
 */
export function liveEngineCapabilities(
  engine: EngineId,
  phase: EngineRuntimePhase,
): EngineCapabilities {
  return phase === "idle" || phase === "running"
    ? engineCapabilities(engine)
    : closedEngineCapabilities();
}

// ---------------------------------------------------------------------------
// Protocol / version pins
// ---------------------------------------------------------------------------

/**
 * The only RPC framing version this product negotiates. OMP's `ready` advertises
 * `[1, 2]` but rejects a v1 negotiation outright (M1/E01, `rpc-mode.ts:1176`), so
 * v2 is a requirement, not a preference.
 */
export const OMP_PROTOCOL_VERSION = 2;

/**
 * The OMP runtime version this build was validated against (`packages/utils`
 * version of the pinned submodule, `docs/source-baseline.json`). The runtime
 * package refuses to start a process that reports anything else unless the
 * caller explicitly opts out.
 */
export const OMP_RUNTIME_VERSION = "18.2.7";

/** One JSONL frame, newline included (`rpc-frame.ts` MAX_RPC_FRAME_BYTES). */
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;

/** One logical frame after protocol-v2 chunk reassembly. */
export const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The minimal runtime handle
// ---------------------------------------------------------------------------

/**
 * What the session layer needs from an engine runtime in this release: start it,
 * stop it, and read a status whose capabilities decide whether a session action
 * is allowed. Message-level operations arrive with the conversation slice and
 * are intentionally absent — an interface that declared them would have to
 * pretend the OMP engine can serve them today.
 */
/**
 * What a stop must report. "Stopped" is not enough: a runtime whose process
 * group is still populated, or whose scratch directory could not be removed,
 * was not reclaimed, and the caller has to know that before it forgets the run.
 */
export type EngineStopOutcome = {
  /** The runtime is not running any more. */
  stopped: boolean;
  /** No process from the runtime's group remains. */
  reaped: boolean;
  /** Its owned directories are gone. */
  cleaned: boolean;
  detail?: string;
};

export interface EngineRuntimeHandle {
  readonly engine: EngineId;
  status(): EngineRuntimeStatus;
  start(): Promise<EngineRuntimeStatus>;
  stop(): Promise<EngineStopOutcome>;
}
