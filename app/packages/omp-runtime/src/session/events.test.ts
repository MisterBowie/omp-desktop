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

describe("durable entry conversion (shared serialized budget)", () => {
  const ROW_BUDGET_BYTES = 4 * 1024 * 1024;
  const serializedBytes = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  type DurableEntry = {
    id: string;
    parentId: null;
    timestamp: string;
    message: Record<string, unknown>;
  };
  const entry = (message: Record<string, unknown>, id = "entry-1"): DurableEntry => ({
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  });
  const toolEntry = (
    content: unknown,
    details?: unknown,
    id = "entry-1",
  ): DurableEntry =>
    entry(
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call-1",
        content,
        ...(details === undefined ? {} : { details }),
        timestamp: 1,
      },
      id,
    );

  it("bounds a large ASCII string result to the whole-row budget", () => {
    const row = converter().convertEntry(toolEntry("x".repeat(5 * 1024 * 1024)));
    expect(row).not.toBeNull();
    if (!row) return;
    // Text-only result: the renderer reads `content`, so `toolResult` is empty.
    expect(row.toolResult).toBe("");
    expect(row.content.endsWith("\u2026")).toBe(true);
    expect(row.content.length).toBeLessThan(ROW_BUDGET_BYTES);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("bounds multiple text parts and drops non-text blocks", () => {
    const row = converter().convertEntry(
      toolEntry([
        { type: "text", text: "a".repeat(3 * 1024 * 1024) },
        { type: "image", data: "z".repeat(1024 * 1024), mimeType: "image/png" },
        { type: "text", text: "b".repeat(3 * 1024 * 1024) },
      ]),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.toolResult).toBe("");
    expect(JSON.stringify(row)).not.toContain("image/png");
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("shares one budget across content and details", () => {
    const row = converter().convertEntry(
      toolEntry(
        [{ type: "text", text: "c".repeat(5 * 1024 * 1024) }],
        { output: "d".repeat(5 * 1024 * 1024) },
      ),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    // Structured result: the text lives in the envelope, never duplicated in
    // the row's `content`.
    expect(row.content).toBe("");
    const result = row.toolResult as { content: Array<{ text: string }>; details: { output: string } };
    expect(Array.isArray(result.content)).toBe(true);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("preserves valid Unicode while bounding CJK and emoji text", () => {
    const emoji = converter().convertEntry(toolEntry("\u{1F600}".repeat(3 * 1024 * 1024)));
    const cjk = converter().convertEntry(toolEntry("\u{6F22}".repeat(3 * 1024 * 1024)));
    for (const row of [emoji, cjk]) {
      expect(row).not.toBeNull();
      if (!row) return;
      expect(row.content.isWellFormed()).toBe(true);
      expect(row.content.endsWith("\u2026")).toBe(true);
      expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
    }
  });

  it("never splits a surrogate pair when a leading ASCII char pushes the cut inside one", () => {
    const row = converter().convertEntry(
      toolEntry(`x${"\u{1F600}".repeat(3 * 1024 * 1024)}`),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.content.isWellFormed()).toBe(true);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("charges JSON escaping, not raw code units", () => {
    const row = converter().convertEntry(toolEntry("\u0000\"\\".repeat(700_000)));
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.content.includes("\u2026")).toBe(true);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("charges object keys and stops adding them past the budget", () => {
    const row = converter().convertEntry(
      toolEntry(
        "result",
        Object.fromEntries(
          Array.from({ length: 40_000 }, (_, index) => [`${"k".repeat(120)}${index}`, index]),
        ),
      ),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    const details = (row.toolResult as { details: Record<string, unknown> }).details;
    expect(details).toBeTypeOf("object");
    expect(Object.keys(details).length).toBeLessThan(40_000);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("charges array values and non-string scalars", () => {
    const row = converter().convertEntry(
      toolEntry(
        "result",
        Array.from({ length: 300_000 }, () => Number.MAX_SAFE_INTEGER),
      ),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    const details = (row.toolResult as { details: unknown[] }).details;
    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeLessThan(300_000);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("bounds a string-form assistant message instead of bypassing truncation", () => {
    const row = converter().convertEntry(
      entry({ role: "assistant", content: "a".repeat(5 * 1024 * 1024), timestamp: 1 }),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.role).toBe("assistant");
    expect(row.content.endsWith("\u2026")).toBe(true);
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("shares the budget across assistant content and thinking", () => {
    const row = converter().convertEntry(
      entry({
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(4 * 1024 * 1024) },
          { type: "thinking", thinking: "t".repeat(4 * 1024 * 1024) },
        ],
        timestamp: 1,
      }),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.role).toBe("assistant");
    expect(serializedBytes(row)).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  it("preserves small supported payloads exactly", () => {
    const row = converter().convertEntry(
      toolEntry(
        [{ type: "text", text: "file contents" }],
        { path: "/tmp/a.txt", exitCode: 0, lines: [1, 2, 3], ok: true, nil: null },
      ),
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.toolResult).toEqual({
      content: [{ type: "text", text: "file contents" }],
      details: { path: "/tmp/a.txt", exitCode: 0, lines: [1, 2, 3], ok: true, nil: null },
    });
  });

  it("keeps the entry id stable across reads and a fresh converter (reset)", () => {
    const message = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-1",
      content: [{ type: "text", text: "x" }],
      timestamp: 1,
    };
    const first = converter().convertEntry(entry(message, "entry-9"));
    const reread = converter().convertEntry(entry(message, "entry-9"));
    const afterReset = converter().convertEntry(entry(message, "entry-9"));
    expect(first?.id).toBe("omp:s1:entry:entry-9");
    expect(reread?.id).toBe(first?.id);
    expect(afterReset?.id).toBe(first?.id);
  });
});
