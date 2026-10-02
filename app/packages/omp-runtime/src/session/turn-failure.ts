/**
 * The desktop's structured mid-turn failure signal (M5/T20-D).
 *
 * A host-confirmed `Agent -> Plan|Goal` transition can fail *after* the host
 * has already committed the durable mode: the catalogue re-registration may
 * fail, the live prompt replacement may be unavailable, or the desktop may
 * discover the run is no longer dispatchable. The turn must then stop in a
 * way the desktop can observe, because continuing would run the rest of the
 * turn as Agent under a host row that already says Plan/Goal.
 *
 * `ctx.abort()` alone is not that signal. The pinned runtime emits a plain
 * `agent_end` for an aborted run, and the desktop runner reads an `agent_end`
 * that did not come from a user Stop as a *completed* turn, which would
 * misreport a failed transition as success. The gate therefore pairs the
 * abort with this descriptor through the same formal `notify` channel the
 * start refusal uses (`session/start-refusal.ts`), and the runner closes the
 * started generation as a failed turn: one terminal `error` envelope and one
 * `error` turn-end announcement, so the bridge settles the durable host turn
 * as failed and the next prompt recovers from the authoritative host row.
 *
 * Attribution mirrors the start refusal, with the one difference that matters:
 * the run has already started (that is the point), so the pre-start condition
 * is dropped and the live `running` state plus the exact fence token are
 * required instead. A duplicate delivery, an earlier generation's descriptor
 * (older token), a delegate's signal (its own native id) and a descriptor
 * arriving while the run is stopping are all counted and ignored.
 */
import { isTurnToken } from "./turn-fence.js";

/** The descriptor kind that marks a desktop mid-turn failure. */
export const OMP_TURN_FAILURE_KIND = "omp-desktop-turn-failure";

/** The descriptor version this build writes and reads. */
export const OMP_TURN_FAILURE_VERSION = 1;

/**
 * Why the gate failed a started turn.
 *
 * `transition-invalid` — an Enter tool returned a success (or claimed a
 * transition) the live admission cannot attribute to this run: a foreign
 * session, a stale fence, a second transition, a replayed descriptor or a
 * malformed record.
 * `transition-apply-failed` — the record was attributable and the desktop
 * could not apply it (prompt replacement or catalogue clamp unavailable), or
 * the record itself reported a failed preparation.
 */
export const OMP_TURN_FAILURE_CODES = ["transition-invalid", "transition-apply-failed"] as const;
export type OmpTurnFailureCode = (typeof OMP_TURN_FAILURE_CODES)[number];

/** One decoded mid-turn failure. */
export type OmpTurnFailure = {
  v: typeof OMP_TURN_FAILURE_VERSION;
  kind: typeof OMP_TURN_FAILURE_KIND;
  /** The firing native session id, or null when the context exposed none. */
  sessionId: string | null;
  /** The turn token the fence installed for this generation. */
  turnToken: string | null;
  code: OmpTurnFailureCode;
  reason: string;
  /** Unique per failure invocation (diagnostics only, not an ownership token). */
  failureId: string;
  /** The gate's epoch milliseconds, for logs. */
  at: number;
};

const MAX_MESSAGE_CHARS = 8192;
const MAX_REASON_CHARS = 2000;
const MAX_SESSION_ID_CHARS = 512;
const MAX_FAILURE_ID_CHARS = 128;

/** Serialize one failure into the `notify` message the gate sends. */
export function encodeTurnFailure(failure: OmpTurnFailure): string {
  return JSON.stringify(failure);
}

/**
 * Parse one runtime frame as a desktop mid-turn failure.
 *
 * Strict by construction: only a `notify` extension-UI request whose message
 * parses as a complete descriptor of this exact version is accepted. Every
 * other frame — including every ordinary user-facing notification and every
 * start refusal — is `null` and follows its own path.
 */
export function parseTurnFailureNotice(frame: unknown): OmpTurnFailure | null {
  if (typeof frame !== "object" || frame === null) return null;
  const notice = frame as { type?: unknown; method?: unknown; message?: unknown };
  if (notice.type !== "extension_ui_request" || notice.method !== "notify") return null;
  if (
    typeof notice.message !== "string" ||
    notice.message.length === 0 ||
    notice.message.length > MAX_MESSAGE_CHARS
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(notice.message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const descriptor = parsed as Record<string, unknown>;
  if (descriptor.v !== OMP_TURN_FAILURE_VERSION || descriptor.kind !== OMP_TURN_FAILURE_KIND) return null;
  const sessionId = descriptor.sessionId;
  if (
    sessionId !== null &&
    (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS)
  ) {
    return null;
  }
  if (
    descriptor.turnToken !== null &&
    (typeof descriptor.turnToken !== "string" || !isTurnToken(descriptor.turnToken))
  ) {
    return null;
  }
  if (
    typeof descriptor.code !== "string" ||
    !(OMP_TURN_FAILURE_CODES as readonly string[]).includes(descriptor.code)
  ) {
    return null;
  }
  if (
    typeof descriptor.reason !== "string" ||
    descriptor.reason.length === 0 ||
    descriptor.reason.length > MAX_REASON_CHARS
  ) {
    return null;
  }
  if (
    typeof descriptor.failureId !== "string" ||
    descriptor.failureId.length === 0 ||
    descriptor.failureId.length > MAX_FAILURE_ID_CHARS
  ) {
    return null;
  }
  if (typeof descriptor.at !== "number" || !Number.isFinite(descriptor.at)) return null;
  return {
    v: OMP_TURN_FAILURE_VERSION,
    kind: OMP_TURN_FAILURE_KIND,
    sessionId,
    turnToken: descriptor.turnToken as string | null,
    code: descriptor.code as OmpTurnFailureCode,
    reason: descriptor.reason,
    failureId: descriptor.failureId,
    at: descriptor.at,
  };
}
