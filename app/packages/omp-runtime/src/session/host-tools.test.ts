/**
 * Unit probes for the host-tool bridge class: at-most-once per generation
 * (with no evictable cap), cancellation correlation, late-completion dropping
 * and the error mapping onto the real `host_tool_result` shape.
 */
import { describe, expect, it } from "vitest";

import type { OmpFrame } from "../protocol.js";
import {
  OmpHostToolCalls,
  type OmpHostToolExecutor,
  type OmpHostToolRun,
} from "./host-tools.js";

type Written = Record<string, unknown>;

function harness(execute?: OmpHostToolExecutor) {
  const written: Written[] = [];
  const calls = new OmpHostToolCalls({
    ...(execute ? { execute } : {}),
    write: (frame) => {
      written.push(frame as Written);
      return true;
    },
  });
  return { calls, written };
}

const RUN: OmpHostToolRun = { sessionId: "omp-1", turnId: "turn-1", generation: 1 };

function callFrame(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "host_tool_call",
    id,
    toolCallId: `tc-${id}`,
    toolName: "plugin_demo_echo",
    arguments: { text: "hi" },
    ...overrides,
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("host tool calls", () => {
  it("executes a call once and writes its result under the call id", async () => {
    const executed: string[] = [];
    const { calls, written } = harness({
      execute: async (call) => {
        executed.push(call.id);
        return { content: [{ type: "text", text: `echo:${String(call.arguments?.text ?? "")}` }] };
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    expect(executed).toEqual(["h1"]);
    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("h1");
    expect((results[0]?.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text).toBe("echo:hi");
    expect(results[0]?.isError).toBeUndefined();
  });

  it("a duplicate frame in the same generation never executes twice", async () => {
    let count = 0;
    const { calls } = harness({
      execute: async () => {
        count += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    expect(count).toBe(1);
    expect(calls.snapshot().duplicates).toBe(1);
  });

  it("the at-most-once record survives beyond any fixed id cap within a generation", async () => {
    // The generation-scoped record is unbounded: a replay of the earliest id
    // after thousands of later calls must still be refused — an LRU cap would
    // have evicted it and executed the call a second time.
    let count = 0;
    const { calls } = harness({
      execute: async () => {
        count += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const total = 5000;
    for (let index = 0; index < total; index += 1) {
      calls.handleCall(callFrame(`h${index}`), RUN);
    }
    await settle();
    expect(count).toBe(total);

    calls.handleCall(callFrame("h0"), RUN);
    calls.handleCall(callFrame(`h${total - 1}`), RUN);
    await settle();
    expect(count).toBe(total, "neither the earliest nor the latest id may re-execute");
    expect(calls.snapshot().duplicates).toBe(2);
  });

  it("closing a generation reclaims its record", async () => {
    const { calls } = harness({
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    for (let index = 0; index < 64; index += 1) calls.handleCall(callFrame(`h${index}`), RUN);
    await settle();
    const before = calls.snapshot();
    expect(before.trackedGenerations).toBe(1);
    expect(before.rememberedIds).toBe(64);

    calls.closeGeneration(RUN.generation);
    const after = calls.snapshot();
    expect(after.trackedGenerations).toBe(0);
    expect(after.rememberedIds).toBe(0);
  });

  it("a cancel correlates by targetId and aborts the pending execution without a result", async () => {
    let aborted = false;
    const { calls, written } = harness({
      execute: async (_call, _run, signal) => {
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
        return promise;
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();
    calls.handleCancel({ type: "host_tool_cancel", id: "c1", targetId: "h1" });
    await settle();

    expect(aborted).toBe(true);
    expect(written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(0);
    expect(calls.snapshot().cancelled).toBe(1);
  });

  it("a completion that races the cancel is a late completion, never a result", async () => {
    const { calls, written } = harness({
      execute: async (_call, _run, signal) => {
        const { promise, resolve } = Promise.withResolvers<{ content: Array<{ type: "text"; text: string }> }>();
        // Completes from the abort listener: `handleCancel` settles the entry
        // *before* firing the signal, so this resolution always lands as a
        // microtask after the cancel — deterministically late, no timers.
        signal.addEventListener("abort", () => {
          resolve({ content: [{ type: "text", text: "LATE" }] });
        }, { once: true });
        return promise;
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();
    calls.handleCancel({ type: "host_tool_cancel", id: "c1", targetId: "h1" });
    await settle();

    expect(written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(0);
    expect(calls.snapshot().lateCompletions).toBeGreaterThanOrEqual(1);
  });

  it("a cancel for an unknown targetId is counted and dropped", async () => {
    const { calls, written } = harness({
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    calls.handleCancel({ type: "host_tool_cancel", id: "c1", targetId: "never-issued" });
    await settle();

    expect(calls.snapshot().unknownCancels).toBe(1);
    expect(written).toHaveLength(0);
  });

  it("a call with no active run is answered isError and never executed", async () => {
    let count = 0;
    const { calls, written } = harness({
      execute: async () => {
        count += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    calls.handleCall(callFrame("h1"), null);
    await settle();

    expect(count).toBe(0);
    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("h1");
    expect(results[0]?.isError).toBe(true);
  });

  it("a call with no wired executor is answered isError and never executed", async () => {
    const { calls, written } = harness();
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
  });

  it("a replayed fail-closed call is answered fail-closed again, still with zero executions", async () => {
    // The narrowed contract: at-most-once covers *execution* within an owned
    // generation. A call rejected for having no active run is not remembered,
    // so a replay receives another isError answer — but executions stay at
    // zero either way, and the runtime drops answers to ids it no longer
    // tracks, so no side effect results.
    let count = 0;
    const { calls, written } = harness({
      execute: async () => {
        count += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    calls.handleCall(callFrame("h1"), null);
    calls.handleCall(callFrame("h1"), null);
    await settle();

    expect(count).toBe(0);
    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(2, "each rejected delivery is answered fail-closed");
    expect(results.every((frame) => frame.isError === true)).toBe(true);
    expect(calls.snapshot().noRun).toBe(2);
  });

  it("a throwing executor becomes an isError result with the error text", async () => {
    const { calls, written } = harness({
      execute: async () => {
        throw Object.assign(new Error("mcp server stub is not active for this session"), {
          errorCode: "TOOL_NOT_FOUND",
        });
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect((results[0]?.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text).toContain("stub is not active");
  });

  it("a huge thrown error is bounded at the protocol write boundary", async () => {
    // Escapes plus multibyte text: the serialized form expands far beyond the
    // raw message, so only a serialized-bytes budget holds the line limit.
    const huge = `err-"\\中`.repeat(300_000);
    const { calls, written } = harness({
      execute: async () => {
        throw new Error(huge);
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    const content = (results[0]?.result as { content?: Array<{ text?: string }> })?.content ?? [];
    expect(Buffer.byteLength(JSON.stringify(content), "utf8")).toBeLessThanOrEqual(768 * 1024);
    expect(content[0]?.text?.endsWith("\u2026")).toBe(true);
  });

  it("a huge executor outcome is bounded at the protocol write boundary too", async () => {
    // The desktop adapter bounds its own outcomes, but the write boundary is
    // authoritative: an executor that bypasses the adapter's pass must still
    // never emit a frame over the line limit.
    const huge = "中".repeat(400_000);
    const { calls, written } = harness({
      execute: async () => ({ content: [{ type: "text", text: huge }] }),
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    const content = (results[0]?.result as { content?: Array<{ text?: string }> })?.content ?? [];
    expect(Buffer.byteLength(JSON.stringify(content), "utf8")).toBeLessThanOrEqual(768 * 1024);
    expect(content[0]?.text?.endsWith("\u2026")).toBe(true);
  });

  it("an executor outcome that is itself an error is written with isError", async () => {
    const { calls, written } = harness({
      execute: async () => ({
        content: [{ type: "text", text: "inner failure" }],
        isError: true,
      }),
    });
    calls.handleCall(callFrame("h1"), RUN);
    await settle();

    const results = written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
  });

  it("cancelAll aborts every pending execution with the reason on the signal", async () => {
    const reasons: string[] = [];
    const { calls } = harness({
      execute: async (_call, _run, signal) => {
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => {
          reasons.push(String(signal.reason));
          reject(new Error("aborted"));
        }, { once: true });
        return promise;
      },
    });
    calls.handleCall(callFrame("h1"), RUN);
    calls.handleCall(callFrame("h2"), RUN);
    await settle();
    calls.cancelAll("the run was stopped");
    await settle();

    expect(reasons).toEqual(["Error: the run was stopped", "Error: the run was stopped"]);
    expect(calls.snapshot().pending).toBe(0);
  });

  it("malformed frames are counted and dropped", async () => {
    const { calls } = harness({
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    calls.handleCall({ type: "host_tool_call", id: "h1" }, RUN);
    calls.handleCancel({ type: "host_tool_cancel", id: "c1" });
    await settle();

    expect(calls.snapshot().malformed).toBe(2);
    expect(calls.snapshot().executed).toBe(0);
  });
});
