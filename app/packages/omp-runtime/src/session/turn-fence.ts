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
 *   2. it sends `/<OMP_TURN_COMMAND> <token>` through the runtime's formal RPC
 *      `prompt` command — a registered extension command, executed by
 *      `#tryExecuteExtensionCommand` before any provider loop, so the message
 *      is consumed locally and never reaches the provider, the transcript or
 *      the tool catalogue;
 *   3. the gate's command handler verifies the token and answers with a
 *      versioned acknowledgment descriptor through the runtime's own `notify`
 *      extension-UI channel; the runtime also emits its formal
 *      `prompt_result { agentInvoked: false }` for the consumed prompt;
 *   4. the runner waits for that acknowledgment before submitting the real
 *      prompt, so the token is provably installed for this generation;
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

/** The acknowledgment descriptor version this build writes and reads. */
export const OMP_TURN_ACK_VERSION = 1;

/** A token is a UUID with its dashes removed: 32 lowercase hex characters. */
const TURN_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

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

/** The exact `prompt` message that installs one turn's token. */
export function turnCommandMessage(token: string): string {
  return `/${OMP_TURN_COMMAND} ${token}`;
}

/**
 * The token carried by one handshake message, or `null` when the message is
 * not exactly this command with a well-formed token.
 */
export function turnCommandToken(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const prefix = `/${OMP_TURN_COMMAND} `;
  if (!message.startsWith(prefix)) return null;
  const token = message.slice(prefix.length);
  return isTurnToken(token) ? token : null;
}

/** One decoded turn-fence acknowledgment. */
export type OmpTurnAck = {
  v: typeof OMP_TURN_ACK_VERSION;
  kind: typeof OMP_TURN_ACK_KIND;
  token: string;
};

/** Serialize one acknowledgment into the `notify` message the gate sends. */
export function encodeTurnAck(token: string): string {
  return JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token });
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
  if (parsed.v !== OMP_TURN_ACK_VERSION || parsed.kind !== OMP_TURN_ACK_KIND) return null;
  const token = parsed.token;
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS || !isTurnToken(token)) return null;
  return { v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token };
}
