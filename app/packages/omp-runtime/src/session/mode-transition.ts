/**
 * The desktop's mid-turn contract-mode transition record (M5/T20-D).
 *
 * A successful `EnterPlanMode`/`EnterGoalMode` host-tool call must change the
 * *live* turn's contract before the next provider request: the system prompt,
 * the tool catalogue and the execution-time policy all move to the new mode,
 * while the durable turn, the native session and the agent run stay the same
 * (PI's `EnterPlanMode` is explicitly non-terminating).
 *
 * The host must therefore authorise the transition on a trusted channel. The
 * tool result itself is that channel: the desktop adapter — and only the
 * desktop adapter — attaches this record to `host_tool_result.result.details`,
 * which the runtime carries to the trusted gate through the extension
 * `tool_result` hook. The record names every identity the run can check, so
 * the gate can refuse an unauthorised, stale, foreign, replayed or malformed
 * transition instead of applying whatever a result happened to claim:
 *
 *   - `sessionId` — the native session that owns the live run;
 *   - `liveTurnId` — the run's own live generation identity (`omp-turn:…`,
 *     never a host-database identity); informational for the gate (the event
 *     is emitted in-process by the very run that executed the call), recorded
 *     for diagnostics;
 *   - `hostTurnId` — the durable host turn `plans.enter` validated; the host
 *     itself refuses a stale or missing turn before it commits;
 *   - `toolCallId` — the exact tool call this record belongs to; the gate
 *     requires it to equal the `tool_result` event's own id, so a record can
 *     only ever move the call that carried it;
 *   - `expectedMode` — the mode the run must currently be in. Only an
 *     `Agent -> Plan|Goal` transition exists, so it is always `"agent"`; a run
 *     already in a contract mode can never be moved by a record.
 *
 * `state` distinguishes an applied transition from one the host committed but
 * the desktop could not prepare (`"failed"`: a catalogue re-registration
 * failure, a stop racing the commit). A failed record is still delivered so
 * the gate can stop the inconsistent turn (abort + structured turn failure);
 * the next prompt recovers from the authoritative host row.
 *
 * Only a `"ready"` record carries the new mode's material: the exact
 * `composeModeSystemPrompt(kind, "")` block (the desktop is the single source
 * of the PI prompt bytes) and the new host-tool policy table. Both are
 * validated with the same contracts the run-scoped state file uses, so no
 * second schema exists.
 */
import {
  isHostToolPolicy,
  MAX_DESKTOP_STATE_HOST_TOOLS,
  MAX_MODE_BLOCK_CHARS,
  type DesktopHostToolPolicy,
} from "../desktop-state.js";

/** The record version this build writes and reads. */
export const OMP_MODE_TRANSITION_VERSION = 1;

/** The only key under which a record rides `result.details`. */
export const OMP_MODE_TRANSITION_KEY = "ompDesktopModeTransition";

/** The contract kinds a transition may enter. */
export const OMP_MODE_TRANSITION_KINDS = ["plan", "goal"] as const;
export type OmpModeTransitionKind = (typeof OMP_MODE_TRANSITION_KINDS)[number];

/** The Enter tool one kind belongs to, exactly PI's `ENTER_TOOL_NAMES`. */
export const OMP_ENTER_TOOL_NAMES: Record<OmpModeTransitionKind, string> = {
  plan: "EnterPlanMode",
  goal: "EnterGoalMode",
};

/** The mode the run must be in for any transition to be legal (PI: Agent-only). */
export const OMP_MODE_TRANSITION_EXPECTED_MODE = "agent";

/** At most this many characters for the identity fields. */
const MAX_ID_CHARS = 512;
const MAX_REASON_CHARS = 2000;

/**
 * Serialized ceiling for one encoded record.
 *
 * The record rides a 1 MiB `host_tool_result` line together with the result
 * content, and a pathological host-tool policy table (`MAX_DESKTOP_STATE_HOST_TOOLS`
 * entries of bounded strings) can serialize past any frame budget. The encoder
 * refuses to produce an oversized record — the desktop then reports a failed
 * transition instead of writing a frame the runtime cannot read — and the
 * decoder applies the same ceiling to what it accepts.
 */
export const OMP_MODE_TRANSITION_MAX_BYTES = 192 * 1024;

/** One mode transition the desktop prepared for the live run. */
type OmpModeTransitionBase = {
  v: typeof OMP_MODE_TRANSITION_VERSION;
  kind: OmpModeTransitionKind;
  sessionId: string;
  liveTurnId: string;
  hostTurnId: string;
  toolCallId: string;
  expectedMode: typeof OMP_MODE_TRANSITION_EXPECTED_MODE;
  /** The desktop's clock, for diagnostics. */
  at: number;
};

/**
 * `"ready"` — the host committed and the desktop prepared the new mode's
 * material: the exact mode block and the new host-tool policy table.
 * `"failed"` — the host committed but the desktop could not prepare the
 * runtime-side transition (a catalogue re-registration failure, a stop racing
 * the commit): the gate must stop the inconsistent turn instead of applying a
 * partial transition.
 */
export type OmpModeTransition =
  | (OmpModeTransitionBase & {
      state: "ready";
      /** `composeModeSystemPrompt(kind, "")` output. */
      modeBlock: string;
      /** The new mode's host-tool policy table. */
      hostTools: DesktopHostToolPolicy[];
    })
  | (OmpModeTransitionBase & { state: "failed"; reason: string });

/** Wrap one record for `host_tool_result.result.details`. */
export function encodeModeTransitionDetails(
  transition: OmpModeTransition,
): Record<string, OmpModeTransition> {
  const envelope = { [OMP_MODE_TRANSITION_KEY]: transition };
  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (bytes > OMP_MODE_TRANSITION_MAX_BYTES) {
    throw new Error(
      `the mode transition record is ${bytes} bytes, over the ${OMP_MODE_TRANSITION_MAX_BYTES}-byte ceiling`,
    );
  }
  return envelope;
}

const IDENTITY_KEYS = ["sessionId", "liveTurnId", "hostTurnId", "toolCallId"] as const;

/**
 * Decode one tool result's `details` as a mode transition, or `null`.
 *
 * Strict by construction: every field must be present with the exact declared
 * shape and within its bound, unknown keys are refused (a record with extra
 * claims is not this contract), and the ready/failed material must be exactly
 * the one its state declares. Anything else is `null` — the gate then decides
 * whether the absence is an ordinary tool error or an anomaly.
 */
export function decodeModeTransitionDetails(details: unknown): OmpModeTransition | null {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
  const envelope = details as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (keys.length !== 1 || keys[0] !== OMP_MODE_TRANSITION_KEY) return null;
  const raw = envelope[OMP_MODE_TRANSITION_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > OMP_MODE_TRANSITION_MAX_BYTES) return null;
  const record = raw as Record<string, unknown>;
  const allowed = new Set([
    "v",
    "kind",
    "state",
    "sessionId",
    "liveTurnId",
    "hostTurnId",
    "toolCallId",
    "expectedMode",
    "modeBlock",
    "hostTools",
    "reason",
    "at",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return null;
  }
  if (record.v !== OMP_MODE_TRANSITION_VERSION) return null;
  if (typeof record.kind !== "string" || !(OMP_MODE_TRANSITION_KINDS as readonly string[]).includes(record.kind)) {
    return null;
  }
  if (record.state !== "ready" && record.state !== "failed") return null;
  for (const key of IDENTITY_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) return null;
  }
  if (record.expectedMode !== OMP_MODE_TRANSITION_EXPECTED_MODE) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  if (record.state === "ready") {
    if (
      typeof record.modeBlock !== "string" ||
      record.modeBlock.length === 0 ||
      record.modeBlock.length > MAX_MODE_BLOCK_CHARS
    ) {
      return null;
    }
    const hostTools = record.hostTools;
    if (
      !Array.isArray(hostTools) ||
      hostTools.length > MAX_DESKTOP_STATE_HOST_TOOLS ||
      !hostTools.every((entry) => isHostToolPolicy(entry))
    ) {
      return null;
    }
    if (record.reason !== undefined) return null;
    return {
      v: OMP_MODE_TRANSITION_VERSION,
      kind: record.kind as OmpModeTransitionKind,
      state: "ready",
      sessionId: record.sessionId as string,
      liveTurnId: record.liveTurnId as string,
      hostTurnId: record.hostTurnId as string,
      toolCallId: record.toolCallId as string,
      expectedMode: OMP_MODE_TRANSITION_EXPECTED_MODE,
      modeBlock: record.modeBlock,
      hostTools: hostTools as DesktopHostToolPolicy[],
      at: record.at,
    };
  }
  if (
    typeof record.reason !== "string" ||
    record.reason.length === 0 ||
    record.reason.length > MAX_REASON_CHARS ||
    record.modeBlock !== undefined ||
    record.hostTools !== undefined
  ) {
    return null;
  }
  return {
    v: OMP_MODE_TRANSITION_VERSION,
    kind: record.kind as OmpModeTransitionKind,
    state: "failed",
    sessionId: record.sessionId as string,
    liveTurnId: record.liveTurnId as string,
    hostTurnId: record.hostTurnId as string,
    toolCallId: record.toolCallId as string,
    expectedMode: OMP_MODE_TRANSITION_EXPECTED_MODE,
    reason: record.reason,
    at: record.at,
  };
}

/** The Enter tool name for a transition kind. */
export function enterToolNameForKind(kind: OmpModeTransitionKind): string {
  return OMP_ENTER_TOOL_NAMES[kind];
}

/** The transition kind an Enter tool name declares, or `null`. */
export function enterKindForToolName(toolName: string): OmpModeTransitionKind | null {
  if (toolName === OMP_ENTER_TOOL_NAMES.plan) return "plan";
  if (toolName === OMP_ENTER_TOOL_NAMES.goal) return "goal";
  return null;
}
