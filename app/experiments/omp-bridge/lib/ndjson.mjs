/**
 * NDJSON reader for a byte stream carrying OMP RPC frames.
 *
 * Specifies the behaviour M2/T09's desktop-side reader must guarantee, and is
 * the reference used by the M1 transport experiment:
 *
 *   - UTF-8 sequences split across chunk boundaries decode correctly
 *     (incremental StringDecoder, never per-chunk Buffer.toString).
 *   - A frame split across several chunks yields exactly one frame.
 *   - Several frames inside one chunk yield them in order.
 *   - CRLF and LF are both accepted; a trailing CR is not part of the JSON.
 *   - Invalid JSON is reported as a protocol error and the stream continues.
 *   - A line longer than `maxLineBytes` characters (UTF-16 code units, measured
 *     after UTF-8 decoding) is reported as an explicit `line-too-large` error
 *     and the reader resynchronises on the next LF instead of growing the
 *     buffer without bound.
 *   - Empty lines are ignored (no frame, no error).
 */
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Protocol-v2 chunk reassembly for OMP RPC frames.
 *
 * A faithful port of the pinned implementation
 * (`upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-frame.ts`,
 * `RpcFrameDecoder` + `encodeChunkedRpcFrames`) rather than an import: the
 * original is TypeScript inside a workspace package that the desktop runtime
 * does not depend on. The constants and every rejection rule are copied so the
 * experiment exercises the real contract:
 *
 *   MAX_RPC_FRAME_BYTES        = 1 MiB  (one JSONL line, newline included)
 *   MAX_RPC_REASSEMBLED_BYTES  = 64 MiB (one logical frame after reassembly)
 *   RPC_CHUNK_PAYLOAD_BYTES    = 256 KiB (per chunk, base64 in `data`)
 *
 * Chunks for one logical frame must arrive strictly in order, starting at
 * index 0, with identical `chunkId`/`count`/`byteLength`, `count >= 2` and
 * `byteLength >= MAX_RPC_FRAME_BYTES`. Anything else is a protocol error.
 */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export class RpcChunkError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "RpcChunkError";
    this.kind = kind;
  }
}

export class RpcChunkDecoder {
  #pending;

  /** @returns {object|undefined} the logical frame once complete. */
  push(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.type !== "rpc_chunk") {
      if (this.#pending) throw new RpcChunkError("rpc chunk sequence interrupted", "interrupted");
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new RpcChunkError("rpc frame must be an object", "not-an-object");
      }
      return value;
    }

    const { chunkId, index, count, byteLength, data } = value;
    const maxCount = Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES);
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
      index < 0 || count < 2 || count > maxCount || index >= count ||
      byteLength < MAX_RPC_FRAME_BYTES || byteLength > MAX_RPC_REASSEMBLED_BYTES
    ) {
      throw new RpcChunkError("invalid rpc chunk metadata", "invalid-metadata");
    }
    if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new RpcChunkError("invalid rpc chunk data", "invalid-data");
    }
    const bytes = Buffer.from(data, "base64");
    // Round-trip check: base64 that decodes but does not re-encode identically
    // means the sender wrote non-canonical data (the pinned decoder does the
    // same comparison).
    if (bytes.toString("base64") !== data) throw new RpcChunkError("invalid rpc chunk data", "invalid-data");
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new RpcChunkError("rpc chunk payload exceeds the transport limit", "payload-too-large");
    }

    if (!this.#pending) {
      if (index !== 0) throw new RpcChunkError("rpc chunk sequence must start at index 0", "bad-start");
      this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.#pending;
    if (
      pending.chunkId !== chunkId || pending.count !== count ||
      pending.byteLength !== byteLength || pending.nextIndex !== index
    ) {
      throw new RpcChunkError("rpc chunk sequence mismatch", "sequence-mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength) {
      throw new RpcChunkError("rpc chunk sequence exceeds declared length", "length-exceeded");
    }
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw new RpcChunkError("rpc chunk sequence length mismatch", "length-mismatch");
    }

    this.#pending = undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame = JSON.parse(decoded);
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      throw new RpcChunkError("rpc frame must be an object", "not-an-object");
    }
    return frame;
  }

  get pendingSequence() {
    return this.#pending ? { chunkId: this.#pending.chunkId, nextIndex: this.#pending.nextIndex, count: this.#pending.count } : null;
  }
}

/** Split a logical frame into protocol-v2 chunk frames, mirroring the encoder. */
export function encodeChunkedFrames(frame, { chunkId }) {
  const json = JSON.stringify(frame);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_RPC_REASSEMBLED_BYTES) throw new RpcChunkError("frame exceeds the reassembly ceiling", "too-large");
  const bytes = Buffer.from(json, "utf8");
  const count = Math.ceil(byteLength / RPC_CHUNK_PAYLOAD_BYTES);
  const out = [];
  for (let index = 0; index < count; index++) {
    out.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength,
      data: bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES).toString("base64"),
    });
  }
  return out;
}

export class NdjsonReader {
  #pending = "";
  #discarding = false;
  #decoder = new StringDecoder("utf8");

  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
  }

  /**
   * Feed one raw chunk.
   * @param {Buffer|string} chunk
   * @returns {{frames: object[], errors: {kind: string, sample?: string, bytes?: number}[]}}
   */
  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? this.#decoder.write(chunk) : chunk;
    const frames = [];
    const errors = [];
    let cursor = 0;

    while (cursor < text.length) {
      const lf = text.indexOf("\n", cursor);
      const isLast = lf === -1;
      const piece = isLast ? text.slice(cursor) : text.slice(cursor, lf);
      cursor = isLast ? text.length : lf + 1;

      if (this.#discarding) {
        // Resynchronise: drop everything up to and including the newline.
        if (!isLast) this.#discarding = false;
        continue;
      }

      this.#pending += piece;
      if (this.#pending.length > this.maxLineBytes) {
        errors.push({ kind: "line-too-large", bytes: this.#pending.length });
        this.#pending = "";
        this.#discarding = !isLast ? false : true;
        continue;
      }
      if (isLast) continue;

      const line = this.#pending.endsWith("\r") ? this.#pending.slice(0, -1) : this.#pending;
      this.#pending = "";
      if (line.trim() === "") continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        errors.push({ kind: "invalid-json", sample: line.slice(0, 200) });
      }
    }

    return { frames, errors };
  }

  /** Flush a trailing partial line at stream end (no newline). */
  end() {
    const rest = this.#decoder.end() + this.#pending;
    this.#pending = "";
    if (rest.trim() === "") return { frames: [], errors: [] };
    try {
      return { frames: [JSON.parse(rest.trim())], errors: [] };
    } catch {
      return { frames: [], errors: [{ kind: "invalid-json", sample: rest.slice(0, 200) }] };
    }
  }
}
