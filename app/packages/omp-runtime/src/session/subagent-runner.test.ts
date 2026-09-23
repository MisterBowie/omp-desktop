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
  /** Scripted `success: false` per command type. */
  readonly refuseByCommand = new Map<string, string>();
  private readonly frameHandlers = new Set<(frame: OmpFrame) => void>();
  private readonly failureHandlers = new Set<(error: OmpRuntimeError) => void>();

  write(frame: OmpFrame): boolean {
    return this.usable;
  }

  async request(command: OmpFrame): Promise<{ success?: boolean; error?: string; data?: unknown }> {
    this.commands.push(String(command.type));
    if (this.refuseByCommand.has(String(command.type))) {
      return { success: false, error: this.refuseByCommand.get(String(command.type)) };
    }
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

function harness(options: { teardown?: () => Promise<{ reaped: boolean; cleaned: boolean }> } = {}) {
  const runtime = new FakeRuntime();
  const envelopes: AgentEventEnvelope[] = [];
  const runner = new OmpSessionRunner({
    sessionId: "s1",
    runtime,
    emit: (envelope) => envelopes.push(envelope),
    now: () => 1_000,
    ...(options.teardown ? { teardown: () => options.teardown!() } : {}),
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

  it("fails list/read closed with a capability-unavailable error while the subscription is off", async () => {
    const { runner } = harness();
    await runner.prompt("delegate");
    // The subscription was never enabled, so the child surface must not present
    // a partial picture.
    await expect(runner.listSubagents()).rejects.toThrow(/subscription is unavailable/);
    await expect(runner.readSubagentTranscript("child-1")).rejects.toThrow(/subscription is unavailable/);
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
    // The settlement is a root Task-row refresh: no parentToolCallId on the
    // envelope, but attributed to the turn that spawned the task call.
    const settlement = envelopes.find((e) => e.event.type === "message_end" && !e.parentToolCallId && e.agentName === "task");
    expect(settlement).toBeTruthy();
    expect(settlement?.turnId).toBe(turnId);
  });

  it("attributes a child event for a known child to the old turn after a new generation starts", async () => {
    const { runtime, runner, envelopes } = harness();
    const first = await runner.prompt("delegate");
    runtime.push(taskStart());
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" },
    });
    runtime.push({ type: "agent_end", isTerminal: true });
    const second = await runner.prompt("next");
    expect(second.turnId).not.toBe(first.turnId);

    // A late child event after the new generation started must be attributed to
    // the original turn, never to the current run.
    runtime.push({
      type: "subagent_event",
      payload: { id: "child-1", event: { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "late" }], timestamp: 1_000 } } },
    });
    const row = envelopes.find((e) => e.event.type === "message_start" && e.parentToolCallId === "call-task-1");
    expect(row).toBeTruthy();
    expect(row?.turnId).toBe(first.turnId);
    expect(row?.turnId).not.toBe(second.turnId);
  });
});

describe("live list and transcript read", () => {
  it("lists reconciled children and refuses a malformed snapshot", async () => {
    const { runtime, runner } = harness();
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.push(taskStart());
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
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.dataByCommand.set("get_subagent_messages", {
      sessionFile: "/abs/native/child.jsonl",
      fromByte: 0,
      nextByte: 12,
      reset: false,
      entries: [{ type: "message", id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 } }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    });
    const result = await runner.readSubagentTranscript("child-1");
    expect(result.cursor.nextByte).toBe(12);
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("/abs/native/child.jsonl");
  });

  it("maps a toolResult entry into a tool row with a stable id", async () => {
    const { runtime, runner } = harness();
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.dataByCommand.set("get_subagent_messages", {
      sessionFile: "/abs/native/child.jsonl",
      fromByte: 0,
      nextByte: 8,
      reset: false,
      entries: [
        { type: "message", id: "tool-entry-9", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "toolResult", toolName: "read", toolCallId: "call-read", content: [{ type: "text", text: "file contents" }], timestamp: 1 } },
      ],
      messages: [],
    });
    const first = await runner.readSubagentTranscript("child-1");
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].role).toBe("tool");
    expect(first.messages[0].toolName).toBe("read");
    expect(first.messages[0].toolCallId).toBe("call-read");
    // Stable identity: a second read must not remint the row id.
    const second = await runner.readSubagentTranscript("child-1");
    expect(second.messages[0].id).toBe(first.messages[0].id);
  });

  it("rejects an over-limit or inconsistent-cursor result with a typed error", async () => {
    const { runtime, runner } = harness();
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.dataByCommand.set("get_subagent_messages", {
      sessionFile: "/abs/native/child.jsonl",
      fromByte: 10,
      nextByte: 3,
      reset: false,
      entries: [],
      messages: [],
    });
    await expect(runner.readSubagentTranscript("child-1")).rejects.toThrow(/inconsistent cursor/);
  });
});

describe("stop while a child is still running", () => {
  it("does not report clean convergence and tears down the process group", async () => {
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: true, cleaned: true };
      },
    });
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.push(taskStart());
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" },
    });
    // Stop while the parent turn is still running. The abort converges the
    // parent, but the detached child survives; the runner must tear down.
    runtime.dataByCommand.set("get_subagents", {
      subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" }],
    });
    const stopPromise = runner.stop();
    // The abort converges the parent turn; pushing agent_end closes the run,
    // which the convergence wait observes (no wall-clock wait needed).
    runtime.push({ type: "agent_end", isTerminal: true });
    const outcome = await stopPromise;
    expect(outcome.converged).toBe(false);
    expect(outcome.toreDown).toBe(true);
    expect(teardownCalls).toBe(1);
  });

  it("reports clean convergence when no child is running", async () => {
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: true, cleaned: true };
      },
    });
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    // The live snapshot is the authority for "no child": it must be queried
    // even though the local registry has no running child.
    runtime.dataByCommand.set("get_subagents", { subagents: [] });
    const stopPromise = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const outcome = await stopPromise;
    expect(outcome.converged).toBe(true);
    expect(outcome.toreDown).toBe(false);
    expect(teardownCalls).toBe(0);
    expect(runtime.commands).toContain("get_subagents");
  });

  it("queries the live snapshot after convergence even when no child lifecycle was observed", async () => {
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: true, cleaned: true };
      },
    });
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    // The parent `task` call is observed, but no child lifecycle frame arrives
    // (lost subscription / missed frame / list never opened). The snapshot is
    // the only witness of the still-running child.
    runtime.push(taskStart());
    runtime.dataByCommand.set("get_subagents", {
      subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" }],
    });
    const stopPromise = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const outcome = await stopPromise;
    expect(outcome.converged).toBe(false);
    expect(outcome.toreDown).toBe(true);
    expect(teardownCalls).toBe(1);
  });

  it("tears down conservatively when the snapshot is unavailable and a task call was observed", async () => {
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: true, cleaned: true };
      },
    });
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.push(taskStart());
    runtime.refuseByCommand.set("get_subagents", "subagent event bus is unavailable");
    const stopPromise = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const outcome = await stopPromise;
    // A task call was observed, so the process group cannot be declared
    // child-free: the runner tears down rather than claiming clean convergence.
    expect(outcome.converged).toBe(false);
    expect(outcome.toreDown).toBe(true);
    expect(outcome.steps.join(" ")).toMatch(/get_subagents refused/);
    expect(teardownCalls).toBe(1);
  });

  it("retains child ownership when teardown does not reap, so a late terminal frame is still attributed", async () => {
    let teardownCalls = 0;
    const { runtime, runner, envelopes } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: false, cleaned: false };
      },
    });
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.push(taskStart());
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" },
    });
    runtime.dataByCommand.set("get_subagents", {
      subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" }],
    });
    const stopPromise = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const outcome = await stopPromise;
    // The process group survived: teardown is not reported as done.
    expect(outcome.toreDown).toBe(false);
    expect(outcome.errors.join(" ")).toMatch(/could not be fully reclaimed/);
    // Ownership is retained: a late terminal frame is still attributed to its
    // owning turn rather than counted as an unknown parent.
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "completed", index: 0, parentToolCallId: "call-task-1" },
    });
    const settlement = envelopes.find((e) => e.event.type === "message_end" && !e.parentToolCallId && e.agentName === "task");
    expect(settlement).toBeTruthy();
  });

  it("clears child ownership once the process group is confirmed reaped", async () => {
    let teardownCalls = 0;
    const { runtime, runner, envelopes } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: true, cleaned: true };
      },
    });
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.push(taskStart());
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" },
    });
    runtime.dataByCommand.set("get_subagents", {
      subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" }],
    });
    const stopPromise = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const outcome = await stopPromise;
    expect(outcome.toreDown).toBe(true);
    // The process group is gone: a late terminal frame cannot be attributed.
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "completed", index: 0, parentToolCallId: "call-task-1" },
    });
    const settlement = envelopes.find((e) => e.event.type === "message_end" && !e.parentToolCallId && e.agentName === "task");
    expect(settlement).toBeUndefined();
    expect(runner.diagnostics().subagentDiagnostics.unknownParentCalls).toBeGreaterThan(0);
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

describe("pending reclaim retry", () => {
  /** Drive a parent turn with one observed task call and a surviving child. */
  async function startChildTurn(runtime: FakeRuntime, runner: OmpSessionRunner) {
    await runner.enableSubagentSubscription("events");
    await runner.prompt("delegate");
    runtime.push(taskStart());
    runtime.push({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "task", agentSource: "bundled", status: "started", index: 0, parentToolCallId: "call-task-1" },
    });
    runtime.dataByCommand.set("get_subagents", {
      subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" }],
    });
  }

  it("retries the same teardown on the second stop after a first failure, then reports nothing running", async () => {
    const verdicts = [
      { reaped: false, cleaned: false },
      { reaped: true, cleaned: true },
    ];
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        const verdict = verdicts[Math.min(teardownCalls, verdicts.length - 1)]!;
        teardownCalls += 1;
        return verdict;
      },
    });
    await startChildTurn(runtime, runner);

    const first = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const firstOutcome = await first;
    expect(firstOutcome.toreDown).toBe(false);
    expect(firstOutcome.converged).toBe(false);
    expect(firstOutcome.errors.join(" ")).toMatch(/could not be fully reclaimed/);
    expect(teardownCalls).toBe(1);

    // The failed teardown blocks a new prompt: the obligation is still owed.
    await expect(runner.prompt("next")).rejects.toMatchObject({ code: "stopping" });

    // The second stop re-runs the teardown instead of reporting "nothing running".
    const second = await runner.stop();
    expect(second.toreDown).toBe(true);
    expect(teardownCalls).toBe(2);

    // Once reclaimed, a third stop has nothing to do.
    const third = await runner.stop();
    expect(third.steps).toEqual(["nothing running"]);
    expect(teardownCalls).toBe(2);
  });

  it("keeps the obligation after consecutive teardown failures and keeps refusing prompts", async () => {
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        return { reaped: false, cleaned: false };
      },
    });
    await startChildTurn(runtime, runner);

    const first = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    await first;
    expect(teardownCalls).toBe(1);

    const second = await runner.stop();
    expect(second.toreDown).toBe(false);
    expect(teardownCalls).toBe(2);

    // Still owed: prompt is refused, and a third stop retries again.
    await expect(runner.prompt("next")).rejects.toMatchObject({ code: "stopping" });
    const third = await runner.stop();
    expect(teardownCalls).toBe(3);
  });

  it("retains the obligation when the teardown throws and retries it on the next stop", async () => {
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        if (teardownCalls === 1) throw new Error("teardown exploded");
        return { reaped: true, cleaned: true };
      },
    });
    await startChildTurn(runtime, runner);

    const first = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const firstOutcome = await first;
    expect(firstOutcome.toreDown).toBe(false);
    expect(firstOutcome.errors.join(" ")).toMatch(/teardown failed/);
    expect(teardownCalls).toBe(1);

    await expect(runner.prompt("next")).rejects.toMatchObject({ code: "stopping" });

    const second = await runner.stop();
    expect(second.toreDown).toBe(true);
    expect(teardownCalls).toBe(2);
  });

  it("retains the obligation when the group is reaped but the run root is not cleaned", async () => {
    const verdicts = [
      { reaped: true, cleaned: false },
      { reaped: true, cleaned: true },
    ];
    let teardownCalls = 0;
    const { runtime, runner } = harness({
      teardown: async () => {
        const verdict = verdicts[Math.min(teardownCalls, verdicts.length - 1)]!;
        teardownCalls += 1;
        return verdict;
      },
    });
    await startChildTurn(runtime, runner);

    const first = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    const firstOutcome = await first;
    // The group is gone but the directory is not: not a clean teardown.
    expect(firstOutcome.toreDown).toBe(true);
    expect(firstOutcome.errors.join(" ")).toMatch(/could not be fully reclaimed/);
    expect(teardownCalls).toBe(1);

    await expect(runner.prompt("next")).rejects.toMatchObject({ code: "stopping" });

    const second = await runner.stop();
    expect(second.toreDown).toBe(true);
    expect(teardownCalls).toBe(2);
    const third = await runner.stop();
    expect(third.steps).toEqual(["nothing running"]);
  });

  it("single-flights concurrent stops so the teardown never overlaps", async () => {
    let teardownCalls = 0;
    let releaseTeardown!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    // Resolved the moment the (blocked) teardown is invoked, so the assertion
    // below awaits the real event instead of a wall-clock tick.
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const { runtime, runner } = harness({
      teardown: async () => {
        teardownCalls += 1;
        markEntered();
        await gate;
        return { reaped: true, cleaned: true };
      },
    });
    await startChildTurn(runtime, runner);

    const first = runner.stop();
    runtime.push({ type: "agent_end", isTerminal: true });
    // While the first teardown is blocked on the gate, a second stop must share
    // the same attempt rather than start a second overlapping teardown.
    const second = runner.stop();
    await entered;
    expect(teardownCalls).toBe(1);
    releaseTeardown();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(teardownCalls).toBe(1);

    // Fully reclaimed: a prompt is allowed again and a further stop is idle.
    await expect(runner.prompt("next")).resolves.toBeTruthy();
  });
});
