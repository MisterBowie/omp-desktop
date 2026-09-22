/**
 * The wire contract between the shipped OMP gate extension and the desktop.
 *
 * The pinned runtime has exactly one dialog channel for extensions
 * (`extension_ui_request` → `extension_ui_response`), and every dialog in it —
 * our gate's approval prompt, the runtime's own tool approval, the `ask` tool's
 * questions — travels as a `select`/`confirm` frame. Nothing on that channel is
 * tagged "this is a permission decision", so this module states the two rules
 * the desktop uses instead, and both are structural:
 *
 *   1. **A frame carrying our descriptor is ours.** The gate we ship encodes a
 *      versioned descriptor into `optionDetails[0].description` (a select) or
 *      `message` (a confirm). The desktop parses that field; it never reads the
 *      title or the option labels to guess intent.
 *   2. **The runtime's own approval prompt is recognised by its exact option
 *      tuple.** `wrapper.ts` asks with `select(prompt, ["Approve", "Deny"])`
 *      when the runtime's policy (not our gate) requires approval. Matching the
 *      tuple from the fixed source — not the prompt text — keeps that fallback
 *      visible in the same card instead of rendering it as a question.
 *
 * Everything else on the channel is a question, a retraction (`method:
 * "cancel"`) or a fire-and-forget notice, which is the discriminator the
 * runtime's own type union (`RpcExtensionUIRequest`) defines.
 *
 * This file is imported by the extension, which runs inside the runtime's own
 * Bun process: it must stay dependency-free. The desktop imports it too, so the
 * two sides cannot drift.
 */

/** Marker for our descriptor; a different product must not be able to claim it. */
export const OMP_APPROVAL_KIND = "omp-desktop-approval";
export const OMP_APPROVAL_VERSION = 1;

/** Options our gate offers, in order. Allow-once is index 0. */
export const OMP_APPROVAL_OPTIONS: readonly [string, string, string] = [
  "Allow once",
  "Allow for this session",
  "Deny",
];
/** Convenience aliases for the two options a caller names by role. */
export const OMP_APPROVAL_ALLOW_LABEL = OMP_APPROVAL_OPTIONS[0];
export const OMP_APPROVAL_DENY_LABEL = OMP_APPROVAL_OPTIONS[2];

/**
 * The runtime's own approval tuple (`extensibility/extensions/wrapper.ts`,
 * `uiContext.select(safetyPrompt, ["Approve", "Deny"])`). Recognised so the
 * native prompt is not mistaken for a question.
 */
export const OMP_NATIVE_APPROVAL_OPTIONS: readonly string[] = ["Approve", "Deny"];

/** Risk levels, mirroring the desktop's `Risk` union. */
export type OmpApprovalRisk = "low" | "medium" | "high";

/** Structured description of one pending tool call, encoded into the dialog. */
export type OmpApprovalDescriptor = {
  v: number;
  kind: typeof OMP_APPROVAL_KIND;
  /** Session identity the gate saw, when the hook exposes it. */
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  risk: OmpApprovalRisk;
  reason: string;
  /** The tool arguments exactly as the hook received them. */
  argsPreview: unknown;
  /** Working directory of the call, when the hook exposes it. */
  cwd?: string;
};

/** Our gate's dialog for one approval: what it sends and how it reads an answer. */
export type OmpApprovalDialog = {
  title: string;
  options: [string, string];
  optionDetails: [{ description: string }, { description?: string }];
};

export function encodeApprovalDescriptor(descriptor: OmpApprovalDescriptor): string {
  return JSON.stringify(descriptor);
}

/**
 * Read our descriptor out of a dialog field.
 *
 * Returns null for anything that is not exactly our envelope: a partial or
 * future-version payload must never be treated as an approval, because an
 * approval decides whether a tool runs.
 */
export function parseApprovalDescriptor(text: unknown): OmpApprovalDescriptor | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== OMP_APPROVAL_KIND) return null;
  if (record.v !== OMP_APPROVAL_VERSION) return null;
  if (typeof record.toolCallId !== "string" || record.toolCallId.length === 0) return null;
  if (typeof record.toolName !== "string" || record.toolName.length === 0) return null;
  const risk = record.risk;
  if (risk !== "low" && risk !== "medium" && risk !== "high") return null;
  return {
    v: OMP_APPROVAL_VERSION,
    kind: OMP_APPROVAL_KIND,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    risk,
    reason: typeof record.reason === "string" ? record.reason : "",
    argsPreview: record.argsPreview,
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
  };
}

/** True when a select's option list is exactly the runtime's approval tuple. */
export function isNativeApprovalOptions(options: unknown): boolean {
  return (
    Array.isArray(options) &&
    options.length === OMP_NATIVE_APPROVAL_OPTIONS.length &&
    options.every((option, index) => option === OMP_NATIVE_APPROVAL_OPTIONS[index])
  );
}
