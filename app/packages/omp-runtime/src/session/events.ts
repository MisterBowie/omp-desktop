/**
 * The runtime's frames, translated into the desktop's own agent events.
 *
 * The desktop transcript is driven by one event vocabulary (`AgentEvent` in
 * `@pi-desktop/shared`), and every surface — chat rows, tool cards, permission
 * cards, error banners — already consumes it. This module is the only place
 * that knows how the pinned OMP runtime words the same facts, so the rest of
 * the desktop never branches on the engine.
 *
 * What the translation is allowed to be lossy about, and why:
 *
 *   - **Nothing on a mapped event is dropped.** Tool `args`, `partialResult`,
 *     `result` and details are forwarded verbatim; runtime-only fields
 *     (`intent`, `customWireName`, `tool_stream_update` payloads) ride along in
 *     `ompToolMeta` instead of being discarded or folded into `args`.
 *   - **Tool results are represented once.** The runtime emits both
 *     `tool_execution_end` and a `toolResult` message; the desktop's transcript
 *     renders a tool as one row keyed by `toolCallId`, so the message form is
 *     folded away (`toolResultMessages`) rather than duplicated.
 *   - **Usage carries only what the runtime reports.** The runtime's `Usage`
 *     has `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens` and no
 *     reasoning counter; `reasoningTokens` is therefore omitted, never zeroed.
 *   - **Unknown frames are counted, not fatal.** A newer runtime may add event
 *     kinds; `diagnostics().unmappedFrames` names them so a reviewer can see
 *     what this build does not show yet. Nothing throws on an unknown kind.
 *
 * Message identity: the runtime's messages have no id, so ids are minted here
 * (`omp:<session>:<n>`) and reused across the start/update/end of one streaming
 * message. `agent_end` reports the ids minted during the run, which is what the
 * desktop's transcript marks as complete.
 */
import type {
  AgentEvent,
  AppError,
  MessageUsage,
  UiMessage,
  UiMessageRole,
} from "@pi-desktop/shared";

/** One image part of a runtime message. */
type OmpImagePart = { type: "image"; data?: string; mimeType?: string };
type OmpTextPart = { type: "text"; text?: string };
type OmpThinkingPart = { type: "thinking"; thinking?: string };
type OmpToolCallPart = { type: "toolCall"; id?: string; name?: string };
type OmpContentPart =
  | OmpTextPart
  | OmpThinkingPart
  | OmpToolCallPart
  | OmpImagePart
  | { type: string; [key: string]: unknown };

type OmpUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type OmpMessage = {
  role?: string;
  /** Present on `role: "toolResult"` messages; folded into the tool row. */
  toolName?: string;
  toolCallId?: string;
  content?: string | OmpContentPart[];
  /** Structured host result on `role: "toolResult"` messages (bounded before it crosses the bridge). */
  details?: unknown;
  usage?: OmpUsage;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Present on `role: "toolResult"` messages; distinguishes a failed tool. */
  isError?: boolean;
  timestamp?: number;
};

type OmpAssistantMessageEvent = {
  type?: string;
  delta?: string;
  content?: unknown;
  reason?: string;
  message?: OmpMessage;
  error?: OmpMessage;
};

/** Counters for everything this build chooses not to surface yet. */
export type OmpConversionDiagnostics = {
  /** Frame types with no mapping, by frame type. */
  unmappedFrames: Record<string, number>;
  /** `toolResult` messages folded into their tool row, by tool name. */
  toolResultMessages: Record<string, number>;
  /** Message parts with no desktop representation (images, redacted thinking…). */
  droppedParts: Record<string, number>;
  /** Free-text notes for a reviewer: one line per distinct situation. */
  notes: string[];
};

export type OmpEventConverterOptions = {
  sessionId: string;
  /** Injectable clock; durations are measured, never invented. */
  now?: () => number;
  /**
   * The sequence the message-id counter starts at. A session that replaces its
   * runtime passes the retired converter's last sequence so a new reply never
   * remints an id the renderer already projected (the renderer upserts rows by
   * id, so two replies sharing `omp:<session>:1` would collapse to one).
   */
  sequenceSeed?: number;
  /**
   * A token unique to one desktop execution context (one SessionEntry). Live
   * message ids embed it, so a reply minted after the entry was removed and
   * recreated — a model change, an archive/reopen — never remints an id the
   * renderer already projected. Durable transcript ids
   * (`omp:<session>:entry:<id>`) do not embed it and stay stable across reads.
   */
  contextId?: string;
  /**
   * Attribution for a child converter: every message it mints carries the
   * parent `task` tool call and the child's agent name, so the renderer groups
   * the child's rows under its delegation node (ADR 0062).
   */
  parentToolCallId?: string;
  agentName?: string;
};

type StreamingMessage = {
  id: string;
  role: UiMessageRole;
  startedAt: number;
  toolName?: string;
  toolCallId?: string;
};

/**
 * One durable UiMessage's serialized payload fits within this UTF-8 byte
 * budget. `content`, `thinking` and `toolResult` share a single budget; the
 * fixed envelope (id, role, timestamps, tool identity, status) is measured
 * separately and subtracted first, so the whole serialized row stays at or
 * below this bound (see `newRowBudget`).
 */
const ROW_BUDGET_BYTES = 4 * 1024 * 1024;
/** Truncation marker appended to visibly truncated text (the codebase's `…` convention). */
const TRUNCATION_SUFFIX = "\u2026";
const TRUNCATION_SUFFIX_BYTES = 3;
/**
 * Bytes reserved up front for the structured-truncation marker so a result
 * that had to drop data can still say so within the same row bound. The marker
 * is `"truncated":true`; its worst structural overhead is wrapping a non-record
 * `details` as `{"truncated":true,"value":…}` (27 bytes), so 32 leaves headroom.
 */
const TRUNCATION_MARKER_RESERVE_BYTES = 32;

export class OmpEventConverter {
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly diagnostics: OmpConversionDiagnostics = {
    unmappedFrames: {},
    toolResultMessages: {},
    droppedParts: {},
    notes: [],
  };

  private sequence = 0;
  private streaming: StreamingMessage | null = null;
  private readonly messageIds: string[] = [];
  private readonly contextId: string | undefined;
  /** Set from the assistant message itself, so a finished run can be named. */
  private modelId: string | undefined;
  private readonly parentToolCallId: string | undefined;
  private readonly agentName: string | undefined;

  constructor(options: OmpEventConverterOptions) {
    this.sessionId = options.sessionId;
    this.now = options.now ?? Date.now;
    this.sequence = options.sequenceSeed ?? 0;
    this.contextId = options.contextId;
    this.parentToolCallId = options.parentToolCallId;
    this.agentName = options.agentName;
  }

  /** The run's message ids, in creation order. */
  runMessageIds(): string[] {
    return [...this.messageIds];
  }

  /** The sequence the next minted id will use; carried across runtime replacement. */
  currentSequence(): number {
    return this.sequence;
  }

  snapshot(): OmpConversionDiagnostics {
    return {
      unmappedFrames: { ...this.diagnostics.unmappedFrames },
      toolResultMessages: { ...this.diagnostics.toolResultMessages },
      droppedParts: { ...this.diagnostics.droppedParts },
      notes: [...this.diagnostics.notes],
    };
  }

  /**
   * Map one *durable-transcript entry* (`{ id, parentId, timestamp, message }`)
   * into a desktop row, or null when it is a non-message entry.
   *
   * Used by `get_subagent_messages`: the pinned runtime returns a child's
   * transcript as finished entries, not as an event stream, so the detail read
   * replays each message through the same role/content/usage mapping the live
   * path uses. The entry's own `id` gives the row a stable identity across
   * reopen and incremental reads (a fresh converter must not remint ids).
   * `toolResult` messages are mapped to tool rows — the read is the only path
   * that can recover tool steps the live stream missed.
   */
  convertEntry(entry: unknown): UiMessage | null {
    const record = asRecord(entry);
    if (!record) return null;
    const parsed = asMessage(record.message);
    if (!parsed) return null;
    const role = roleOf(parsed);
    if (!role) return null;
    const id =
      typeof record.id === "string" && record.id
        ? `omp:${this.sessionId}:entry:${record.id}`
        : this.mintId();
    if (role === "tool") return this.toToolRow(id, parsed);
    return this.toUiMessage(id, parsed, role, "complete");
  }

  /** Map a `toolResult` message into a tool row the renderer already presents. */
  private toToolRow(id: string, message: OmpMessage): UiMessage {
    const createdAt = new Date(
      typeof message.timestamp === "number" ? message.timestamp : this.now(),
    ).toISOString();
    const fixed = {
      id,
      role: "tool" as const,
      createdAt,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      toolName: message.toolName ?? "unknown",
      toolStatus: (message.isError === true ? "error" : "success") as "error" | "success",
      ...(this.parentToolCallId ? { parentToolCallId: this.parentToolCallId } : {}),
      ...(this.agentName ? { agentName: this.agentName } : {}),
      isError: message.isError === true,
      status: "complete" as const,
    };
    // Both payload keys are always present, so the envelope is measured with
    // empty placeholders and each payload charges only its bytes above them.
    const budget = newRowBudget({ ...fixed, content: "", toolResult: "" });
    if (message.details === undefined) {
      // A text-only result: the renderer reads the row's `content` field when
      // `toolResult` is empty, so the text is represented once, not twice.
      return {
        ...fixed,
        content: boundFieldText(this.contentText(message.content), budget),
        toolResult: "",
      };
    }
    // A structured result: `details` is the payload the renderer unwraps, and
    // the envelope's text blocks are kept only for the delegation-report and
    // lifecycle-summary paths. The row's `content` stays empty so the same text
    // is not serialized twice.
    return { ...fixed, content: "", toolResult: boundedToolResult(message, budget) };
  }

  /** The flattened text of a message body; bounded later by the shared budget. */
  private contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n");
  }

  /**
   * Translate one frame into zero or more desktop events. */
  convert(frame: unknown): AgentEvent[] {
    if (!isRecord(frame) || typeof frame.type !== "string") {
      this.note("a frame without a string type was ignored");
      return [];
    }
    switch (frame.type) {
      case "agent_start":
        return [{ type: "agent_start" }];

      case "agent_end": {
        // `isTerminal: false` means an async delivery will resume this session;
        // the desktop's `agent_end` is the end of the turn lifecycle, so a
        // non-terminal frame must not complete the transcript.
        if (frame.isTerminal === false) {
          this.note("a non-terminal agent_end was reported as a status, not a completion");
          return [];
        }
        return [{ type: "agent_end", messageIds: this.runMessageIds() }];
      }

      case "turn_start":
        return [{ type: "turn_start" }];

      case "turn_end": {
        const usage = usageOf(asMessage(frame.message) ?? undefined);
        return [{ type: "turn_end", ...(usage ? { subagentUsage: usage } : {}) }];
      }

      case "message_start":
        return this.onMessageStart(frame.message);

      case "message_update":
        return this.onMessageUpdate(frame);

      case "message_end":
        return this.onMessageEnd(frame.message);

      case "tool_execution_start": {
        const meta = toolMetaOf(frame, { intent: true, customWireName: true });
        return [
          {
            type: "tool_start",
            toolCallId: requireString(frame.toolCallId, "tool_execution_start.toolCallId"),
            toolName: stringOrEmpty(frame.toolName) || "unknown",
            args: frame.args,
            ...(meta ? { ompToolMeta: meta } : {}),
          },
        ];
      }

      case "tool_execution_update": {
        const meta = toolMetaOf(frame, {});
        return [
          {
            type: "tool_update",
            toolCallId: requireString(frame.toolCallId, "tool_execution_update.toolCallId"),
            partialResult: frame.partialResult,
            ...(meta ? { ompToolMeta: meta } : {}),
          },
        ];
      }

      case "tool_stream_update": {
        // Argument-stream projections (diff previews) have no Pi equivalent;
        // they are preserved as the tool's partial result plus the raw payload.
        return [
          {
            type: "tool_update",
            toolCallId: requireString(frame.toolCallId, "tool_stream_update.toolCallId"),
            ompToolMeta: { streamUpdate: frame.update },
          },
        ];
      }

      case "tool_execution_end": {
        const meta = toolMetaOf(frame, { customWireName: true });
        return [
          {
            type: "tool_end",
            toolCallId: requireString(frame.toolCallId, "tool_execution_end.toolCallId"),
            result: frame.result,
            ...(frame.isError === true ? { isError: true } : {}),
            ...(meta ? { ompToolMeta: meta } : {}),
          },
        ];
      }

      case "notice": {
        // Only an error-level notice is a user-visible failure. Informational
        // notices stay in diagnostics rather than becoming a fake chat row.
        if (frame.level === "error") {
          return [
            {
              type: "error",
              error: appError(
                "OMP_NOTICE",
                stringOrEmpty(frame.message) || "the runtime reported an error",
                frame.source === undefined ? undefined : { source: frame.source },
              ),
            },
          ];
        }
        this.note("an informational notice was counted, not shown");
        return [];
      }

      default:
        this.diagnostics.unmappedFrames[frame.type] =
          (this.diagnostics.unmappedFrames[frame.type] ?? 0) + 1;
        return [];
    }
  }

  // -------------------------------------------------------------------------

  private onMessageStart(raw: unknown): AgentEvent[] {
    const message = asMessage(raw);
    if (!message) return [];
    const role = roleOf(message);
    if (role === "tool") {
      // Folded into the tool row: see the module header.
      const toolName = stringOrEmpty(message.toolName) || "unknown";
      this.diagnostics.toolResultMessages[toolName] =
        (this.diagnostics.toolResultMessages[toolName] ?? 0) + 1;
      return [];
    }
    if (!role) {
      this.note("a message with an unrecognised role was ignored");
      return [];
    }
    const id = this.mintId();
    this.streaming = { id, role, startedAt: this.now() };
    if (role === "assistant") this.modelId = stringOr(message.model, this.modelId);
    return [{ type: "message_start", message: this.toUiMessage(id, message, role, "streaming") }];
  }

  private onMessageUpdate(frame: Record<string, unknown>): AgentEvent[] {
    const message = asMessage(frame.message);
    const update = asAssistantMessageEvent(frame.assistantMessageEvent);
    if (!message || !update) return [];
    const streaming = this.streaming;
    if (!streaming) {
      this.note("an update arrived without a started message; it was ignored");
      return [];
    }
    if (update.type === "done") {
      return this.finishAssistant(streaming.id, update.message ?? message, "complete");
    }
    if (update.type === "error") {
      const failed = update.error ?? message;
      const aborted = update.reason === "aborted";
      return [
        ...this.finishAssistant(streaming.id, failed, aborted ? "aborted" : "error"),
        ...(aborted
          ? []
          : [
              {
                type: "error" as const,
                error: appError(
                  "OMP_MODEL_ERROR",
                  failed.errorMessage ?? "the model turn failed",
                  { reason: update.reason ?? "error" },
                ),
              },
            ]),
      ];
    }
    if (update.type !== "text_delta" && update.type !== "thinking_delta") {
      // start/end/toolcall/image deltas carry no text the transcript shows:
      // the final text arrives with `done`, and tool rows come from the tool
      // events. They are counted so the choice stays visible.
      if (update.type && update.type !== "toolcall_delta") {
        this.diagnostics.unmappedFrames[`assistant:${update.type}`] =
          (this.diagnostics.unmappedFrames[`assistant:${update.type}`] ?? 0) + 1;
      }
      return [];
    }
    const delta = typeof update.delta === "string" ? update.delta : "";
    if (delta.length === 0) return [];
    const live = this.toUiMessage(streaming.id, message, "assistant", "streaming");
    return [
      {
        type: "message_update",
        message: { ...live, content: "", thinking: undefined, usage: undefined },
        ...(update.type === "text_delta" ? { deltaText: delta } : { deltaThinking: delta }),
        stream: "delta",
      },
    ];
  }

  private onMessageEnd(raw: unknown): AgentEvent[] {
    const message = asMessage(raw);
    if (!message) return [];
    const role = roleOf(message);
    if (role === "tool") {
      const toolName = stringOrEmpty(message.toolName) || "unknown";
      this.diagnostics.toolResultMessages[toolName] =
        (this.diagnostics.toolResultMessages[toolName] ?? 0) + 1;
      return [];
    }
    if (!role) {
      this.note("a message with an unrecognised role was ignored");
      return [];
    }
    if (role === "assistant") {
      const id = this.streaming?.role === "assistant" ? this.streaming.id : this.mintId();
      this.streaming = null;
      return this.finishAssistant(id, message, "complete");
    }
    const id = this.streaming?.role === role ? this.streaming.id : this.mintId();
    this.streaming = null;
    return [{ type: "message_end", message: this.toUiMessage(id, message, role, "complete") }];
  }

  /** The desktop's completion for an assistant message, with its usage. */
  private finishAssistant(
    id: string,
    message: OmpMessage,
    status: "complete" | "error" | "aborted",
  ): AgentEvent[] {
    const streaming = this.streaming;
    const ui = this.toUiMessage(id, message, "assistant", status);
    const durationMs =
      streaming && streaming.id === id
        ? Math.max(0, this.now() - streaming.startedAt)
        : undefined;
    if (status === "error") ui.error = appError("OMP_MODEL_ERROR", message.errorMessage ?? "the model turn failed");
    return [
      {
        type: "message_end",
        message: {
          ...ui,
          // A stopped stream still has a measured duration: the desktop uses it
          // for throughput when the provider reported no final usage.
          ...(durationMs !== undefined ? { responseDurationMs: durationMs } : {}),
          ...(durationMs !== undefined ? { responseOutputTokens: ui.usage?.outputTokens } : {}),
        },
      },
    ];
  }

  private toUiMessage(
    id: string,
    message: OmpMessage,
    role: UiMessageRole,
    status: UiMessage["status"],
  ): UiMessage {
    const { content, thinking } = splitContent(message.content);
    const usage = usageOf(message);
    const modelId = stringOr(message.model, undefined);
    const providerId = stringOr(message.provider, undefined);
    const fixed = {
      id,
      role,
      createdAt: new Date(
        typeof message.timestamp === "number" ? message.timestamp : this.now(),
      ).toISOString(),
      status,
      ...(role === "assistant" && modelId ? { modelId } : {}),
      ...(role === "assistant" && providerId ? { providerId } : {}),
      ...(this.parentToolCallId ? { parentToolCallId: this.parentToolCallId } : {}),
      ...(this.agentName ? { agentName: this.agentName } : {}),
      ...(usage ? { usage } : {}),
    };
    const skeleton = {
      ...fixed,
      content: "",
      ...(thinking ? { thinking: "" } : {}),
    };
    const budget = newRowBudget(skeleton);
    // Allocation priority: the final answer (`content`) is the only part a
    // reader must never lose, so it is charged first; reasoning (`thinking`)
    // takes whatever remains. A huge reasoning block can therefore never erase
    // a short answer, while an ordinary reasoning+answer pair still fits in
    // full when their combined size is under the bound.
    const boundedContent = boundFieldText(content, budget);
    const boundedThinking = thinking ? boundFieldText(thinking, budget) : "";
    return {
      ...fixed,
      content: boundedContent,
      ...(boundedThinking ? { thinking: boundedThinking } : {}),
    };
  }

  private mintId(): string {
    this.sequence += 1;
    const id = this.contextId
      ? `omp:${this.sessionId}:${this.contextId}:${this.sequence}`
      : `omp:${this.sessionId}:${this.sequence}`;
    this.messageIds.push(id);
    return id;
  }

  private note(text: string): void {
    if (!this.diagnostics.notes.includes(text)) this.diagnostics.notes.push(text);
  }
}

/** Flatten a runtime message body into text plus reasoning. */
function splitContent(content: unknown): { content: string; thinking?: string } {
  if (typeof content === "string") return { content };
  if (!Array.isArray(content)) return { content: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      thinking.push(part.thinking);
    }
    // toolCall parts belong to their tool row; image and provider-specific
    // parts have no desktop row in M3 and are counted by the caller.
  }
  const joined = text.join("\n");
  const reasoning = thinking.join("\n");
  return { content: joined, ...(reasoning ? { thinking: reasoning } : {}) };
}

// ---------------------------------------------------------------------------
// Shared serialized-UTF-8 budget.
//
// The pinned runtime persists each tool result as `{ content: blocks, details }`
// and each assistant message as `{ content: blocks (text + thinking) }`. Every
// one of those payload fields, plus the JSON syntax that carries them (keys,
// quotes, separators, escaping, multibyte code points), must fit in one
// 4 MiB serialized UTF-8 budget per durable row. `.length` counts UTF-16 code
// units, so byte accounting here measures the JSON-escaped UTF-8 form instead.
// ---------------------------------------------------------------------------

/**
 * One row's remaining serialized bytes plus whether anything was dropped while
 * spending them. `truncated` is set by `boundString` (a `…` suffix), by the
 * array/object loops in `boundValue` (items or keys that could not fit), and by
 * `boundedToolResult` (a whole field that could not fit), so a caller can tell
 * the presenter the result is incomplete without inventing original counts.
 */
type ByteBudget = { remaining: number; truncated: boolean };

/** Sentinel: the value cannot fit at all (not even its empty form). */
const NO_SPACE: unique symbol = Symbol("no-space");

/**
 * JSON-serialized byte length of one code point, *excluding* the surrounding
 * string quotes. Matches `JSON.stringify`: `"` and `\` escape to two bytes, the
 * five named controls to two bytes, other C0 controls to `\u00XX` (six bytes),
 * lone surrogates to `\uXXXX` (six bytes), and everything else keeps its raw
 * UTF-8 width.
 */
function escapedCharBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2; // " -> \" , \ -> \\
  if (
    codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a ||
    codePoint === 0x0c || codePoint === 0x0d
  ) {
    return 2; // \b \t \n \f \r
  }
  if (codePoint < 0x20) return 6; // other C0 controls -> \u00XX
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6; // lone surrogate -> \uXXXX
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Content bytes of `text` once JSON-serialized (escapes counted, quotes excluded). */
function escapedStringBytes(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += escapedCharBytes(char.codePointAt(0)!);
  return bytes;
}

/** Serialized bytes of a JSON scalar: number (or its `null` form), boolean, null. */
function scalarBytes(value: number | boolean | null): number {
  if (value === null) return 4;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value).length : 4;
  }
  return value ? 4 : 5;
}

/**
 * A row budget for one durable message: the shared 4 MiB minus the measured
 * fixed envelope. `skeleton` holds every non-payload field plus an empty
 * placeholder for each payload field, so all keys and structural syntax are
 * charged once and each payload then charges only its bytes above the
 * placeholder (the two quote bytes for `""`, nothing more).
 */
function newRowBudget(skeleton: Record<string, unknown>): ByteBudget {
  return {
    remaining: ROW_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(skeleton), "utf8"),
    truncated: false,
  };
}

/**
 * Bound one string to the shared budget. `quoteOverhead` is the two bytes a
 * JSON string's quotes cost: 0 for a top-level field whose placeholder quotes
 * the skeleton already charged, 2 for a string nested inside another value.
 * Returns `NO_SPACE` when not even the empty string plus its overhead fits.
 * Truncation walks code points, so a surrogate pair is never split, and appends
 * the truncation marker.
 */
function boundString(
  text: string,
  budget: ByteBudget,
  quoteOverhead: number,
): string | typeof NO_SPACE {
  const contentBytes = escapedStringBytes(text);
  if (quoteOverhead + contentBytes <= budget.remaining) {
    budget.remaining -= quoteOverhead + contentBytes;
    return text;
  }
  const limit = budget.remaining - quoteOverhead - TRUNCATION_SUFFIX_BYTES;
  if (limit <= 0) return NO_SPACE;
  let used = 0;
  let end = 0;
  for (const char of text) {
    const bytes = escapedCharBytes(char.codePointAt(0)!);
    if (used + bytes > limit) break;
    used += bytes;
    end += char.length;
  }
  budget.remaining -= quoteOverhead + used + TRUNCATION_SUFFIX_BYTES;
  budget.truncated = true;
  return text.slice(0, end) + TRUNCATION_SUFFIX;
}

/** Bound a top-level string field; an unrepresentable value becomes "". */
function boundFieldText(text: string, budget: ByteBudget): string {
  const bounded = boundString(text, budget, 0);
  return bounded === NO_SPACE ? "" : bounded;
}

/**
 * Recursively bound a structured value to the shared budget, charging exactly
 * the bytes its serialized form will occupy — string content with escapes and
 * quotes, keys, array brackets, object braces, commas, colons, and every scalar.
 * Shape is preserved for whatever fits; a value that cannot fit at all yields
 * `NO_SPACE` so the enclosing container drops it rather than serializing junk.
 */
function boundValue(value: unknown, budget: ByteBudget): unknown {
  if (budget.remaining <= 0) return NO_SPACE;
  if (typeof value === "string") return boundString(value, budget, 2);
  if (typeof value === "number" || typeof value === "boolean") {
    const bytes = scalarBytes(value);
    if (bytes > budget.remaining) return NO_SPACE;
    budget.remaining -= bytes;
    return value;
  }
  if (value === null) {
    if (budget.remaining < 4) return NO_SPACE;
    budget.remaining -= 4;
    return null;
  }
  if (Array.isArray(value)) {
    if (budget.remaining < 2) return NO_SPACE;
    budget.remaining -= 2; // [ ]
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (index > 0) {
        if (budget.remaining < 1) {
          budget.truncated = true;
          break;
        }
        budget.remaining -= 1; // ,
      }
      const item = boundValue(value[index], budget);
      if (item === NO_SPACE) {
        if (index > 0) budget.remaining += 1; // refund the comma
        budget.truncated = true;
        break;
      }
      out.push(item);
    }
    return out;
  }
  if (isRecord(value)) {
    if (budget.remaining < 2) return NO_SPACE;
    budget.remaining -= 2; // { }
    const out: Record<string, unknown> = {};
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      const keyBytes = 2 + escapedStringBytes(key) + 1; // "key":
      const separatorBytes = first ? 0 : 1;
      if (budget.remaining < separatorBytes + keyBytes) {
        budget.truncated = true;
        break;
      }
      budget.remaining -= separatorBytes + keyBytes;
      const bounded = boundValue(item, budget);
      if (bounded === NO_SPACE) {
        budget.remaining += separatorBytes + keyBytes; // refund
        budget.truncated = true;
        break;
      }
      out[key] = bounded;
      first = false;
    }
    return out;
  }
  // undefined / functions / symbols are not JSON data and never occur in the
  // pinned runtime's parsed payloads; serialize to nothing.
  return undefined;
}

/** Text-only blocks of the runtime content, unbounded (bounded via `boundValue`). */
function textBlocksOf(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: "text"; text: string }> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return blocks;
}

/**
 * Attach the presenter's truncation flag to a bounded tool-result envelope.
 * `details` is the field `toolResultPayload` prefers, so a record details gets
 * the `truncated` key directly; a non-record details (array/scalar) has nowhere
 * to carry a key and is wrapped as `{ truncated: true, value }`; a details that
 * could not fit at all was dropped, so the envelope itself carries the flag.
 */
function withTruncationMarker(bounded: unknown): unknown {
  if (!isRecord(bounded)) return bounded;
  const details = bounded.details;
  if (isRecord(details) && !Array.isArray(details)) {
    return { ...bounded, details: { ...details, truncated: true } };
  }
  if (details !== undefined) {
    return { ...bounded, details: { truncated: true, value: details } };
  }
  return { ...bounded, truncated: true };
}

/**
 * A bounded, structured projection of a durable tool result, charged against
 * the same budget as the row's other payload fields.
 *
 * The renderer reads `details` for tool-specific presentation and the envelope
 * text blocks for the delegation report and lifecycle summary; images and
 * provider-only parts have no desktop row and are dropped. The row's `content`
 * is left empty by the caller for structured results, so the text is carried
 * once, not twice. The two quote bytes of the `""` placeholder are handed back
 * so the assembled envelope's full serialized form can be charged, and the net
 * delta is what the shared budget pays.
 *
 * When the bound drops anything (a long string, an array item, an object key,
 * or a whole field), the result also carries the presenter's `truncated` flag,
 * reserved from the same budget first so a truncated row still renders its own
 * indication without exceeding the bound.
 */
function boundedToolResult(message: OmpMessage, budget: ByteBudget): unknown {
  const blocks = textBlocksOf(message.content);
  const envelope =
    blocks.length > 0
      ? { content: blocks, details: message.details }
      : { details: message.details };
  const subBudget: ByteBudget = { remaining: budget.remaining + 2, truncated: false };
  // Reserve the marker up front; spend it only when something was dropped.
  const reserved = Math.min(TRUNCATION_MARKER_RESERVE_BYTES, subBudget.remaining);
  subBudget.remaining -= reserved;
  const bounded = boundValue(envelope, subBudget);
  if (bounded === NO_SPACE) {
    budget.remaining = subBudget.remaining + reserved;
    return "";
  }
  if (!subBudget.truncated) {
    budget.remaining = subBudget.remaining + reserved;
    return bounded;
  }
  const marked = withTruncationMarker(bounded);
  // The marker costs at most the reserved bytes; refund the unused remainder
  // so the whole row's serialized form stays within the bound.
  const delta =
    Buffer.byteLength(JSON.stringify(marked), "utf8") -
    Buffer.byteLength(JSON.stringify(bounded), "utf8");
  budget.remaining = subBudget.remaining + reserved - delta;
  return marked;
}

/** Only the usage fields the pinned runtime actually reports. */
function usageOf(message: OmpMessage | undefined): MessageUsage | undefined {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const input = numberOr(usage.input, 0);
  const output = numberOr(usage.output, 0);
  const cacheRead = numberOr(usage.cacheRead, 0);
  const cacheWrite = numberOr(usage.cacheWrite, 0);
  const total = numberOr(usage.totalTokens, input + output + cacheRead + cacheWrite);
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof usage.cacheRead === "number" ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(typeof usage.cacheWrite === "number" ? { cacheWriteTokens: usage.cacheWrite } : {}),
    totalTokens: total,
  };
}

function toolMetaOf(
  frame: Record<string, unknown>,
  keys: { intent?: boolean; customWireName?: boolean },
): { intent?: string; customWireName?: string } | undefined {
  const meta: { intent?: string; customWireName?: string } = {};
  if (keys.intent && typeof frame.intent === "string") meta.intent = frame.intent;
  if (keys.customWireName && typeof frame.customWireName === "string") {
    meta.customWireName = frame.customWireName;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function roleOf(message: OmpMessage): UiMessageRole | null {
  switch (message.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    case "system":
      return "system";
    default:
      return null;
  }
}

export function appError(code: string, message: string, details?: unknown): AppError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function asMessage(value: unknown): OmpMessage | null {
  return isRecord(value) ? (value as OmpMessage) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (value as Record<string, unknown>) : null;
}

function asAssistantMessageEvent(value: unknown): OmpAssistantMessageEvent | null {
  return isRecord(value) ? (value as OmpAssistantMessageEvent) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Same, but a caller that needs a definite string supplies one. */
function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A frame this build cannot route is a protocol problem, not a silent skip:
 * the caller needs a toolCallId to key the row, and inventing one would attach
 * the tool's result to the wrong transcript row.
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OMP frame is missing ${field}`);
  }
  return value;
}
