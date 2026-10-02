/**
 * The desktop turn fence (M5/T20-B1 second repair).
 *
 * A structured start refusal (`start-refusal.ts`) must close exactly the
 * desktop turn it was produced for. The pinned runtime offers no per-turn
 * identity at the extension boundary — `before_agent_start` sees the native
 * session, never the desktop's generation — so the desktop installs one
 * **turn token** inside the runtime process before every prompt and requires
 * every refusal to echo it:
 *
 *   1. the runner mints a fresh token for the admitted generation;
 *   2. it sends `/<OMP_TURN_COMMAND> <token> [<encoded admission>]` through
 *      the runtime's formal RPC `prompt` command — a registered extension
 *      command, executed by `#tryExecuteExtensionCommand` before any provider
 *      loop, so the message is consumed locally and never reaches the
 *      provider, the transcript or the tool catalogue. The optional admission
 *      (`turn-admission.ts`) is the desktop-owned per-prompt policy; when it
 *      is present the gate installs it *only* for this token;
 *   3. the gate's command handler verifies the token (and decodes/validates
 *      the admission) and answers with a versioned acknowledgment descriptor
 *      through the runtime's own `notify` extension-UI channel, echoing the
 *      SHA-256 of the admission argument it installed (M5/T20-C review
 *      repair); the runtime also emits its formal
 *      `prompt_result { agentInvoked: false }` for the consumed prompt;
 *   4. the runner waits for that acknowledgment before submitting the real
 *      prompt, so the token — and the exact policy admission — are provably
 *      installed for this generation;
 *   5. a refusal that carries a different token (a duplicate delivery, an
 *      unseen delayed descriptor from an earlier generation, a foreign
 *      writer) is counted and ignored.
 *
 * Availability is verified before the handshake is used: the runner asks the
 * runtime for `get_available_commands` and requires the command to be
 * registered as an extension command. A runtime that does not advertise it
 * would forward the raw handshake text to the provider, so the prompt is
 * refused *before* it is submitted instead.
 *
 * The token is a random 32-hex string (a dash-less UUID). It is deliberately
 * not derived from timestamps or from the prompt text: a stale descriptor must
 * fail the comparison even when it is replayed byte-for-byte years later.
 */
import { randomUUID } from "node:crypto";

/** The internal slash command the gate registers and the runner invokes. */
export const OMP_TURN_COMMAND = "omp-desktop-turn";

/** The acknowledgment descriptor kind, distinct from any user notification. */
export const OMP_TURN_ACK_KIND = "omp-desktop-turn-ack";

/**
 * The acknowledgment descriptor version this build writes and reads.
 *
 * v2 adds the admission digest (M5/T20-C review repair): the gate echoes the
 * SHA-256 of the encoded turn admission it installed, so the runner only
 * submits the user prompt after the gate provably holds that exact policy. A
 * v1 descriptor (no digest) no longer parses — the runner refuses the prompt
 * instead of arming an unbound turn.
 */
export const OMP_TURN_ACK_VERSION = 2;

/** A token is a UUID with its dashes removed: 32 lowercase hex characters. */
const TURN_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** A digest is one SHA-256 in lowercase hex. */
const ADMISSION_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Bounded so a malformed frame cannot smuggle an unbounded string. */
const MAX_ACK_MESSAGE_CHARS = 4096;
const MAX_TOKEN_CHARS = 128;

/** One fresh token for one admitted desktop turn. */
export function mintTurnToken(): string {
  return randomUUID().replace(/-/g, "");
}

/** True when a value is exactly one well-formed turn token. */
export function isTurnToken(value: unknown): value is string {
  return typeof value === "string" && TURN_TOKEN_PATTERN.test(value);
}

/**
 * The exact `prompt` message that installs one turn's token (and, when the
 * caller has one, the encoded policy admission the gate must install with it).
 */
export function turnCommandMessage(token: string, admission?: string): string {
  return admission === undefined
    ? `/${OMP_TURN_COMMAND} ${token}`
    : `/${OMP_TURN_COMMAND} ${token} ${admission}`;
}

/** One decoded handshake message: the token plus the optional admission argument. */
export type OmpTurnCommand = {
  token: string;
  /** The encoded admission argument, or null for a token-only handshake. */
  admission: string | null;
};

/**
 * The token and admission carried by one handshake *argument* string — what
 * the runtime's command dispatch passes to the gate's handler, i.e. everything
 * after `/<OMP_TURN_COMMAND> `. Returns `null` when it is not exactly a
 * well-formed token with an optional whitespace-free admission; the admission
 * is returned verbatim and the gate decodes and validates it.
 */
export function turnCommandArgs(args: unknown): OmpTurnCommand | null {
  if (typeof args !== "string") return null;
  const space = args.indexOf(" ");
  const token = space === -1 ? args : args.slice(0, space);
  if (!isTurnToken(token)) return null;
  if (space === -1) return { token, admission: null };
  const admission = args.slice(space + 1);
  if (admission.length === 0 || admission.includes(" ")) return null;
  return { token, admission };
}

/**
 * The token and admission carried by one full handshake message (the form the
 * runner writes into the runtime's `prompt` command), or `null` when it is not
 * exactly this command with a well-formed argument.
 */
export function parseTurnCommand(message: unknown): OmpTurnCommand | null {
  if (typeof message !== "string") return null;
  const prefix = `/${OMP_TURN_COMMAND} `;
  if (!message.startsWith(prefix)) return null;
  return turnCommandArgs(message.slice(prefix.length));
}

/** The token carried by one handshake message, when it carries one. */
export function turnCommandToken(message: unknown): string | null {
  return parseTurnCommand(message)?.token ?? null;
}

/** One decoded turn-fence acknowledgment. */
export type OmpTurnAck = {
  v: typeof OMP_TURN_ACK_VERSION;
  kind: typeof OMP_TURN_ACK_KIND;
  token: string;
  /** SHA-256 of the admission argument the gate installed, or null. */
  admissionDigest: string | null;
};

/** Serialize one acknowledgment into the `notify` message the gate sends. */
export function encodeTurnAck(token: string, admissionDigest: string | null = null): string {
  return JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token, admissionDigest });
}

/**
 * Parse one runtime frame as a turn-fence acknowledgment.
 *
 * Strict by construction, exactly like the refusal parser: only a `notify`
 * extension-UI request whose message is this exact descriptor is accepted, so
 * an ordinary user-facing notification can never settle a fence.
 */
export function parseTurnAckNotice(frame: unknown): OmpTurnAck | null {
  if (typeof frame !== "object" || frame === null) return null;
  if (!("type" in frame) || !("method" in frame) || !("message" in frame)) return null;
  if (frame.type !== "extension_ui_request" || frame.method !== "notify") return null;
  const message = frame.message;
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_ACK_MESSAGE_CHARS) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (!("v" in parsed) || !("kind" in parsed) || !("token" in parsed)) return null;
  if (!("admissionDigest" in parsed)) return null;
  if (parsed.v !== OMP_TURN_ACK_VERSION || parsed.kind !== OMP_TURN_ACK_KIND) return null;
  const token = parsed.token;
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS || !isTurnToken(token)) return null;
  const digest = parsed.admissionDigest;
  if (digest !== null && (typeof digest !== "string" || !ADMISSION_DIGEST_PATTERN.test(digest))) return null;
  return { v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token, admissionDigest: digest };
}
