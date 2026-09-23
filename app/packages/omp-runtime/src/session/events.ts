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

const ASSISTANT_TEXT_LIMIT = 4 * 1024 * 1024;

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
  /** Set from the assistant message itself, so a finished run can be named. */
  private modelId: string | undefined;
  private readonly parentToolCallId: string | undefined;
  private readonly agentName: string | undefined;

  constructor(options: OmpEventConverterOptions) {
    this.sessionId = options.sessionId;
    this.now = options.now ?? Date.now;
    this.parentToolCallId = options.parentToolCallId;
    this.agentName = options.agentName;
  }

  /** The run's message ids, in creation order. */
  runMessageIds(): string[] {
    return [...this.messageIds];
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
    const content = this.contentText(message.content);
    return {
      id,
      role: "tool",
      content,
      createdAt: new Date(
        typeof message.timestamp === "number" ? message.timestamp : this.now(),
      ).toISOString(),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      toolName: message.toolName ?? "unknown",
      toolStatus: message.isError === true ? "error" : "success",
      toolResult: boundedToolResult(message),
      ...(this.parentToolCallId ? { parentToolCallId: this.parentToolCallId } : {}),
      ...(this.agentName ? { agentName: this.agentName } : {}),
      isError: message.isError === true,
      status: "complete",
    };
  }

  /** The flattened text of a message body, bounded for the read projection. */
  private contentText(content: unknown): string {
    if (typeof content === "string") return content.slice(0, ASSISTANT_TEXT_LIMIT);
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n").slice(0, ASSISTANT_TEXT_LIMIT);
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
    return {
      id,
      role,
      content,
      ...(thinking ? { thinking } : {}),
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
  }

  private mintId(): string {
    this.sequence += 1;
    const id = `omp:${this.sessionId}:${this.sequence}`;
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
  const joined = text.join("\n").slice(0, ASSISTANT_TEXT_LIMIT);
  const reasoning = thinking.join("\n").slice(0, ASSISTANT_TEXT_LIMIT);
  return { content: joined, ...(reasoning ? { thinking: reasoning } : {}) };
}

/**
 * A bounded, structured projection of a durable tool result.
 *
 * The pinned runtime persists tool results as `{ content: blocks, details }`;
 * the renderer reads `details` for tool-specific presentation and the display
 * text from the row's `content`. A raw `message.content` alias would carry the
 * full bytes across the bridge. Text-only results therefore project to an
 * empty result (the renderer reads the already-bounded `content` field), while
 * results with structured details keep the bounded `{ content, details }`
 * envelope the renderer already unwraps. Images and provider-only parts have no
 * desktop row and are dropped.
 */
function boundedToolResult(message: OmpMessage): unknown {
  const details =
    message.details === undefined
      ? undefined
      : boundValue(message.details, ASSISTANT_TEXT_LIMIT, { remaining: ASSISTANT_TEXT_LIMIT });
  if (details === undefined) {
    return "";
  }
  const blocks = boundedTextBlocks(message.content, ASSISTANT_TEXT_LIMIT);
  return blocks.length > 0 ? { content: blocks, details } : { details };
}

/** Text-only blocks of the runtime content, bounded to `limit` bytes total. */
function boundedTextBlocks(
  content: unknown,
  limit: number,
): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content.slice(0, limit) }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: "text"; text: string }> = [];
  let total = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const remaining = limit - total;
    if (remaining <= 0) break;
    const text = part.text.slice(0, remaining);
    blocks.push({ type: "text", text });
    total += text.length;
  }
  return blocks;
}

/**
 * Recursively bound a structured `details` value: strings are truncated and the
 * total string bytes are capped, preserving object/array shape for the renderer
 * while keeping the serialized size within the product bound.
 */
function boundValue(
  value: unknown,
  limit: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return undefined;
  if (typeof value === "string") {
    const slice = value.slice(0, Math.min(limit, budget.remaining));
    budget.remaining -= slice.length;
    return slice;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) break;
      out.push(boundValue(item, limit, budget));
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (budget.remaining <= 0) break;
      out[key] = boundValue(item, limit, budget);
    }
    return out;
  }
  return value;
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
