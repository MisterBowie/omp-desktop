/**
 * The subagent registry: live identity, per-child conversion, attribution, and
 * the settlement syntheses that feed the existing Pi delegation renderer.
 */
import { describe, expect, it } from "vitest";

import { SubagentTracker } from "./subagents.js";

function tracker(now = 1_000) {
  return new SubagentTracker({ sessionId: "s1", now: () => now });
}

const childEvent = (type: string, message: Record<string, unknown> = {}) => ({
  id: "child-1",
  event: { type, ...(Object.keys(message).length ? { message } : {}) },
});

describe("lifecycle registration and settlement", () => {
  it("registers a started child without emitting a settlement", () => {
    const t = tracker();
    const syntheses = t.handleLifecycle({
      id: "child-1", agent: "scout", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1",
    });
    expect(syntheses).toHaveLength(0);
    expect(t.list()).toEqual([
      expect.objectContaining({ id: "child-1", agent: "scout", status: "running", parentToolCallId: "call-task-1" }),
    ]);
  });

  it("emits a terminal settlement attributed to the parent task call", () => {
    const t = tracker();
    t.handleLifecycle({ id: "child-1", agent: "scout", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" });
    const syntheses = t.handleLifecycle({ id: "child-1", agent: "scout", agentSource: "bundled", status: "completed", index: 0, parentToolCallId: "call-task-1" });
    expect(syntheses).toHaveLength(1);
    const synthesis = syntheses[0];
    expect(synthesis.parentToolCallId).toBe("call-task-1");
    expect(synthesis.agentName).toBe("scout");
    expect(synthesis.event.type).toBe("message_end");
    const message = (synthesis.event as { message: { toolResult: { details: Record<string, unknown> } } }).message;
    expect(message.toolResult.details).toMatchObject({ delegationId: "child-1", agent: "scout", status: "completed" });
  });

  it("tracks a terminal frame for a child it never saw start, without a settlement", () => {
    const t = tracker();
    const syntheses = t.handleLifecycle({ id: "child-2", agent: "scout", agentSource: "bundled", status: "failed", index: 0, parentToolCallId: "call-task-2" });
    expect(syntheses).toHaveLength(0);
    expect(t.list()[0]).toMatchObject({ id: "child-2", status: "failed" });
  });
});

describe("progress and event attribution", () => {
  it("ignores progress for an unknown child", () => {
    const t = tracker();
    t.handleProgress({
      index: 0, agent: "scout", agentSource: "bundled", task: "t", parentToolCallId: "call-task-1",
      progress: { index: 0, id: "ghost", agent: "scout", agentSource: "bundled", status: "running", task: "t" },
    });
    expect(t.diagnostics().orphanProgress).toBe(1);
  });

  it("converts a child event through its own converter and stamps attribution", () => {
    const t = tracker();
    t.handleLifecycle({ id: "child-1", agent: "scout", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" });
    const rows = t.handleEvent(childEvent("message_start", { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1_000 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].parentToolCallId).toBe("call-task-1");
    expect(rows[0].agentName).toBe("scout");
    expect(rows[0].event.type).toBe("message_start");
    const message = (rows[0].event as { message: { parentToolCallId?: string; agentName?: string } }).message;
    expect(message.parentToolCallId).toBe("call-task-1");
    expect(message.agentName).toBe("scout");
  });

  it("refuses a child event whose id has no owning record", () => {
    const t = tracker();
    expect(t.handleEvent(childEvent("message_start", { role: "assistant", content: "hi" }))).toHaveLength(0);
    expect(t.diagnostics().orphanEvents).toBe(1);
  });

  it("drops session-level frames from the child stream", () => {
    const t = tracker();
    t.handleLifecycle({ id: "child-1", agent: "scout", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" });
    expect(t.handleEvent(childEvent("agent_end"))).toHaveLength(0);
    expect(t.handleEvent(childEvent("turn_end"))).toHaveLength(0);
    expect(t.handleEvent(childEvent("agent_start"))).toHaveLength(0);
  });
});

describe("snapshot reconciliation and dedup", () => {
  const snapshot = (id: string, status: "running" | "completed" | "failed" | "aborted") => ({
    id, index: 0, agent: "scout", agentSource: "bundled" as const, status, lastUpdate: 2, parentToolCallId: "call-task-1",
  });

  it("repairs a missed started frame and emits a settlement", () => {
    const t = tracker();
    const syntheses = t.reconcile([snapshot("child-1", "running")]);
    expect(syntheses).toHaveLength(1);
    expect(t.list()).toEqual([expect.objectContaining({ id: "child-1", status: "running" })]);
  });

  it("does not duplicate a child already known", () => {
    const t = tracker();
    t.reconcile([snapshot("child-1", "running")]);
    t.reconcile([snapshot("child-1", "running")]);
    expect(t.list()).toHaveLength(1);
  });

  it("never exposes a native sessionFile through list()", () => {
    const t = tracker();
    t.reconcile([{ ...snapshot("child-1", "running"), sessionFile: "/abs/native/child.jsonl" }]);
    const entry = t.list()[0];
    expect(entry).not.toHaveProperty("sessionFile");
    expect(JSON.stringify(entry)).not.toContain("/abs/native/child.jsonl");
  });
});

describe("task result augmentation", () => {
  it("stamps delegation fields onto the task result details", () => {
    const t = tracker();
    t.handleLifecycle({ id: "child-1", agent: "scout", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" });
    const result = t.augmentTaskResult("call-task-1", { content: [], details: { totalDurationMs: 5 } });
    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.delegationId).toBe("child-1");
    expect(details.agent).toBe("scout");
    expect(details.status).toBe("running");
  });

  it("leaves an unrelated tool result untouched", () => {
    const t = tracker();
    const result = { content: [], details: { totalDurationMs: 5 } };
    expect(t.augmentTaskResult("call-read", result)).toBe(result);
  });

  it("falls back to the result's own progress entries when no live child is known", () => {
    const t = tracker();
    const result = t.augmentTaskResult("call-task-9", {
      content: [],
      details: { progress: [{ id: "child-x", agent: "scout", agentSource: "bundled", status: "running", task: "t" }] },
    });
    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.delegationId).toBe("child-x");
    expect(details.status).toBe("running");
  });
});

describe("reset boundary", () => {
  it("forgets every child and task call on reset", () => {
    const t = tracker();
    t.observeTaskStart("call-task-1", { task: "t" });
    t.handleLifecycle({ id: "child-1", agent: "scout", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" });
    t.reset();
    expect(t.list()).toHaveLength(0);
    expect(t.lookup("child-1")).toBeUndefined();
  });
});
