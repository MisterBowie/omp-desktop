import type { UiMessage } from "@pi-desktop/shared";
import type { SubagentRun, SubagentRunItem } from "./assistant-turns";

/**
 * Renderer-side projection of an OMP child's durable transcript.
 *
 * This is a local detail projection: it reads the child's rows through the
 * OMP-only bridge and maps them into the existing `SubagentRun` structure the
 * Pi renderer already draws. Nothing here persists into the main transcript or
 * triggers a tool side effect — the read only projects already-finished rows.
 */

/** The fields a bridge list entry needs for resolution (no native path). */
export type OmpSubagentListRow = {
  id: string;
  parentToolCallId?: string;
};

/**
 * Resolve a panel selection id to an opaque child id.
 *
 * The selection carries either the child's own opaque id (`details.delegationId`
 * for a single child) or a parent Task `toolCallId`. A live list entry names the
 * child either way; when the child is no longer live (already terminal), the
 * selection id itself is the opaque child id and is used directly.
 */
export function resolveChildId(
  list: readonly OmpSubagentListRow[],
  delegationId: string,
): string | null {
  for (const entry of list) {
    if (entry.id === delegationId) return entry.id;
  }
  for (const entry of list) {
    if (entry.parentToolCallId === delegationId) return entry.id;
  }
  return null;
}

/** Map a bounded read's rows into the existing `SubagentRun` structure. */
export function buildSubagentRun(messages: readonly UiMessage[]): SubagentRun {
  const items: SubagentRunItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({ kind: "tool", message });
      continue;
    }
    const thinking = typeof message.thinking === "string" ? message.thinking : "";
    if (thinking.trim()) items.push({ kind: "thinking", message });
    if ((message.content || "").trim() || message.error) {
      items.push({ kind: "answer", message });
    }
  }
  return { items };
}

/** The result of one child-transcript read, typed for the panel. */
export type OmpSubagentReadResult = {
  messages: UiMessage[];
  cursor: { nextByte: number; reset: boolean };
};

/** The two api.ts surfaces the read needs (the real api methods by default). */
export type OmpSubagentReadDeps = {
  list: (sessionId: string) => Promise<OmpSubagentListRow[]>;
  read: (
    sessionId: string,
    subagentId: string,
    fromByte?: number,
  ) => Promise<{ cursor: { fromByte: number; nextByte: number; reset: boolean }; messages: UiMessage[] }>;
};

/**
 * Resolve and read one child's transcript through the OMP-only bridge.
 *
 * The caller owns staleness (it can drop a result whose request is no longer
 * current) and accumulation (it merges this read's rows into the panel set).
 * This function only does the list → resolve → read sequence and never
 * persists anything. A read that fails is reported as `kind: "error"` by the
 * caller; here the rejection propagates so the caller can distinguish a typed
 * bridge error from a resolved empty transcript.
 */
export async function fetchOmpSubagentDetail(
  deps: OmpSubagentReadDeps,
  sessionId: string,
  delegationId: string,
  fromByte?: number,
): Promise<OmpSubagentReadResult> {
  let childId: string | null = null;
  try {
    const list = await deps.list(sessionId);
    childId = resolveChildId(list, delegationId) ?? delegationId;
  } catch {
    // The list is best-effort for resolution; a live registry that cannot be
    // read still leaves the opaque id (the selection id) to try directly.
    childId = delegationId;
  }

  const result = await deps.read(sessionId, childId, fromByte);
  return {
    messages: result.messages,
    cursor: { nextByte: result.cursor.nextByte, reset: result.cursor.reset },
  };
}

/**
 * Merge an incremental read into the accumulated set, deduplicating by stable
 * message id and preserving both old rows and order. A reset response replaces
 * the set instead of merging (the caller decides from the cursor).
 */
export function mergeSubagentMessages(
  previous: readonly UiMessage[],
  next: readonly UiMessage[],
): UiMessage[] {
  const seen = new Set<string>();
  const merged: UiMessage[] = [];
  for (const message of [...previous, ...next]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}
