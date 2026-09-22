import { describe, expect, it } from "vitest";

import { NdjsonReader } from "./ndjson.js";
import {
  checkReadyFrame,
  encodeChunkedFrames,
  isOmpFrame,
  isOmpResponseFrame,
  RpcChunkDecoder,
  RpcChunkError,
  RPC_CHUNK_PAYLOAD_BYTES,
  supportsProtocolV2,
  type OmpFrame,
} from "./protocol.js";

const readyLimits = { maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 };

describe("NDJSON framing", () => {
  it("joins a frame split across chunks and splits several frames in one chunk", () => {
    const reader = new NdjsonReader();
    const first = reader.push(Buffer.from('{"type":"a"}\n{"type":"b"'));
    expect(first.frames).toEqual([{ type: "a" }]);
    const second = reader.push(Buffer.from('}\n{"type":"c"}\n'));
    expect(second.frames).toEqual([{ type: "b" }, { type: "c" }]);
  });

  it("decodes a UTF-8 sequence split across chunk boundaries", () => {
    const reader = new NdjsonReader();
    const payload = Buffer.from('{"type":"x","text":"\u4e2d\u6587"}\n', "utf8");
    const cut = payload.indexOf(0xe4) + 1;
    expect(reader.push(payload.subarray(0, cut)).frames).toEqual([]);
    const rest = reader.push(payload.subarray(cut));
    expect(rest.frames).toEqual([{ type: "x", text: "\u4e2d\u6587" }]);
  });

  it("accepts CRLF and reports invalid JSON without ending the stream", () => {
    const reader = new NdjsonReader();
    const batch = reader.push(Buffer.from('{"type":"a"}\r\nnot json\n{"type":"b"}\n'));
    expect(batch.frames).toEqual([{ type: "a" }, { type: "b" }]);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0]?.kind).toBe("invalid-json");
  });

  it("reports an over-long line explicitly and resynchronises on the next frame", () => {
    const reader = new NdjsonReader({ maxLineBytes: 64 });
    const batch = reader.push(Buffer.from(`${"z".repeat(200)}\n{"type":"after"}\n`));
    expect(batch.errors).toEqual([{ kind: "line-too-large", bytes: 200 }]);
    expect(batch.frames).toEqual([{ type: "after" }]);
  });

  it("drops the rest of an over-long line that straddles chunk boundaries", () => {
    const reader = new NdjsonReader({ maxLineBytes: 32 });
    expect(reader.push(Buffer.from("z".repeat(40))).errors[0]?.kind).toBe("line-too-large");
    // The tail of the same line must not be mistaken for a frame.
    expect(reader.push(Buffer.from(`${"z".repeat(10)}\n{"type":"ok"}\n`)).frames).toEqual([
      { type: "ok" },
    ]);
  });

  it("ignores empty lines and flushes a trailing unterminated frame", () => {
    const reader = new NdjsonReader();
    expect(reader.push(Buffer.from("\n\n")).frames).toEqual([]);
    void reader.push(Buffer.from('{"type":"tail"}'));
    expect(reader.end().frames).toEqual([{ type: "tail" }]);
  });
});

describe("ready frame contract", () => {
  it("accepts the ready frame this build was written against", () => {
    const checked = checkReadyFrame({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      ...readyLimits,
    });
    expect(checked.ok).toBe(true);
  });

  it("refuses a runtime that does not offer v2", () => {
    const checked = checkReadyFrame({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1],
      ...readyLimits,
    });
    expect(checked).toEqual({
      ok: false,
      kind: "protocol-unsupported",
      detail: expect.stringContaining("1"),
    });
    expect(supportsProtocolV2({ supportedProtocolVersions: [1] })).toBe(false);
  });

  it("refuses different framing limits instead of guessing", () => {
    const checked = checkReadyFrame({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 4096,
      maxReassembledFrameBytes: 8192,
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.kind).toBe("framing-mismatch");
  });

  it("refuses a malformed ready frame", () => {
    expect(checkReadyFrame({ type: "ready" })).toMatchObject({ ok: false, kind: "not-ready" });
    expect(checkReadyFrame(null)).toMatchObject({ ok: false, kind: "not-ready" });
  });

  it("recognises frames and responses without accepting scalars", () => {
    expect(isOmpFrame({ type: "any" })).toBe(true);
    expect(isOmpFrame({ nope: 1 })).toBe(false);
    expect(isOmpFrame([1, 2])).toBe(false);
    expect(isOmpResponseFrame({ type: "response", success: true })).toBe(true);
    expect(isOmpResponseFrame({ type: "response", success: false })).toBe(false);
    expect(isOmpResponseFrame({ type: "response", success: false, error: "no" })).toBe(true);
  });
});

describe("protocol v2 chunk reassembly", () => {
  it("reassembles a frame the encoder split, and reports completion once", () => {
    const decoder = new RpcChunkDecoder();
    const payload = { type: "response", id: "r1", success: true, data: { text: "y".repeat(1_200_000) } };
    const frames = encodeChunkedFrames(payload, "abc");
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames.slice(0, -1)) {
      expect(decoder.push(frame)).toBeUndefined();
    }
    expect(decoder.push(frames.at(-1))).toEqual(payload);
    expect(decoder.pendingSequence).toBeNull();
  });

  it("passes a non-chunk frame through unchanged", () => {
    const decoder = new RpcChunkDecoder();
    const frame: OmpFrame = { type: "agent_event", payload: {} };
    expect(decoder.push(frame)).toBe(frame);
  });

  it("rejects a sequence that starts late, repeats, or mismatches its metadata", () => {
    const decoder = new RpcChunkDecoder();
    const frames = encodeChunkedFrames(
      { type: "response", success: true, data: { big: "z".repeat(1_200_000) } },
      "id1",
    );
    expect(() => decoder.push(frames[1])).toThrow(RpcChunkError);
    decoder.push(frames[0]);
    expect(() => decoder.push({ ...frames[1], chunkId: "other" })).toThrow(/sequence mismatch/);
  });

  it("treats an interruption and an impossible payload as protocol errors", () => {
    const decoder = new RpcChunkDecoder();
    const frames = encodeChunkedFrames(
      { type: "response", success: true, data: { big: "z".repeat(1_200_000) } },
      "id2",
    );
    decoder.push(frames[0]);
    expect(() => decoder.push({ type: "ready" })).toThrow(/interrupted/);
    const fresh = new RpcChunkDecoder();
    expect(() =>
      fresh.push({
        type: "rpc_chunk",
        chunkId: "x",
        index: 0,
        count: 2,
        byteLength: 1024 * 1024,
        data: Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES + 1).toString("base64"),
      }),
    ).toThrow(/exceeds the transport limit/);
  });

  it("rejects non-canonical base64 and impossible metadata", () => {
    const decoder = new RpcChunkDecoder();
    const base = {
      type: "rpc_chunk",
      chunkId: "x",
      index: 0,
      count: 2,
      byteLength: 1024 * 1024,
      data: "AAAA",
    };
    expect(() => decoder.push({ ...base, data: "not base64!" })).toThrow(/invalid rpc chunk data/);
    expect(() =>
      decoder.push({ ...base, count: 1, data: Buffer.alloc(4).toString("base64") }),
    ).toThrow(RpcChunkError);
  });
});
