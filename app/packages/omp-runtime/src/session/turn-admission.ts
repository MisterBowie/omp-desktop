/**
 * The turn admission: the one immutable per-prompt policy the desktop hands
 * to the trusted gate (M5/T20-C review repair).
 *
 * The gate's execution-time decisions must come from a snapshot that was
 * assembled once by the owning desktop session and bound to the admitted turn
 * — never from a mutable file that a tool body can rewrite mid-turn, and never
 * from an earlier turn's or another session's snapshot. The run-scoped state
 * file (T20-B1) remains the *content* channel (mode block, skills, memory) and
 * the mandatory-presence proof; this admission is the *policy* channel.
 *
 * The admission rides the existing turn-fence handshake: the runner appends
 * the base64url-encoded JSON to the internal `/omp-desktop-turn` command, and
 * the gate installs it (with the fence token) only after validating every
 * field against the same schema the state file uses. The acknowledgment
 * carries the SHA-256 of the encoded text, so the runner can prove the gate
 * installed exactly the admission it sent before the user prompt is
 * submitted. A prompt without an admission keeps the pre-repair disk-driven
 * behavior (a fixture-driven host that never wrote an admission); the wired
 * product bridge always writes one.
 *
 * The admission also carries the session's deliberate scoped grants (PI
 * `session_grants`, owned by the desktop session, minted only by an answered
 * "Allow for this session" decision). The gate seeds its in-turn grant set
 * from this list, so a grant survives a same-session runtime replacement
 * (M5/T20-B1's Plan → Agent rebuild) without ever putting a mutable grant
 * list on disk: the list is desktop main-process state, re-sent on every
 * admission and dropped when the native session identity is retired.
 *
 * This module is imported by the desktop main process and by the trusted gate
 * (which runs inside the runtime's Bun process), so it stays dependency-free
 * apart from node builtins and the state schema it validates against.
 */
import { createHash } from "node:crypto";

import {
  DESKTOP_PERMISSION_MODES,
  DESKTOP_RUNTIME_MODES,
  isHostToolPolicy,
  MAX_DESKTOP_STATE_HOST_TOOLS,
  MAX_HOST_TOOL_NAME_CHARS,
  type DesktopHostToolPolicy,
  type DesktopPermissionMode,
  type DesktopRuntimeMode,
} from "../desktop-state.js";

/** Admission schema version this build writes and reads. */
export const OMP_TURN_ADMISSION_VERSION = 1;

/**
 * The base64url text ceiling. The state file's own ceiling (512 KiB) bounds
 * the catalog table; the encoded admission is bounded independently so a
 * malformed or oversized handshake is refused before it is decoded, never
 * silently truncated.
 */
export const MAX_TURN_ADMISSION_CHARS = 512 * 1024;

/** At most this many granted names may ride one admission. */
export const MAX_TURN_ADMISSION_GRANTS = 512;

/**
 * One prompt's admission: the operating mode, the effective permission mode,
 * the host-tool policy table and the session's current grants, all owned by
 * the desktop session and bound to the native session identity.
 */
export type OmpTurnAdmission = {
  v: typeof OMP_TURN_ADMISSION_VERSION;
  /** The native session this policy was assembled for. */
  nativeSessionId: string;
  mode: DesktopRuntimeMode;
  permissionMode: DesktopPermissionMode;
  /** Risk/plan-safe policy for every host tool registered for this prompt. */
  hostTools: DesktopHostToolPolicy[];
  /** Tool names granted for this desktop session, in decision order. */
  grants: string[];
};

/**
 * Encode one admission for the fence handshake. Throws when the encoded text
 * exceeds the wire ceiling: an oversized admission must refuse the prompt
 * (fail closed) rather than be sent truncated.
 */
export function encodeTurnAdmission(admission: OmpTurnAdmission): string {
  const encoded = Buffer.from(JSON.stringify(admission), "utf8").toString("base64url");
  if (encoded.length > MAX_TURN_ADMISSION_CHARS) {
    throw new Error(
      `the turn admission is ${encoded.length} characters, over the ${MAX_TURN_ADMISSION_CHARS} ceiling`,
    );
  }
  return encoded;
}

/**
 * Decode and fully validate one admission argument.
 *
 * Returns null for anything that is not exactly this schema: a malformed,
 * out-of-schema, over-long or partial payload must never become a policy the
 * gate decides with.
 */
export function decodeTurnAdmission(text: unknown): OmpTurnAdmission | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TURN_ADMISSION_CHARS) return null;
  let json: string;
  try {
    json = Buffer.from(text, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (json.length === 0 || json.length > MAX_TURN_ADMISSION_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== OMP_TURN_ADMISSION_VERSION) return null;
  if (
    typeof record.nativeSessionId !== "string" ||
    record.nativeSessionId.length === 0 ||
    record.nativeSessionId.length > 512
  ) {
    return null;
  }
  if (!(DESKTOP_RUNTIME_MODES as readonly unknown[]).includes(record.mode)) return null;
  if (!(DESKTOP_PERMISSION_MODES as readonly unknown[]).includes(record.permissionMode)) return null;
  if (!Array.isArray(record.hostTools) || record.hostTools.length > MAX_DESKTOP_STATE_HOST_TOOLS) return null;
  const hostTools: DesktopHostToolPolicy[] = [];
  const names = new Set<string>();
  for (const entry of record.hostTools) {
    if (!isHostToolPolicy(entry)) return null;
    if (names.has(entry.name)) return null;
    names.add(entry.name);
    hostTools.push({
      name: entry.name,
      risk: entry.risk,
      planSafeActions: [...entry.planSafeActions],
      origin: entry.origin,
    });
  }
  if (!Array.isArray(record.grants) || record.grants.length > MAX_TURN_ADMISSION_GRANTS) return null;
  const grants: string[] = [];
  const granted = new Set<string>();
  for (const grant of record.grants) {
    if (typeof grant !== "string" || grant.length === 0 || grant.length > MAX_HOST_TOOL_NAME_CHARS) return null;
    if (granted.has(grant)) return null;
    granted.add(grant);
    grants.push(grant);
  }
  return {
    v: OMP_TURN_ADMISSION_VERSION,
    nativeSessionId: record.nativeSessionId,
    mode: record.mode as DesktopRuntimeMode,
    permissionMode: record.permissionMode as DesktopPermissionMode,
    hostTools,
    grants,
  };
}

/** The handshake acknowledgment digest: SHA-256 over the encoded argument. */
export function admissionDigest(encoded: string): string {
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}
