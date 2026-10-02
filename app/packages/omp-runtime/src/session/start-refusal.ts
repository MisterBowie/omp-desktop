/**
 * The desktop's structured turn-refusal signal (M5/T20-B1 repair).
 *
 * The pinned runtime gives a `before_agent_start` handler exactly one formal
 * way to refuse a turn: `ctx.abort()`. That call stops the agent loop before
 * any provider request, but the runtime emits no `agent_start` and no
 * `agent_end` for the refused turn — the RPC `prompt` command still answers
 * `success: true` (the command was accepted; the turn was then aborted), and
 * a runner that only watches for terminal agent events would keep reporting
 * the turn as running forever.
 *
 * The gate therefore pairs the abort with a second formal channel: a
 * `notify` extension-UI request (`ctx.ui.notify` → the runtime's own
 * `extension_ui_request` frame) whose message is this versioned descriptor.
 * The desktop runner parses it, checks that it names the session it is
 * currently starting, and closes exactly that generation with one observable
 * `error` envelope and one `turnEnd` announcement.
 *
 * Attribution protocol (both directions are tested):
 *
 *   - the descriptor must be the exact kind/version shape below — a user
 *     notification or any other extension's message parses to `null`;
 *   - `sessionId` must equal the native session id of the runtime the runner
 *     owns (a delegate's or another session's refusal is ignored);
 *   - a run must be in flight and must not have emitted `agent_start` yet (a
 *     refusal can only be produced before the provider request; a redundant
 *     or late signal must never close a newer generation);
 *   - the run lifecycle closes a generation at most once (`closeGeneration`),
 *     so a duplicated delivery cannot produce a second terminal event.
 *
 * `refusalId` exists for diagnostics: it is unique per refusal invocation, so
 * a refusal and the error envelope it produced can be correlated in logs. It
 * is deliberately *not* trusted as an ownership token — the frame ordering on
 * the one stdout pipe plus the runner's "one prompt at a time" admission are
 * what make the attribution replay-free.
 */

/** The descriptor kind that marks a desktop start refusal. */
export const OMP_START_REFUSAL_KIND = "omp-desktop-start-refusal";

/** The descriptor version this build writes and reads. */
export const OMP_START_REFUSAL_VERSION = 1;

/**
 * Why the gate refused the turn. `state-missing` covers every unattributable
 * state file (deleted, truncated, oversized, unparseable identity);
 * `state-invalid` an owned file that fails the schema; `state-foreign` a valid
 * file that names another native session; `clamp-unavailable` a runtime that
 * exposes no tool-selection API; `gate-error` an unexpected handler failure
 * while this session owned the state.
 */
export const OMP_START_REFUSAL_CODES = [
  "state-missing",
  "state-invalid",
  "state-foreign",
  "clamp-unavailable",
  "gate-error",
] as const;
export type OmpStartRefusalCode = (typeof OMP_START_REFUSAL_CODES)[number];

/** One decoded start refusal. */
export type OmpStartRefusal = {
  v: typeof OMP_START_REFUSAL_VERSION;
  kind: typeof OMP_START_REFUSAL_KIND;
  /** The firing native session id, or null when the context exposed none. */
  sessionId: string | null;
  code: OmpStartRefusalCode;
  reason: string;
  /** Unique per refusal invocation (diagnostics only, not an ownership token). */
  refusalId: string;
  /** The gate's epoch milliseconds, for logs. */
  at: number;
};

const MAX_MESSAGE_CHARS = 8192;
const MAX_REASON_CHARS = 2000;
const MAX_SESSION_ID_CHARS = 512;
const MAX_REFUSAL_ID_CHARS = 128;

/** Serialize one refusal into the `notify` message the gate sends. */
export function encodeStartRefusal(refusal: OmpStartRefusal): string {
  return JSON.stringify(refusal);
}

/**
 * Parse one runtime frame as a desktop start refusal.
 *
 * Strict by construction: only a `notify` extension-UI request whose message
 * parses as a complete descriptor of this exact version is accepted. Every
 * other frame — including every ordinary user-facing notification — is `null`
 * and follows the normal UI-request path.
 */
export function parseStartRefusalNotice(frame: unknown): OmpStartRefusal | null {
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
  if (descriptor.v !== OMP_START_REFUSAL_VERSION || descriptor.kind !== OMP_START_REFUSAL_KIND) return null;
  const sessionId = descriptor.sessionId;
  if (
    sessionId !== null &&
    (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS)
  ) {
    return null;
  }
  if (
    typeof descriptor.code !== "string" ||
    !(OMP_START_REFUSAL_CODES as readonly string[]).includes(descriptor.code)
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
    typeof descriptor.refusalId !== "string" ||
    descriptor.refusalId.length === 0 ||
    descriptor.refusalId.length > MAX_REFUSAL_ID_CHARS
  ) {
    return null;
  }
  if (typeof descriptor.at !== "number" || !Number.isFinite(descriptor.at)) return null;
  return {
    v: OMP_START_REFUSAL_VERSION,
    kind: OMP_START_REFUSAL_KIND,
    sessionId,
    code: descriptor.code as OmpStartRefusalCode,
    reason: descriptor.reason,
    refusalId: descriptor.refusalId,
    at: descriptor.at,
  };
}
