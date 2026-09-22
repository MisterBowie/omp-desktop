/**
 * The OMP RPC framing contract this desktop implements.
 *
 * Ported from the pinned runtime rather than imported: the original lives in
 * `packages/coding-agent/src/modes/rpc/rpc-frame.ts` inside the OMP workspace,
 * which the desktop does not depend on at build time. The constants and every
 * rejection rule are copied so the desktop exercises the real contract, and an
 * import would pull the agent runtime into the Electron main bundle.
 *
 * Wire facts this module encodes (M1/E01, E13):
 *   - `ready` advertises `protocolVersion: 1` and `supportedProtocolVersions:
 *     [1, 2]`, but negotiating 1 is rejected (`rpc-mode.ts:1176`): v2 is a
 *     requirement, not a preference.
 *   - A logical frame larger than one JSONL line arrives as an ordered
 *     `rpc_chunk` sequence; a chunk failure cannot be resynchronised.
 *   - `rpc_chunk` is outbound only: writing one back is `Unknown command`.
 */
import Type from "typebox";
import * as Value from "typebox/value";

import {
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_FRAME_BYTES,
} from "@pi-desktop/shared";

export { OMP_MAX_FRAME_BYTES, OMP_MAX_REASSEMBLED_FRAME_BYTES };

/** Bytes of decoded payload per chunk frame (`rpc-frame.ts`). */
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

/** Highest chunk index a frame may need before it exceeds the reassembly cap. */
export const RPC_CHUNK_MAX_COUNT = Math.ceil(
  OMP_MAX_REASSEMBLED_FRAME_BYTES / RPC_CHUNK_PAYLOAD_BYTES,
);

/**
 * Every frame carries a `type`; the rest is per-frame. The runtime's own
 * dispatch is a string switch on this field, so an unknown type is data, not an
 * error — the desktop forwards it to event consumers.
 */
export const OmpFrameSchema = Type.Object(
  { type: Type.String() },
  { additionalProperties: true },
);
type OmpFrameShape = Type.Static<typeof OmpFrameSchema>;
/**
 * A decoded frame. The index signature is deliberate: the runtime owns the
 * frame vocabulary and the desktop must forward what it does not model
 * (`available_commands_update`, agent events, subagent frames) instead of
 * dropping it.
 */
export type OmpFrame = OmpFrameShape & Record<string, unknown>;

/**
 * Readiness frame. The pinned client requires the exact framing limits it was
 * built against (`rpc-client.ts:172`); limits are compared by the caller so a
 * mismatch can be reported as a framing mismatch instead of "not ready".
 */
export const OmpReadyFrameSchema = Type.Object(
  {
    type: Type.Literal("ready"),
    protocolVersion: Type.Number(),
    supportedProtocolVersions: Type.Array(Type.Number()),
    maxFrameBytes: Type.Number(),
    maxReassembledFrameBytes: Type.Number(),
  },
  { additionalProperties: true },
);
export type OmpReadyFrame = Type.Static<typeof OmpReadyFrameSchema> & Record<string, unknown>;

export const OmpResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("response"),
    id: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    success: Type.Boolean(),
    data: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type OmpResponseFrame = Type.Static<typeof OmpResponseFrameSchema> &
  Record<string, unknown>;

/** One slice of a logical frame that exceeded the single-line limit. */
export const OmpChunkFrameSchema = Type.Object(
  {
    type: Type.Literal("rpc_chunk"),
    chunkId: Type.String({ minLength: 1, maxLength: 128 }),
    index: Type.Integer({ minimum: 0, maximum: RPC_CHUNK_MAX_COUNT - 1 }),
    count: Type.Integer({ minimum: 2, maximum: RPC_CHUNK_MAX_COUNT }),
    byteLength: Type.Integer({
      minimum: OMP_MAX_FRAME_BYTES,
      maximum: OMP_MAX_REASSEMBLED_FRAME_BYTES,
    }),
    data: Type.String(),
  },
  { additionalProperties: true },
);
export type OmpChunkFrame = Type.Static<typeof OmpChunkFrameSchema> & Record<string, unknown>;

/** True when a value is decodable as a protocol frame at all. */
export function isOmpFrame(value: unknown): value is OmpFrame {
  return Value.Check(OmpFrameSchema, value);
}

/**
 * True when a value is a command response (as opposed to an event).
 *
 * The failure case carries a required reason, matching the pinned client's own
 * predicate (`rpc-client.ts:161`): a `success: false` without an error is a
 * protocol violation, not a response this client can report.
 */
export function isOmpResponseFrame(value: unknown): value is OmpResponseFrame {
  if (!Value.Check(OmpResponseFrameSchema, value)) return false;
  const response = value as OmpResponseFrame;
  return response.success !== false || typeof response.error === "string";
}

export interface ReadyEnvelope {
  ok: true;
  ready: OmpReadyFrame;
}

export type ReadyRejection = {
  ok: false;
  kind: "not-ready" | "protocol-unsupported" | "framing-mismatch";
  detail: string;
};

/**
 * Validate a `ready` frame against everything this client needs from it:
 * the shape, a protocol list containing v2, and the framing limits it was
 * written against. The failure kind separates "a different build" from
 * "a build that will not speak our protocol".
 */
export function checkReadyFrame(value: unknown): ReadyEnvelope | ReadyRejection {
  if (!Value.Check(OmpReadyFrameSchema, value)) {
    return { ok: false, kind: "not-ready", detail: "malformed ready frame" };
  }
  const ready = value as OmpReadyFrame;
  if (!ready.supportedProtocolVersions.includes(2)) {
    return {
      ok: false,
      kind: "protocol-unsupported",
      detail: `runtime advertises protocol versions ${ready.supportedProtocolVersions.join(",") || "(none)"}`,
    };
  }
  if (
    ready.maxFrameBytes !== OMP_MAX_FRAME_BYTES ||
    ready.maxReassembledFrameBytes !== OMP_MAX_REASSEMBLED_FRAME_BYTES
  ) {
    return {
      ok: false,
      kind: "framing-mismatch",
      detail: `runtime frame limits ${ready.maxFrameBytes}/${ready.maxReassembledFrameBytes} differ from ${OMP_MAX_FRAME_BYTES}/${OMP_MAX_REASSEMBLED_FRAME_BYTES}`,
    };
  }
  return { ok: true, ready };
}

/** True when a `ready` frame's advertised protocol list includes v2. */
export function supportsProtocolV2(value: unknown): boolean {
  return (
    Value.Check(OmpReadyFrameSchema, value) &&
    (value as OmpReadyFrame).supportedProtocolVersions.includes(2)
  );
}

// ---------------------------------------------------------------------------
// Protocol v2 chunk reassembly
// ---------------------------------------------------------------------------

export type RpcChunkErrorKind =
  | "not-an-object"
  | "interrupted"
  | "invalid-metadata"
  | "invalid-data"
  | "payload-too-large"
  | "bad-start"
  | "sequence-mismatch"
  | "length-exceeded"
  | "length-mismatch"
  | "too-large";

export class RpcChunkError extends Error {
  readonly kind: RpcChunkErrorKind;

  constructor(message: string, kind: RpcChunkErrorKind) {
    super(message);
    this.name = "RpcChunkError";
    this.kind = kind;
  }
}

export type RpcChunkSequence = {
  chunkId: string;
  nextIndex: number;
  count: number;
};

const CHUNK_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Reassembles protocol-v2 chunk sequences into logical frames.
 *
 * Stateful and single-stream: `push` returns the frame once a sequence
 * completes, `undefined` while one is in flight, and the frame itself when the
 * input is not a chunk. Any violation throws — the pinned decoder has no
 * resynchronisation path, and OMP's own client treats a throw as fatal.
 */
export class RpcChunkDecoder {
  private pending:
    | {
        chunkId: string;
        count: number;
        byteLength: number;
        nextIndex: number;
        chunks: Buffer[];
        receivedBytes: number;
      }
    | undefined;

  push(value: unknown): OmpFrame | undefined {
    const claimsToBeChunk =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "rpc_chunk";
    if (claimsToBeChunk && !Value.Check(OmpChunkFrameSchema, value)) {
      // A malformed chunk cannot be resynchronised and must not be forwarded as
      // an event: dropping it silently would turn a framing bug into a stall.
      throw new RpcChunkError("invalid rpc chunk metadata", "invalid-metadata");
    }
    if (!Value.Check(OmpChunkFrameSchema, value)) {
      // A non-chunk frame while a sequence is open means the sender dropped
      // the rest of it; anything else is simply not our concern here.
      if (this.pending) {
        throw new RpcChunkError("rpc chunk sequence interrupted", "interrupted");
      }
      if (!Value.Check(OmpFrameSchema, value)) {
        throw new RpcChunkError("rpc frame must be an object with a type", "not-an-object");
      }
      return value as OmpFrame;
    }

    const chunk = value as OmpChunkFrame;
    if (!CHUNK_BASE64.test(chunk.data)) {
      throw new RpcChunkError("invalid rpc chunk data", "invalid-data");
    }
    const bytes = Buffer.from(chunk.data, "base64");
    // Round-trip check: base64 that decodes but re-encodes differently means
    // non-canonical sender data (the pinned decoder compares the same way).
    if (bytes.toString("base64") !== chunk.data) {
      throw new RpcChunkError("invalid rpc chunk data", "invalid-data");
    }
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new RpcChunkError(
        "rpc chunk payload exceeds the transport limit",
        "payload-too-large",
      );
    }

    if (!this.pending) {
      if (chunk.index !== 0) {
        throw new RpcChunkError("rpc chunk sequence must start at index 0", "bad-start");
      }
      this.pending = {
        chunkId: chunk.chunkId,
        count: chunk.count,
        byteLength: chunk.byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
    }
    const pending = this.pending;
    if (
      pending.chunkId !== chunk.chunkId ||
      pending.count !== chunk.count ||
      pending.byteLength !== chunk.byteLength ||
      pending.nextIndex !== chunk.index
    ) {
      throw new RpcChunkError("rpc chunk sequence mismatch", "sequence-mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      throw new RpcChunkError(
        "rpc chunk sequence exceeds declared length",
        "length-exceeded",
      );
    }
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw new RpcChunkError("rpc chunk sequence length mismatch", "length-mismatch");
    }

    this.pending = undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(pending.chunks),
    );
    const frame: unknown = JSON.parse(decoded);
    if (!Value.Check(OmpFrameSchema, frame)) {
      throw new RpcChunkError("rpc frame must be an object with a type", "not-an-object");
    }
    return frame as OmpFrame;
  }

  get pendingSequence(): RpcChunkSequence | null {
    return this.pending
      ? {
          chunkId: this.pending.chunkId,
          nextIndex: this.pending.nextIndex,
          count: this.pending.count,
        }
      : null;
  }
}

/**
 * Split a logical frame into the chunk frames the pinned encoder would emit.
 * The desktop never sends one (OMP rejects inbound chunks); this exists so the
 * test double produces exactly the wire format the decoder must accept.
 */
export function encodeChunkedFrames(frame: unknown, chunkId: string): OmpFrame[] {
  const json = JSON.stringify(frame);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > OMP_MAX_REASSEMBLED_FRAME_BYTES) {
    throw new RpcChunkError("frame exceeds the reassembly ceiling", "too-large");
  }
  const bytes = Buffer.from(json, "utf8");
  const count = Math.ceil(byteLength / RPC_CHUNK_PAYLOAD_BYTES);
  const frames: OmpFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    frames.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength,
      data: bytes
        .subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES)
        .toString("base64"),
    });
  }
  return frames;
}
