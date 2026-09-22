/**
 * The runner's lifecycle rules, driven through the real transport seam.
 *
 * The fake runtime below implements the same three things the pinned process
 * does — write, request, emit frames — so these tests exercise the runner the
 * desktop will use, not a stand-in for it.
 */
import { describe, expect, it } from "vitest";

import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { OmpRuntimeError } from "../errors.js";
import type { OmpFrame } from "../protocol.js";
import { OmpSessionRunner, type OmpSessionRuntime } from "./runner.js";
import { encodeApprovalDescriptor, OMP_APPROVAL_OPTIONS } from "./approval-protocol.js";

class FakeRuntime implements OmpSessionRuntime {
  readonly pid = 4242;
  usable = true;
  readonly written: Array<Record<string, unknown>> = [];
  readonly commands: string[] = [];
  /** Answer for the next `abort`; `throw` models an unresponsive runtime. */
  abortBehaviour: "ok" | "fail" | "throw" = "ok";
  private readonly frameHandlers = new Set<(frame: OmpFrame) => void>();
  private readonly failureHandlers = new Set<(error: OmpRuntimeError) => void>();

  write(frame: OmpFrame): boolean {
    this.written.push(frame as Record<string, unknown>);
    return this.usable;
  }

  async request(command: OmpFrame): Promise<{ success?: boolean; error?: string }> {
    this.commands.push(String(command.type));
    if (command.type === "abort") {
      if (this.abortBehaviour === "throw") throw new OmpRuntimeError("request-timeout", "abort timed out");
      if (this.abortBehaviour === "fail") return { success: false, error: "nothing to abort" };
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

  fail(error: OmpRuntimeError): void {
    this.usable = false;
    for (const handler of [...this.failureHandlers]) handler(error);
  }
}

function harness(options: { teardown?: () => Promise<{ reaped: boolean; cleaned: boolean }> } = {}) {
  const runtime = new FakeRuntime();
  const envelopes: AgentEventEnvelope[] = [];
  const requests: Array<{ requestId: string; kind: string }> = [];
  const runner = new OmpSessionRunner({
    sessionId: "omp-1",
    runtime,
    emit: (envelope) => envelopes.push(envelope),
    onUiRequest: (request, info) => requests.push({ requestId: request.frameId, kind: request.kind }),
    convergeTimeoutMs: 200,
    abortTimeoutMs: 100,
    teardown: options.teardown,
  });
  return { runtime, envelopes, requests, runner };
}

function approvalFrame(id = "ui-1") {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: "write: /tmp/x",
    options: [...OMP_APPROVAL_OPTIONS],
    optionDetails: [
      {
        description: encodeApprovalDescriptor({
          v: 1,
          kind: "omp-desktop-approval",
          toolCallId: "call_1",
          toolName: "write",
          risk: "high",
          reason: "write: /tmp/x",
          argsPreview: { path: "/tmp/x" },
        }),
      },
      {},
      {},
    ],
  };
}

describe("prompting", () => {
  it("sends the prompt and reports the run with its turn identity", async () => {
    const { runtime, envelopes, runner } = harness();
    const started = await runner.prompt("hello");
    expect(runtime.commands).toEqual(["prompt"]);
    expect(started.turnId).toBe("omp-turn:omp-1:1");
    expect(runner.status()).toMatchObject({ isRunning: true, currentTurnId: started.turnId });

    runtime.push({ type: "agent_start" });
    runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    expect(envelopes.map((e) => e.event.type)).toEqual(["agent_start", "message_start"]);
    expect(envelopes.every((e) => e.sessionId === "omp-1" && e.turnId === started.turnId)).toBe(true);
  });

  it("refuses a second prompt while the first is stopping", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("one");
    runtime.abortBehaviour = "throw";
    const stop = runner.stop();
    await expect(runner.prompt("two")).rejects.toMatchObject({ code: "not-started" });
    await stop;
  });

  it("reports a refused prompt as a failure, not a run", async () => {
    const { runtime, runner } = harness();
    runtime.request = async () => ({ success: false, error: "busy" });
    await expect(runner.prompt("x")).rejects.toMatchObject({ code: "not-started" });
    expect(runner.status().isRunning).toBe(false);
  });
});

describe("run isolation", () => {
  it("counts frames that arrive after the run ended instead of emitting them", async () => {
    const { runtime, envelopes, runner } = harness();
    await runner.prompt("hello");
    runtime.push({ type: "agent_end", messages: [] });
    expect(runner.runState()).toBe("idle");
    const before = envelopes.length;
    runtime.push({ type: "tool_execution_end", toolCallId: "call_1", toolName: "write", result: {} });
    runtime.push({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "late text" },
    });
    expect(envelopes).toHaveLength(before);
    expect(runner.lateFrameCount()).toBe(2);
  });

  it("does not attribute the next run's identity to a late frame", async () => {
    const { runtime, envelopes, runner } = harness();
    await runner.prompt("first");
    runtime.push({ type: "agent_end", messages: [] });
    await runner.prompt("second");
    const secondTurnId = "omp-turn:omp-1:2";
    runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    expect(envelopes.at(-1)?.turnId).toBe(secondTurnId);
  });
});

describe("dialog handling", () => {
  it("surfaces an approval and writes the user's decision back", async () => {
    const { runtime, requests, runner } = harness();
    await runner.prompt("hello");
    runtime.push(approvalFrame());
    expect(requests).toEqual([{ requestId: "ui-1", kind: "approval" }]);
    expect(runner.status().pendingToolConfirmations).toBe(1);
    expect(runner.resolveUiRequest("ui-1", "allow-once").ok).toBe(true);
    expect(runtime.written.at(-1)).toMatchObject({
      type: "extension_ui_response",
      id: "ui-1",
      value: OMP_APPROVAL_OPTIONS[0],
    });
    expect(runner.status().pendingToolConfirmations).toBe(0);
  });

  it("refuses a duplicate decision", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("hello");
    runtime.push(approvalFrame());
    runner.resolveUiRequest("ui-1", "allow-once");
    const second = runner.resolveUiRequest("ui-1", "allow-once");
    expect(second.ok).toBe(false);
    expect(runtime.written).toHaveLength(1);
  });

  it("cancels open dialogs when the run stops", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("hello");
    runtime.push(approvalFrame("ui-1"));
    runtime.push(approvalFrame("ui-2"));
    const stop = runner.stop();
    // The turn converges only after the stop cancelled the dialogs: this is the
    // real ordering when a tool is waiting on the user and the user stops.
    setTimeout(() => runtime.push({ type: "agent_end", messages: [] }), 10);
    const outcome = await stop;
    expect(outcome.steps.join(" ")).toMatch(/cancelled 2 pending request/);
    expect(runtime.written.filter((frame) => frame.cancelled === true)).toHaveLength(2);
    expect(runner.status().pendingToolConfirmations).toBe(0);
    // A decision arriving after the stop cannot be delivered.
    expect(runner.resolveUiRequest("ui-1", "allow-once").ok).toBe(false);
  });
});

describe("stopping", () => {
  it("aborts through the protocol and converges without touching the process", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("hello");
    runtime.push({ type: "agent_start" });
    const stop = runner.stop();
    // The runtime converges while the runner waits.
    setTimeout(() => runtime.push({ type: "agent_end", messages: [] }), 10);
    const outcome = await stop;
    expect(runtime.commands).toEqual(["prompt", "abort"]);
    expect(outcome).toMatchObject({ aborted: true, converged: true, toreDown: false });
    expect(outcome.steps.join(" ")).toMatch(/abort acknowledged/);
  });

  it("sends abort_bash only while a command is still open", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("hello");
    runtime.push({ type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash", args: { command: "sleep 60" } });
    const withBash = runner.stop();
    setTimeout(() => runtime.push({ type: "agent_end", messages: [] }), 10);
    await withBash;
    expect(runtime.commands).toEqual(["prompt", "abort", "abort_bash"]);

    const second = harness();
    await second.runner.prompt("hello");
    second.runtime.push({ type: "tool_execution_start", toolCallId: "call_w", toolName: "write", args: {} });
    const stop = second.runner.stop();
    setTimeout(() => second.runtime.push({ type: "agent_end", messages: [] }), 10);
    await stop;
    expect(second.runtime.commands).toEqual(["prompt", "abort"]);
  });

  it("falls back to the process teardown when the protocol cannot converge", async () => {
    const teardowns: Array<{ abortBash: boolean }> = [];
    const { runtime, runner } = harness({
      teardown: async (options) => {
        teardowns.push(options);
        return { reaped: true, cleaned: true };
      },
    });
    await runner.prompt("hello");
    runtime.push({ type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash", args: {} });
    runtime.abortBehaviour = "throw";
    const outcome = await runner.stop();
    expect(outcome).toMatchObject({ aborted: false, converged: false, toreDown: true });
    expect(teardowns).toEqual([{ abortBash: true }]);
    expect(outcome.errors.join(" ")).toMatch(/abort failed/);
    expect(runner.runState()).toBe("idle");
  });

  it("does not tear the process down when there is nothing running", async () => {
    const teardowns: unknown[] = [];
    const { runner } = harness({
      teardown: async () => {
        teardowns.push(1);
        return { reaped: true, cleaned: true };
      },
    });
    const outcome = await runner.stop();
    expect(outcome.converged).toBe(true);
    expect(outcome.steps).toEqual(["nothing running"]);
    expect(teardowns).toEqual([]);
  });
});

describe("transport failure", () => {
  it("ends the run, cancels dialogs and reports one typed error", async () => {
    const { runtime, envelopes, runner } = harness();
    await runner.prompt("hello");
    runtime.push(approvalFrame());
    runtime.fail(new OmpRuntimeError("transport-failed", "stdout closed"));
    expect(runner.runState()).toBe("idle");
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runtime.written.at(-1)).toMatchObject({ cancelled: true });
    expect(envelopes.at(-1)?.event).toMatchObject({
      type: "error",
      error: { code: "OMP_TRANSPORT_FAILED", message: "stdout closed" },
    });
  });
});

describe("dispose", () => {
  it("cancels every dialog and stops tracking frames", async () => {
    const { runtime, envelopes, runner } = harness();
    await runner.prompt("hello");
    runtime.push(approvalFrame());
    expect(runner.dispose("window closed")).toBe(1);
    expect(runtime.written.at(-1)).toMatchObject({ cancelled: true });
    const before = envelopes.length;
    runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
    expect(envelopes).toHaveLength(before);
  });
});
