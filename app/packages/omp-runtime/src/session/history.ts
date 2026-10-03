/**
 * Read-only projection of a native OMP transcript into desktop rows.
 *
 * `get_entries` returns the pinned runtime's canonical append-history (every
 * branch, in append order) plus the active `leafId`. The desktop's transcript
 * shows *one* branch — the active one — exactly the way PI's native reader
 * walks a session manager from its leaf to the root. This module performs that
 * walk with the structural subset the pinned runtime's own docs bless for
 * permissive clients (`id`/`parentId` plus message entries), and projects the
 * message entries through the same {@link OmpEventConverter} the live stream
 * uses, so a durable row and its live twin describe the same message.
 *
 * What this module does *not* do: it never writes, never prompts, never
 * executes a tool and never creates a session. It is a pure function over one
 * `get_entries` response, so a caller cannot accidentally turn a history read
 * into a runtime side effect.
 *
 * Identity rules:
 *
 *   - A row's id is `omp:<sessionId>:entry:<entryId>` — the entry's own id, so
 *     two reads of the same transcript return the same ids.
 *   - A tool row uses its `toolCallId` as the row id (the renderer keys live
 *     tool rows that way, so a durable tool row replaces its live twin instead
 *     of duplicating it) when that id is unique across the projected branch;
 *     otherwise it falls back to the entry id.
 *   - Malformed input fails closed: a missing id, a duplicated id, an unknown
 *     parent, a cycle, or a leaf that is not in the entry list throws
 *     {@link OmpHistoryError} instead of returning a partial transcript. An
 *     empty history (no entries, no leaf) is the only legitimate empty result.
 */
import type { UiMessage } from "@pi-desktop/shared";

import { OmpEventConverter } from "./events.js";

/** The error code every malformed-transcript refusal carries. */
export const OMP_HISTORY_INVALID = "OMP_HISTORY_INVALID";

/** A malformed or inconsistent transcript read; never returned as an empty page. */
export class OmpHistoryError extends Error {
  readonly code = OMP_HISTORY_INVALID;
  constructor(message: string) {
    super(message);
    this.name = "OmpHistoryError";
  }
}

export type OmpHistoryWindow = {
  /** Zero-based offset of the first returned row within the branch. */
  messageStart: number;
  /** Exclusive end offset of the returned window within the branch. */
  messageEnd: number;
  /** Total rows on the active branch. */
  messageCount: number;
  hasMoreBefore: boolean;
  /** Only meaningful for an `messageAround` read, mirroring PI's detail(). */
  hasMoreAfter: boolean;
};

export type OmpHistoryProjection = OmpHistoryWindow & {
  messages: UiMessage[];
  /** Entry ids of the branch's message entries, in branch order (all rows). */
  entryIds: string[];
};

export type OmpHistoryOptions = {
  sessionId: string;
  messageLimit?: number;
  messageBefore?: number;
  messageAround?: string;
  contentLimit?: number;
};

const DEFAULT_MESSAGE_LIMIT = 100;
/**
 * Bound on one projected page. The renderer's own reads stay in its requested
 * range; a tail read that supersedes live rows widens the window to cover them
 * (see the bridge's `LIVE_ROW_WINDOW_SLACK`), which is why the bound is higher
 * than the native reader's 500-message page.
 */
const MAX_MESSAGE_LIMIT = 1000;

type EntryRecord = {
  id: string;
  parentId: string | null;
  type: string;
  [key: string]: unknown;
};

/**
 * Walk one `get_entries` response into the active branch's rows with the
 * window PI's native `detail()` applies (same defaults, same bounds).
 */
export function projectOmpHistory(
  entries: unknown,
  leafId: unknown,
  options: OmpHistoryOptions,
): OmpHistoryProjection {
  const parsed = parseEntries(entries);
  const leaf = typeof leafId === "string" && leafId.length > 0 ? leafId : null;
  const branch = activeBranch(parsed, leaf);

  const converter = new OmpEventConverter({ sessionId: options.sessionId });
  const all: UiMessage[] = [];
  const entryIds: string[] = [];
  const toolCallIds = new Map<string, number>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const toolCallId = toolCallIdOf(entry);
    if (toolCallId) toolCallIds.set(toolCallId, (toolCallIds.get(toolCallId) ?? 0) + 1);
  }
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const toolCallId = toolCallIdOf(entry);
    const projected = converter.convertEntry(entry, {
      // A durable tool row must answer to the same identity as the live tool
      // row (toolCallId); a duplicated toolCallId would collapse two rows, so
      // the entry id is used whenever the branch is not unambiguous.
      toolRowId: toolCallId && toolCallIds.get(toolCallId) === 1 ? "toolCall" : "entry",
    });
    if (!projected) continue;
    all.push(projected);
    entryIds.push(entry.id);
  }

  const limit = Math.max(
    1,
    Math.min(
      Number.isFinite(options.messageLimit) && (options.messageLimit ?? 0) > 0
        ? Math.floor(options.messageLimit as number)
        : DEFAULT_MESSAGE_LIMIT,
      MAX_MESSAGE_LIMIT,
    ),
  );
  const around = typeof options.messageAround === "string" ? options.messageAround.trim() : "";
  const aroundIndex = around ? all.findIndex((message) => message.id === around) : -1;
  const messageBefore =
    Number.isInteger(options.messageBefore) && (options.messageBefore ?? -1) >= 0
      ? Math.min(options.messageBefore as number, all.length)
      : all.length;
  const start =
    aroundIndex >= 0
      ? Math.max(0, aroundIndex - Math.floor(limit / 2))
      : Math.max(0, messageBefore - limit);
  const end = aroundIndex >= 0 ? Math.min(all.length, start + limit) : messageBefore;
  const contentLimit =
    Number.isInteger(options.contentLimit) && (options.contentLimit ?? 0) > 0
      ? Math.floor(options.contentLimit as number)
      : undefined;
  const messages = all.slice(start, end).map((message) =>
    contentLimit !== undefined && message.id !== around
      ? { ...message, content: message.content.slice(0, contentLimit) }
      : message,
  );
  return {
    messages,
    entryIds,
    messageStart: start,
    messageEnd: end,
    messageCount: all.length,
    hasMoreBefore: start > 0,
    hasMoreAfter: aroundIndex >= 0 ? end < all.length : false,
  };
}

/** Parse and validate the `get_entries` payload; a malformed list fails closed. */
function parseEntries(entries: unknown): EntryRecord[] {
  if (!Array.isArray(entries)) {
    throw new OmpHistoryError("the runtime returned no entry list for this session");
  }
  const parsed: EntryRecord[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) {
      throw new OmpHistoryError("the runtime returned a non-object transcript entry");
    }
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const type = typeof record.type === "string" ? record.type : "";
    const parentId =
      typeof record.parentId === "string"
        ? record.parentId
        : record.parentId === null || record.parentId === undefined
          ? null
          : "";
    if (!id || !type || parentId === "") {
      throw new OmpHistoryError("a transcript entry is missing its id, type or parentId");
    }
    if (seen.has(id)) {
      throw new OmpHistoryError(`the transcript contains two entries with the id ${id}`);
    }
    seen.add(id);
    parsed.push({ ...record, id, type, parentId });
  }
  return parsed;
}

/**
 * The active branch, root first. The pinned runtime reports the branch tip as
 * `leafId`; a chain break (an unknown parent) or a cycle is a corrupted
 * transcript and fails closed rather than being silently truncated.
 */
function activeBranch(entries: EntryRecord[], leafId: string | null): EntryRecord[] {
  if (entries.length === 0) {
    if (leafId !== null) {
      throw new OmpHistoryError(`the transcript names a leaf (${leafId}) but has no entries`);
    }
    return [];
  }
  const leaf = leafId ?? entries[entries.length - 1]!.id;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (!byId.has(leaf)) {
    throw new OmpHistoryError(`the transcript's leaf ${leaf} is not one of its entries`);
  }
  const chain: EntryRecord[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leaf;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      throw new OmpHistoryError(`the transcript's parent chain loops at ${cursor}`);
    }
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) {
      throw new OmpHistoryError(`a transcript entry's parent ${cursor} is missing`);
    }
    chain.push(entry);
    cursor = entry.parentId;
  }
  return chain.reverse();
}

/** The `toolCallId` of a `toolResult` message entry, when it carries one. */
function toolCallIdOf(entry: EntryRecord): string | null {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return null;
  const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : null;
}
