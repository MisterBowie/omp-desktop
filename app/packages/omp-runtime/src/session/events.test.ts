/**
 * Behaviour of the frame → desktop-event translation.
 *
 * Frames are shaped exactly like the pinned runtime's own emissions
 * (`session/agent-session-events.ts`, `packages/ai/src/types.ts`, and the M1
 * captures in `app/experiments/omp-bridge/fixtures/`), so a runtime upgrade
 * that changes a field name fails here rather than in the transcript.
 */
import { describe, expect, it } from "vitest";

import { OmpEventConverter } from "./events.js";

function converter(): OmpEventConverter {
  return new OmpEventConverter({ sessionId: "s1", now: () => 1_000 });
}

describe("message streaming", () => {
  it("streams text and thinking deltas under one message id", () => {
    const c = converter();
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      model: "local-model",
      provider: "m1fake",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
      timestamp: 1_000,
    };

    const start = c.convert({ type: "message_start", message: assistant });
    expect(start).toHaveLength(1);
    const id = start[0].type === "message_start" ? start[0].message.id : "";
    expect(id).toMatch(/^omp:s1:/);
    expect(start[0]).toMatchObject({
      type: "message_start",
      message: { role: "assistant", content: "hi", status: "streaming", modelId: "local-model" },
    });

    const thinking = c.convert({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" },
    });
    expect(thinking[0]).toMatchObject({
      type: "message_update",
      deltaThinking: "weighing options",
      stream: "delta",
    });
    // A delta frame must not restate the message body: the renderer appends.
    expect(thinking[0].type === "message_update" && thinking[0].message.content).toBe("");

    const text = c.convert({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    expect(text[0]).toMatchObject({ type: "message_update", deltaText: "hello" });

    const end = c.convert({ type: "message_end", message: assistant });
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({
      type: "message_end",
      message: {
        id,
        status: "complete",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 },
      },
    });
  });

  it("omits reasoning tokens the runtime never reports", () => {
    const c = converter();
    const events = c.convert({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      },
    });
    const usage = events[0].type === "message_end" ? events[0].message.usage : undefined;
    expect(usage).toBeDefined();
    expect(usage && "reasoningTokens" in usage).toBe(false);
  });

  it("keeps the message id stable when the turn ends with a final message", () => {
    const c = converter();
    const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
    const start = c.convert({ type: "message_start", message });
    const startId = start[0].type === "message_start" ? start[0].message.id : "";
    const update = c.convert({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "done", reason: "stop", message },
    });
    expect(update[0]).toMatchObject({ type: "message_end", message: { id: startId, content: "done" } });
  });

  it("reports a failed turn as a typed error plus a terminal row", () => {
    const c = converter();
    c.convert({ type: "message_start", message: { role: "assistant", content: [] } });
    const events = c.convert({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", content: [], errorMessage: "provider exploded" },
      },
    });
    expect(events.map((event) => event.type)).toEqual(["message_end", "error"]);
    expect(events[0]).toMatchObject({ message: { status: "error" } });
    expect(events[1]).toMatchObject({
      error: { code: "OMP_MODEL_ERROR", message: "provider exploded" },
    });
  });

  it("marks an aborted turn as aborted without inventing an error", () => {
    const c = converter();
    c.convert({ type: "message_start", message: { role: "assistant", content: [] } });
    const events = c.convert({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "error", reason: "aborted", error: { role: "assistant", content: [] } },
    });
    expect(events.map((event) => event.type)).toEqual(["message_end"]);
    expect(events[0]).toMatchObject({ message: { status: "aborted" } });
  });
});

describe("tool rows", () => {
  it("preserves OMP-only fields instead of folding them into args", () => {
    const c = converter();
    const start = c.convert({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "write",
      args: { path: "/tmp/x", content: "y" },
      intent: "create the file",
      customWireName: "apply_patch",
    });
    expect(start[0]).toMatchObject({
      type: "tool_start",
      toolCallId: "call_1",
      toolName: "write",
      args: { path: "/tmp/x", content: "y" },
      ompToolMeta: { intent: "create the file", customWireName: "apply_patch" },
    });
  });

  it("forwards a partial result verbatim", () => {
    const c = converter();
    const update = c.convert({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "line 1" }], details: { stream: true } },
    });
    expect(update[0]).toMatchObject({
      type: "tool_update",
      toolCallId: "call_1",
      partialResult: { content: [{ type: "text", text: "line 1" }], details: { stream: true } },
    });
  });

  it("keeps an argument-stream projection reachable", () => {
    const c = converter();
    const update = c.convert({
      type: "tool_stream_update",
      toolCallId: "call_9",
      toolName: "edit",
      update: { preview: "-a\n+b" },
    });
    expect(update[0]).toMatchObject({
      type: "tool_update",
      toolCallId: "call_9",
      ompToolMeta: { streamUpdate: { preview: "-a\n+b" } },
    });
  });

  it("reports a denied call with the runtime's own reason", () => {
    const c = converter();
    const end = c.convert({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "write",
      result: { content: [{ type: "text", text: "denied by user (Deny)" }], details: {} },
      isError: true,
    });
    expect(end[0]).toMatchObject({ type: "tool_end", isError: true, result: { details: {} } });
  });

  it("folds toolResult messages into the tool row", () => {
    const c = converter();
    const events = c.convert({
      type: "message_start",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "write",
        content: [{ type: "text", text: "wrote 3 bytes" }],
      },
    });
    expect(events).toEqual([]);
    expect(c.snapshot().toolResultMessages).toEqual({ write: 1 });
  });

  it("refuses to route a tool frame without an id", () => {
    const c = converter();
    expect(() => c.convert({ type: "tool_execution_end", toolName: "write" })).toThrow(/toolCallId/);
  });
});

describe("run lifecycle", () => {
  it("completes only on a terminal agent_end and lists the run's message ids", () => {
    const c = converter();
    c.convert({ type: "message_start", message: { role: "assistant", content: [] } });
    expect(c.convert({ type: "agent_end", messages: [], isTerminal: false })).toEqual([]);
    const end = c.convert({ type: "agent_end", messages: [] });
    expect(end).toHaveLength(1);
    expect(end[0].type === "agent_end" && end[0].messageIds).toHaveLength(1);
  });

  it("reports usage on turn_end", () => {
    const c = converter();
    const events = c.convert({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 5, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 11 },
      },
      toolResults: [],
    });
    expect(events[0]).toMatchObject({
      type: "turn_end",
      subagentUsage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 1, totalTokens: 11 },
    });
  });

  it("surfaces an error notice and counts informational ones", () => {
    const c = converter();
    expect(c.convert({ type: "notice", level: "info", message: "fyi" })).toEqual([]);
    const errors = c.convert({ type: "notice", level: "error", message: "store failed", source: "x" });
    expect(errors[0]).toMatchObject({ type: "error", error: { code: "OMP_NOTICE", message: "store failed" } });
  });
});

describe("unknown frames", () => {
  it("counts unmapped kinds instead of throwing", () => {
    const c = converter();
    expect(c.convert({ type: "totally_new_frame", payload: 1 })).toEqual([]);
    expect(c.convert({ type: "totally_new_frame", payload: 2 })).toEqual([]);
    expect(c.convert({ type: "goal_updated", goal: null })).toEqual([]);
    expect(c.snapshot().unmappedFrames).toEqual({ totally_new_frame: 2, goal_updated: 1 });
  });

  it("ignores a frame that is not an object", () => {
    const c = converter();
    expect(c.convert("nonsense")).toEqual([]);
    expect(c.convert(null)).toEqual([]);
    expect(c.snapshot().notes.join(" ")).toMatch(/without a string type/);
  });
});
