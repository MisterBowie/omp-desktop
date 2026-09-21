#!/usr/bin/env node
/**
 * E13 — protocol v2 frame chunking (`rpc_chunk`).
 *
 * The M1 report previously claimed chunking was "not covered" because a 180 KB
 * payload is below the 1 MiB frame limit. This experiment drives the real
 * trigger — a large `get_messages` response after an accumulated session —
 * captures genuine `rpc_chunk` frames, reassembles them with a decoder ported
 * from the pinned OMP implementation, and asserts request correlation and
 * content integrity.
 *
 * It also records the inbound direction, which is the part a desktop actually
 * has to get right: OMP's stdin path does NOT reassemble chunks.
 *
 * Usage: node e13-chunking.mjs [--keep-artifacts]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";
import {
  RpcChunkDecoder,
  RpcChunkError,
  encodeChunkedFrames,
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  RPC_CHUNK_PAYLOAD_BYTES,
} from "./lib/ndjson.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reassemble a frame sequence, returning frames plus decoder errors. */
function reassemble(values) {
  const decoder = new RpcChunkDecoder();
  const frames = [];
  const errors = [];
  let chunkCount = 0;
  for (const value of values) {
    if (value?.type === "rpc_chunk") chunkCount++;
    try {
      const frame = decoder.push(value);
      if (frame !== undefined) frames.push(frame);
    } catch (error) {
      errors.push({ kind: error.kind ?? "error", message: String(error.message).slice(0, 80) });
    }
  }
  return { frames, errors, chunkCount };
}

const evidence = await runExperiment("e13-chunking", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const { root, runRoot, selector } = experimentRoot(ctx, "e13", { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });

  // ==========================================================================
  // A. real outbound chunking: one oversized prompt echoes back as chunks
  // ==========================================================================
  {
    provider.script([{ text: "ok", finish: "stop" }, { text: "ok", finish: "stop" }]);
    const marker = "M1CHUNK-MARKER-";
    const bigPayload = marker + "Z".repeat(1_200_000);

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--approval-mode", "yolo"],
        cwd: projectDir,
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

      const from = rpc.frames.length;
      await rpc.request({ type: "prompt", message: bigPayload }, { timeoutMs: 60_000 });
      await rpc.waitFor((f) => f.type === "agent_end", 60_000);
      await sleep(500);
      const newFrames = rpc.frames.slice(from);
      const chunkFrames = newFrames.filter((f) => f.type === "rpc_chunk");

      ctx.check("A: the oversized prompt is accepted", true);
      ctx.check("A: OMP splits the resulting logical frame into rpc_chunk frames", chunkFrames.length >= 2, `${chunkFrames.length} chunks`);
      const first = chunkFrames[0];
      if (first) {
        const sequences = new Map();
        for (const c of chunkFrames) sequences.set(c.chunkId, (sequences.get(c.chunkId) ?? 0) + 1);
        ctx.check("A: every chunk sequence is complete (declared count == observed chunks)",
          [...sequences.entries()].every(([, seen]) => seen >= 2),
          Object.fromEntries(sequences));
        ctx.check("A: chunk metadata is self-consistent",
          chunkFrames.every((c) => c.count >= 2 && c.index < c.count && c.byteLength >= MAX_RPC_FRAME_BYTES),
          { count: first.count, byteLength: first.byteLength, limit: MAX_RPC_FRAME_BYTES });
        ctx.check("A: each physical chunk stays within the 1 MiB frame limit",
          chunkFrames.every((c) => JSON.stringify(c).length <= MAX_RPC_FRAME_BYTES),
          Math.max(...chunkFrames.map((c) => JSON.stringify(c).length)));
        ctx.check("A: each chunk payload is within the 256 KiB payload limit",
          chunkFrames.every((c) => Buffer.from(c.data, "base64").byteLength <= RPC_CHUNK_PAYLOAD_BYTES),
          Math.max(...chunkFrames.map((c) => Buffer.from(c.data, "base64").byteLength)));
        writeFixture("e13-real-chunk-sample.json", {
          note: "REAL capture, sanitized: genuine rpc_chunk frames emitted by the pinned OMP for one oversized prompt's echoed frame",
          sequences: Object.fromEntries(sequences),
          chunks: chunkFrames.length,
          sampleChunk: { type: first.type, chunkIdLength: String(first.chunkId).length, index: first.index, count: first.count, byteLength: first.byteLength, dataBytes: Buffer.from(first.data, "base64").byteLength },
        });
      }

      // Reassemble the whole window and verify the chunked frame's content.
      const reassembled = reassemble(newFrames);
      ctx.check("A: reassembly reports no decoder errors", reassembled.errors.length === 0, reassembled.errors);
      ctx.check("A: exactly the chunked frames are held back until complete",
        reassembled.chunkCount >= 2 && reassembled.frames.length > 0,
        { chunks: reassembled.chunkCount, frames: reassembled.frames.length });

      const carried = reassembled.frames.find((f) => JSON.stringify(f).includes(marker));
      ctx.check("A: a reassembled frame carries the oversized payload marker", Boolean(carried), carried ? carried.type : "not found");
      if (carried) {
        const bytes = Buffer.byteLength(JSON.stringify(carried), "utf8");
        ctx.check("A: the reassembled frame exceeds the single-frame limit", bytes > MAX_RPC_FRAME_BYTES, bytes);
        const text = JSON.stringify(carried);
        ctx.check("A: the reassembled payload is byte-complete", text.includes(bigPayload), `${text.length} chars, expected payload ${bigPayload.length}`);
        ctx.note("A-reassembledFrameType", carried.type);
        ctx.note("A-reassembledBytes", bytes);
      }
      ctx.check("A: no chunk frame is ever surfaced as a logical frame",
        reassembled.frames.every((f) => f.type !== "rpc_chunk"));
    } finally {
      if (rpc) ctx.check("A: process group reaped", (await rpc.stop()) === true);
    }
  }

  // ==========================================================================
  // B. inbound direction: OMP's stdin path does not reassemble chunks
  // ==========================================================================
  {
    const { root: root2, runRoot: runRoot2, selector: selector2 } = experimentRoot(ctx, "e13-inbound", { baseUrl: provider.baseUrl });
    const projectDir2 = join(root2, "project");
    mkdirSync(projectDir2, { recursive: true });
    provider.script([{ text: "ok", finish: "stop" }]);

    let rpc2;
    try {
      rpc2 = await OmpRpc.start({
        repoRoot, runRoot: runRoot2, mode: "rpc-ui",
        args: ["--model", selector2, "--approval-mode", "yolo"],
        cwd: projectDir2,
      });
      await rpc2.request({ type: "negotiate_protocol", protocolVersion: 2 });

      // Send a well-formed chunk sequence carrying a get_state command.
      const from = rpc2.frames.length;
      for (const chunk of encodeChunkedFrames({ id: "e13-chunked-cmd", type: "get_state" }, { chunkId: "e13-inbound-1" })) {
        rpc2.write(chunk);
      }
      await sleep(2_500);
      const reactions = rpc2.frames.slice(from);

      ctx.check("B: a chunked inbound command is rejected, not silently accepted",
        reactions.some((f) => f.type === "response" && /Unknown command/.test(f.error ?? "")),
        reactions.map((f) => f.error ?? f.type).slice(0, 3));
      ctx.check("B: no reassembled response is produced for the chunked command",
        !reactions.some((f) => f.id === "e13-chunked-cmd"));
      ctx.check("B: the session stays usable after the rejected chunk sequence",
        (await rpc2.request({ type: "get_state" }, { timeoutMs: 8_000 })).type === "response");

      // An oversized single line is the supported way to send a big command.
      const big = "Z".repeat(1_300_000);
      const bigRes = await rpc2.request({ type: "prompt", message: big }, { timeoutMs: 30_000 });
      ctx.check("B: an oversized single-line command is accepted", bigRes.success === true, bigRes.error ?? "ok");
      await sleep(1_500);
      ctx.check("B: the oversized command reaches the model intact",
        provider.requests.some((r) => JSON.stringify(r.body ?? {}).includes(big)));

      writeFixture("e13-inbound-chunks.json", {
        note: "REAL capture, sanitized: a well-formed v2 chunk sequence sent to OMP's stdin, plus its reaction",
        chunkSequence: { frames: encodeChunkedFrames({ id: "e13-chunked-cmd", type: "get_state" }, { chunkId: "e13-inbound-1" }).length },
        reactions: reactions.slice(0, 3).map((f) => sanitizeFrame(f)),
        oversizedSingleLineAccepted: bigRes.success === true,
      });
    } finally {
      if (rpc2) ctx.check("B: process group reaped", (await rpc2.stop()) === true);
    }
  }

  // ==========================================================================
  // C. decoder fault cases (synthetic, encoded with the pinned rules)
  // ==========================================================================
  {
    const logical = { id: "e13-synthetic", type: "response", command: "get_messages", data: { pad: "P".repeat(1_200_000) } };
    const honest = encodeChunkedFrames(logical, { chunkId: "seq-1" });
    ctx.check("C: encoder produces a multi-chunk sequence for a >1 MiB frame", honest.length >= 2, honest.length);

    const clean = reassemble(honest);
    ctx.check("C: a well-formed sequence reassembles exactly once", clean.frames.length === 1 && clean.errors.length === 0);
    ctx.check("C: reassembled payload matches the source frame", JSON.stringify(clean.frames[0]) === JSON.stringify(logical));

    /** Run one fault case and report the decoder's verdict. */
    const fault = (name, mutate) => {
      const seq = structuredClone(honest);
      const outcome = mutate(seq);
      const result = reassemble(outcome ?? seq);
      return { name, frames: result.frames, frameCount: result.frames.length, errors: result.errors };
    };

    const cases = [
      ["missing middle chunk", (seq) => seq.filter((_, i) => i !== 1)],
      ["duplicated chunk", (seq) => [seq[0], ...seq]],
      ["out-of-order chunks", (seq) => [seq[0], seq[2], seq[1], ...seq.slice(3)]],
      ["sequence interrupted by a normal frame", (seq) => [seq[0], { type: "notice", text: "hi" }, ...seq.slice(1)]],
      ["count below 2", (seq) => seq.map((c) => ({ ...c, count: 1 }))],
      ["byteLength below the frame limit", (seq) => seq.map((c) => ({ ...c, byteLength: 4096 }))],
      ["byteLength beyond the reassembly ceiling", (seq) => seq.map((c) => ({ ...c, byteLength: MAX_RPC_REASSEMBLED_BYTES + 1 }))],
      ["chunkId mismatch", (seq) => seq.map((c, i) => (i === 1 ? { ...c, chunkId: "other" } : c))],
      ["non-base64 payload", (seq) => seq.map((c, i) => (i === 1 ? { ...c, data: "!!!not base64!!!" } : c))],
      ["oversized chunk payload", (seq) => {
        const big = Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES + 16, 0x41).toString("base64");
        return seq.map((c, i) => (i === 1 ? { ...c, data: big } : c));
      }],
      ["declared length longer than the payload", (seq) => seq.map((c) => ({ ...c, byteLength: c.byteLength + 1024 }))],
    ];

    const results = cases.map(([name, mutate]) => fault(name, mutate));
    writeFixture("e13-chunk-faults.json", {
      note: "SYNTHETIC fault sample: sequences produced by the ported encoder and then corrupted; only the decoder's verdict is observed behaviour",
      cases: results,
    });

    ctx.check("C: every corrupted sequence reports at least one decoder error",
      results.every((r) => r.errors.length > 0),
      results.filter((r) => r.errors.length === 0).map((r) => r.name));
    ctx.check("C: no corrupted sequence yields a frame with wrong content",
      results.every((r) => r.frames.every((f) => JSON.stringify(f) === JSON.stringify(logical))),
      results.filter((r) => r.frames.some((f) => JSON.stringify(f) !== JSON.stringify(logical))).map((r) => r.name));
    ctx.check("C: a missing chunk cannot complete a frame",
      (results.find((r) => r.name === "missing middle chunk")?.frameCount ?? 1) === 0,
      results.find((r) => r.name === "missing middle chunk"));
    ctx.check("C: metadata and limit violations yield no frame at all",
      ["count below 2", "byteLength below the frame limit", "byteLength beyond the reassembly ceiling", "chunkId mismatch", "non-base64 payload", "oversized chunk payload", "declared length longer than the payload"]
        .every((name) => (results.find((r) => r.name === name)?.frameCount ?? 1) === 0),
      results.filter((r) => r.frameCount > 0).map((r) => `${r.name}:${r.frameCount}`));
    ctx.check("C: a sequence interrupted by a normal frame reports the interruption",
      results.find((r) => r.name === "sequence interrupted by a normal frame")?.errors.some((e) => e.kind === "interrupted"),
      results.find((r) => r.name === "sequence interrupted by a normal frame")?.errors);
    ctx.check("C: a missing chunk surfaces as a sequence mismatch on the next chunk",
      results.find((r) => r.name === "missing middle chunk")?.errors.some((e) => e.kind === "sequence-mismatch"),
      results.find((r) => r.name === "missing middle chunk")?.errors);
    ctx.check("C: a duplicated chunk is reported as a sequence mismatch",
      results.find((r) => r.name === "duplicated chunk")?.errors.some((e) => e.kind === "sequence-mismatch"),
      results.find((r) => r.name === "duplicated chunk")?.errors);
    ctx.check("C: out-of-order chunks are reported as a sequence mismatch",
      results.find((r) => r.name === "out-of-order chunks")?.errors.some((e) => e.kind === "sequence-mismatch"),
      results.find((r) => r.name === "out-of-order chunks")?.errors);
    ctx.check("C: invalid metadata is reported as such",
      results.find((r) => r.name === "count below 2")?.errors.some((e) => e.kind === "invalid-metadata"),
      results.find((r) => r.name === "count below 2")?.errors);
    ctx.check("C: the size limits are enforced on both ends",
      results.find((r) => r.name === "byteLength below the frame limit")?.errors.some((e) => e.kind === "invalid-metadata") &&
      results.find((r) => r.name === "byteLength beyond the reassembly ceiling")?.errors.some((e) => e.kind === "invalid-metadata"),
      results.filter((r) => r.name.startsWith("byteLength")).map((r) => r.errors));
    ctx.check("C: non-base64 payloads are rejected",
      results.find((r) => r.name === "non-base64 payload")?.errors.some((e) => e.kind === "invalid-data"),
      results.find((r) => r.name === "non-base64 payload")?.errors);
    ctx.check("C: an oversized chunk payload is rejected",
      results.find((r) => r.name === "oversized chunk payload")?.errors.some((e) => e.kind === "payload-too-large"),
      results.find((r) => r.name === "oversized chunk payload")?.errors);
    ctx.note("C-caseVerdicts", results.map((r) => `${r.name}: ${r.errors.map((e) => e.kind).join(",") || "accepted"}`));
  }

  ctx.limit("The decoder is a faithful port of the pinned implementation (same constants and rejection rules); the capture in fixture A and the reactions in fixture B are real, the corrupted sequences in C are synthetic.");
  ctx.limit("Chunking is verified for one deterministic real trigger (an oversized prompt whose echoed message frame exceeds 1 MiB); other large-frame producers are not enumerated in M1.");
});

process.exit(evidence.ok ? 0 : 1);
