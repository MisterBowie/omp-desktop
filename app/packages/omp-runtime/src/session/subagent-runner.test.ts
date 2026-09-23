/**
 * The runner's subagent routing: subscription, per-generation attribution, the
 * live list, the bounded transcript read, and the unconditional stop refusal.
 */
import { describe, expect, it } from "vitest";

import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { OmpRuntimeError } from "../errors.js";
import type { OmpFrame } from "../protocol.js";
import { OmpSessionRunner, type OmpSessionRuntime } from "./runner.js";

class FakeRuntime implements OmpSessionRuntime {
  readonly pid = 4242;
  usable = true;
  readonly commands: string[] = [];
  /** Scripted `data` per command type, for the subagent read commands. */
  readonly dataByCommand = new Map<string, unknown>();
  private readonly frameHandlers = new Set<(frame: OmpFrame) => void>();
  private readonly failureHandlers = new Set<(error: OmpRuntimeError) => void>();

  write(frame: OmpFrame): boolean {
    return this.usable;
  }

  async request(command: OmpFrame): Promise<{ success?: boolean; error?: string; data?: unknown }> {
    this.commands.push(String(command.type));
    if (this.dataByCommand.has(String(command.type))) {
      return { success: true, data: this.dataByCommand.get(String(command.type)) };
    }
    return { success: true };
  }

  onFrame(handler: (frame: OmpFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onFailure(handler: (error: OmpRuntimeError) => void): () => void {
    this.failureHandlers.add(handler);
    return () => this.failureHandlers.delete(handler);
  }

  push(frame: Record<string, unknown>): void {
    for (const handler of [...this.frameHandlers]) handler(frame as OmpFrame);
  }
}

function harness() {
  const runtime = new FakeRuntime();
  const envelopes: AgentEventEnvelope[] = [];
  const runner = new OmpSessionRunner({
    sessionId: "s1",
    runtime,
    emit: (envelope) => envelopes.push(envelope),
    now: () => 1_000,
  });
  return { runtime, runner, envelopes };
}

const taskStart = () => ({ type: "tool_execution_start", toolCallId: "call-task-1", toolName: "task", args: { task: "t" } });

describe("subscription", () => {
  it("sends set_subagent_subscription once and reports the level", async () => {
    const { runtime, runner } = harness();
    const first = await runner.enableSubagentSubscription("events");
    expect(first.ok).toBe(true);
    expect(first.level).toBe("events");
    const second = await runner.enableSubagentSubscription("events");
    expect(second.ok).toBe(true);
    // Idempotent: one request, not two.
    expect(runtime.commands.filter((c) => c === "set_subagent_subscription")).toHaveLength(1);
  });
});

describe("late generation attribution", () => {
  it("attributes a child frame that arrives after its parent turn to the owning turn", async () => {
    const { runtime, runner, envelopes } = harness();
    const started = await runner.prompt("delegate");
    // The parent turn spawns the task tool call and its detached child.
    runtime.push(taskStart());
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" },
    });
    const turnId = started.turnId;
    expect(turnId).toBeTruthy();
    // The parent turn ends.
    runtime.push({ type: "agent_end", isTerminal: true });
    expect(runner.runState()).toBe("idle");

    // The detached child settles after its parent turn closed.
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "completed", index: 0, parentToolCallId: "call-task-1" },
    });
    const settlement = envelopes.find((e) => e.event.type === "message_end" && e.parentToolCallId === "call-task-1");
    expect(settlement).toBeTruthy();
    // The settlement carries the turn that spawned the task, not a new turn.
    expect(settlement?.turnId).toBe(turnId);
  });
});

describe("live list and transcript read", () => {
  it("lists reconciled children and refuses a malformed snapshot", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("delegate");
    runtime.dataByCommand.set("get_subagents", {
      subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" }],
    });
    const list = await runner.listSubagents();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("child-1");
    expect(list[0]).not.toHaveProperty("sessionFile");

    runtime.dataByCommand.set("get_subagents", { subagents: [{ id: "child-2", index: 0, agent: "", agentSource: "bundled", status: "running", lastUpdate: 1 }] });
    await expect(runner.listSubagents()).rejects.toThrow(OmpRuntimeError);
  });

  it("reads a bounded transcript and never discloses the native path", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("delegate");
    runtime.dataByCommand.set("get_subagent_messages", {
      sessionFile: "/abs/native/child.jsonl",
      fromByte: 0,
      nextByte: 12,
      reset: false,
      entries: [],
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    });
    const result = await runner.readSubagentTranscript("child-1");
    expect(result.cursor.nextByte).toBe(12);
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("/abs/native/child.jsonl");
  });
});

describe("stop refusal", () => {
  it("refuses a per-child stop with a typed reason", () => {
    const { runner } = harness();
    const result = runner.stopSubagent("child-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("capability-unavailable");
  });
});
