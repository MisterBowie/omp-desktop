/**
 * Strict validation for the pinned runtime's subagent frames and RPC payloads.
 *
 * The pinned OMP runtime (18.2.7) reports subagents through three event
 * families on stdout — `subagent_lifecycle`, `subagent_progress`,
 * `subagent_event` — and answers two read commands: `get_subagents` (a live
 * snapshot of *active* children) and `get_subagent_messages` (a byte-cursor
 * read of one child's durable transcript). This module is the only place that
 * decides what counts as a valid child fact.
 *
 * Why validation must be strict, not a cast:
 *
 *   - A subagent frame that is missing its child identity, its owning parent
 *     tool call, or a sane status is *ownership-ambiguous*. Accepting it as a
 *     parent event would attribute a child's work to the parent session (or a
 *     stopped run), which is exactly the cross-run contamination the desktop's
 *     generation model exists to prevent.
 *   - The `sessionFile` on every snapshot is an absolute native path. It must
 *     never reach the renderer; validating it here (a string, not an object, a
 *     path, not a blob) is part of the boundary, and the caller still strips it
 *     before crossing into the UI.
 *   - A `subagent_event` payload carries only `{ id, event }`; its parent tool
 *     call and agent name come from the lifecycle/progress registry. A child
 *     event whose `id` is not known to that registry is refused here rather than
 *     guessed into a parent envelope.
 *
 * The wire shapes below are ported from the fixed source
 * (`packages/coding-agent/src/modes/rpc/rpc-types.ts`,
 * `packages/tui/src/tools/task.ts`,
 * `packages/tui/src/overlays/session-observer-registry.ts`) so the desktop
 * exercises the real contract without importing the agent runtime.
 */
import Type from "typebox";
import * as Value from "typebox/value";

export const SUBAGENT_LIFECYCLE_STATUSES = [
  "started",
  "completed",
  "failed",
  "aborted",
] as const;
export type SubagentLifecycleStatus = (typeof SUBAGENT_LIFECYCLE_STATUSES)[number];

export const SUBAGENT_PROGRESS_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
] as const;
export type SubagentProgressStatus = (typeof SUBAGENT_PROGRESS_STATUSES)[number];

export const SUBAGENT_AGENT_SOURCES = ["bundled", "user", "project"] as const;
export type SubagentAgentSource = (typeof SUBAGENT_AGENT_SOURCES)[number];

const NonEmptyString = Type.String({ minLength: 1 });
const OptionalNonEmptyString = Type.Optional(NonEmptyString);
const OptionalBoolean = Type.Optional(Type.Boolean());
const Integer = Type.Integer();
const AgentSource = Type.Union([
  Type.Literal("bundled"),
  Type.Literal("user"),
  Type.Literal("project"),
]);

/** `AgentProgress` as the pinned runtime reports it (subset this build reads). */
const AgentProgressSchema = Type.Object(
  {
    index: Integer,
    id: NonEmptyString,
    agent: NonEmptyString,
    agentSource: AgentSource,
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
    ]),
    task: Type.String(),
  },
  { additionalProperties: true },
);

/** `SubagentLifecyclePayload` from `session-observer-registry.ts`. */
export const SubagentLifecyclePayloadSchema = Type.Object(
  {
    id: NonEmptyString,
    agent: NonEmptyString,
    agentSource: AgentSource,
    description: OptionalNonEmptyString,
    status: Type.Union([
      Type.Literal("started"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
    ]),
    sessionFile: OptionalNonEmptyString,
    parentToolCallId: OptionalNonEmptyString,
    index: Integer,
    detached: OptionalBoolean,
  },
  { additionalProperties: true },
);

/** `SubagentProgressPayload` from `session-observer-registry.ts`. */
export const SubagentProgressPayloadSchema = Type.Object(
  {
    index: Integer,
    agent: NonEmptyString,
    agentSource: AgentSource,
    task: Type.String(),
    parentToolCallId: OptionalNonEmptyString,
    assignment: Type.Optional(Type.String()),
    progress: AgentProgressSchema,
    sessionFile: OptionalNonEmptyString,
    detached: OptionalBoolean,
  },
  { additionalProperties: true },
);

/** `SubagentEventPayload` from `task/types.ts`: `{ id, event: AgentSessionEvent }`. */
export const SubagentEventPayloadSchema = Type.Object(
  {
    id: NonEmptyString,
    event: Type.Object({ type: NonEmptyString }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

/** `RpcSubagentSnapshot` from `rpc-types.ts` (a `get_subagents` row). */
export const RpcSubagentSnapshotSchema = Type.Object(
  {
    id: NonEmptyString,
    index: Integer,
    agent: NonEmptyString,
    agentSource: AgentSource,
    description: Type.Optional(Type.String()),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
    ]),
    task: Type.Optional(Type.String()),
    assignment: Type.Optional(Type.String()),
    sessionFile: OptionalNonEmptyString,
    lastUpdate: Type.Integer(),
    progress: Type.Optional(AgentProgressSchema),
    parentToolCallId: OptionalNonEmptyString,
  },
  { additionalProperties: true },
);

/** `RpcSubagentMessagesResult` from `rpc-types.ts`. */
export const RpcSubagentMessagesResultSchema = Type.Object(
  {
    sessionFile: NonEmptyString,
    fromByte: Type.Integer({ minimum: 0 }),
    nextByte: Type.Integer({ minimum: 0 }),
    reset: Type.Boolean(),
    entries: Type.Array(Type.Unknown()),
    messages: Type.Array(Type.Unknown()),
  },
  { additionalProperties: true },
);

export type SubagentLifecyclePayload = Type.Static<typeof SubagentLifecyclePayloadSchema>;
export type SubagentProgressPayload = Type.Static<typeof SubagentProgressPayloadSchema>;
export type SubagentEventPayload = Type.Static<typeof SubagentEventPayloadSchema>;
export type SubagentSnapshot = Type.Static<typeof RpcSubagentSnapshotSchema>;
export type SubagentMessagesResult = Type.Static<typeof RpcSubagentMessagesResultSchema>;

export type SubagentLifecycleFrame = { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload };
export type SubagentProgressFrame = { type: "subagent_progress"; payload: SubagentProgressPayload };
export type SubagentEventFrame = { type: "subagent_event"; payload: SubagentEventPayload };
export type SubagentFrame = SubagentLifecycleFrame | SubagentProgressFrame | SubagentEventFrame;

/**
 * Classify a raw frame as one of the three subagent families.
 *
 * Returns `null` for any frame that is not a subagent frame (including a frame
 * whose `type` claims to be one but whose payload is not an object) so the
 * caller routes it normally. A frame that *claims* the type but fails schema
 * validation is distinguished from "not a subagent frame" by the parse helpers
 * below, which return `null` for a malformed claim.
 */
export function subagentFrameKind(value: unknown): SubagentFrame["type"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  if (type === "subagent_lifecycle") return "subagent_lifecycle";
  if (type === "subagent_progress") return "subagent_progress";
  if (type === "subagent_event") return "subagent_event";
  return null;
}

/**
 * Parse a `subagent_lifecycle` frame.
 *
 * Returns the typed payload, or `null` when the frame is not a well-formed
 * lifecycle frame. A frame that names this type but fails validation is
 * *malformed*, so the caller must count it (not silently skip it, and never
 * forward it as a parent event).
 */
export function parseSubagentLifecycleFrame(value: unknown): SubagentLifecycleFrame | null {
  if (subagentFrameKind(value) !== "subagent_lifecycle") return null;
  if (!Value.Check(SubagentLifecyclePayloadSchema, (value as { payload?: unknown }).payload)) {
    return null;
  }
  return value as SubagentLifecycleFrame;
}

/** Parse a `subagent_progress` frame; null when malformed. */
export function parseSubagentProgressFrame(value: unknown): SubagentProgressFrame | null {
  if (subagentFrameKind(value) !== "subagent_progress") return null;
  if (!Value.Check(SubagentProgressPayloadSchema, (value as { payload?: unknown }).payload)) {
    return null;
  }
  return value as SubagentProgressFrame;
}

/** Parse a `subagent_event` frame; null when malformed. */
export function parseSubagentEventFrame(value: unknown): SubagentEventFrame | null {
  if (subagentFrameKind(value) !== "subagent_event") return null;
  if (!Value.Check(SubagentEventPayloadSchema, (value as { payload?: unknown }).payload)) {
    return null;
  }
  return value as SubagentEventFrame;
}

/**
 * Validate a `get_subagents` response `data` payload.
 *
 * The pinned response is `{ subagents: RpcSubagentSnapshot[] }`. A malformed
 * row (missing identity or status) invalidates the whole result rather than
 * being silently dropped: the caller reconciles against *this* snapshot, and a
 * partial reconciliation would keep a stale child that the runtime has already
 * dropped.
 */
export function parseSubagentSnapshots(data: unknown): SubagentSnapshot[] | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const subagents = (data as { subagents?: unknown }).subagents;
  if (!Array.isArray(subagents)) return null;
  const parsed: SubagentSnapshot[] = [];
  for (const row of subagents) {
    if (!Value.Check(RpcSubagentSnapshotSchema, row)) return null;
    parsed.push(row as SubagentSnapshot);
  }
  return parsed;
}

/**
 * Validate a `get_subagent_messages` response `data` payload.
 *
 * The `sessionFile` field is validated as a non-empty string but is *not*
 * returned to the caller that crosses into the renderer: the bridge strips it
 * and hands back only the cursor plus messages. It is exposed here so the
 * main-process side can log it without letting it leave.
 */
export function parseSubagentMessages(data: unknown): SubagentMessagesResult | null {
  if (!Value.Check(RpcSubagentMessagesResultSchema, data)) return null;
  return data as SubagentMessagesResult;
}

/**
 * Product bounds for one child-transcript read. The pinned runtime reads its
 * session file to EOF (a real upstream limitation this build cannot prevent
 * inside the child runtime), so the desktop must bound what crosses the bridge
 * and is retained here. A read that exceeds a bound is rejected with a typed
 * error, never silently truncated: truncating would skip messages and corrupt
 * the byte cursor the caller advances by.
 */
export const SUBAGENT_MAX_ENTRIES = 10_000;
export const SUBAGENT_MAX_MESSAGES = 10_000;

export type SubagentMessagesValidation =
  | { ok: true; value: SubagentMessagesResult }
  | { ok: false; reason: "malformed" | "over-limit" | "invalid-cursor" };

/** Strictly validate a messages result, distinguishing the failure reasons. */
export function validateSubagentMessages(data: unknown): SubagentMessagesValidation {
  if (!Value.Check(RpcSubagentMessagesResultSchema, data)) {
    return { ok: false, reason: "malformed" };
  }
  const value = data as SubagentMessagesResult;
  if (value.entries.length > SUBAGENT_MAX_ENTRIES || value.messages.length > SUBAGENT_MAX_MESSAGES) {
    return { ok: false, reason: "over-limit" };
  }
  if (value.nextByte < value.fromByte) {
    return { ok: false, reason: "invalid-cursor" };
  }
  return { ok: true, value };
}

/** A bounded byte cursor for reading one child's transcript. */
export type SubagentTranscriptCursor = {
  fromByte: number;
  nextByte: number;
  reset: boolean;
};

/** Normalize a caller-supplied `fromByte` into the cursor range OMP accepts. */
export function normalizeFromByte(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}
