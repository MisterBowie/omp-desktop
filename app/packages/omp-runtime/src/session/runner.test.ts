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
import type { OmpUiRecord } from "./ui-requests.js";
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

  /** Raised while the prompt request is in flight, when the test wants one. */
  onPrompt: (() => void) | undefined;
  /** Verdict for the next prompt request; a throw is modelled by `promptFailure`. */
  promptResponse: { success?: boolean; error?: string } | undefined;
  promptFailure: Error | undefined;

  async request(command: OmpFrame): Promise<{ success?: boolean; error?: string }> {
    this.commands.push(String(command.type));
    if (command.type === "prompt") {
      this.onPrompt?.();
      if (this.promptFailure) throw this.promptFailure;
      if (this.promptResponse) return this.promptResponse;
    }
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

function harness(
  options: {
    teardown?: () => Promise<{ reaped: boolean; cleaned: boolean }>;
    /** Extra observers; one runtime is driven by exactly one runner. */
    onUiClosed?: (requestId: string, reason: string) => void;
    onUiRecord?: (record: OmpUiRecord) => void;
  } = {},
) {
  const runtime = new FakeRuntime();
  const envelopes: AgentEventEnvelope[] = [];
  const requests: Array<{ requestId: string; kind: string }> = [];
  const runner = new OmpSessionRunner({
    sessionId: "omp-1",
    runtime,
    emit: (envelope) => envelopes.push(envelope),
    onUiRequest: (request, info) => requests.push({ requestId: request.frameId, kind: request.kind }),
    onUiClosed: options.onUiClosed,
    onUiRecord: options.onUiRecord,
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
    // The runner always reconciles the live child snapshot after convergence,
    // even with no subagent subscription/task call observed.
    expect(runtime.commands).toEqual(["prompt", "abort", "get_subagents"]);
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
    expect(runtime.commands).toEqual(["prompt", "abort", "abort_bash", "get_subagents"]);

    const second = harness();
    await second.runner.prompt("hello");
    second.runtime.push({ type: "tool_execution_start", toolCallId: "call_w", toolName: "write", args: {} });
    const stop = second.runner.stop();
    setTimeout(() => second.runtime.push({ type: "agent_end", messages: [] }), 10);
    await stop;
    expect(second.runtime.commands).toEqual(["prompt", "abort", "get_subagents"]);
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

describe("dialog lifecycle (R1/R2)", () => {
  it("cancels the dialogs a run raised when the run ends", async () => {
    const closed: Array<{ id: string; reason: string }> = [];
    const { runtime, runner } = harness({
      onUiClosed: (requestId, reason) => closed.push({ id: requestId, reason }),
    });
    await runner.prompt("hello");
    runtime.push(approvalFrame("ui-old"));
    runtime.push({ type: "agent_end", messages: [] });
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runtime.written).toEqual([
      { type: "extension_ui_response", id: "ui-old", cancelled: true },
    ]);
    expect(closed.map((entry) => entry.id)).toEqual(["ui-old"]);
    // A decision for that dialog can no longer be delivered.
    expect(runner.resolveUiRequest("ui-old", "allow-once")).toMatchObject({ ok: false });
    expect(runtime.written).toHaveLength(1);
  });

  it("cancels leftovers before starting the next run", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("first");
    // A dialog the runtime never retracted and the run never ended around.
    runtime.push(approvalFrame("ui-left"));
    runtime.push({ type: "agent_end", messages: [] });
    await runner.prompt("second");
    // The ended run already cancelled it; the new run starts clean.
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runtime.written.filter((frame) => frame.cancelled === true)).toHaveLength(1);
  });

  it("fails one dialog closed on request, through the registry", async () => {
    const closed: string[] = [];
    const { runtime, runner } = harness({ onUiClosed: (requestId) => closed.push(requestId) });
    await runner.prompt("hello");
    runtime.push(approvalFrame("ui-1"));
    expect(runner.cancelUiRequest("ui-1", "the user skipped it")).toBe(true);
    expect(runtime.written).toEqual([
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
    ]);
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(closed).toEqual(["ui-1"]);
    expect(runner.cancelUiRequest("ui-1", "again")).toBe(false);
    expect(runtime.written).toHaveLength(1);
  });

  it("forgets a dialog the runtime retracted, and says so", async () => {
    const closed: string[] = [];
    const { runtime, runner } = harness({
      onUiClosed: (requestId, reason) => closed.push(`${requestId}:${reason}`),
    });
    await runner.prompt("hello");
    runtime.push(approvalFrame("ui-1"));
    runtime.push({ type: "extension_ui_request", id: "ui-2", method: "cancel", targetId: "ui-1" });
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(closed).toEqual(["ui-1:the runtime retracted its request"]);
    expect(runtime.written).toEqual([]);
  });
});

describe("late and failed dialog lifecycles (F1-F3)", () => {
  it("refuses a dialog that arrives after the run ended, without presenting it", async () => {
    const { runtime, requests, runner } = harness();
    await runner.prompt("hello");
    runtime.push({ type: "agent_end", messages: [] });
    expect(runner.runState()).toBe("idle");

    runtime.push(approvalFrame("ui-late"));
    runtime.push({
      type: "extension_ui_request",
      id: "q-late",
      method: "select",
      title: "Which file?",
      options: ["a.ts"],
    });

    // Nothing is presented and nothing stays answerable.
    expect(requests).toEqual([]);
    expect(runner.status().pendingToolConfirmations).toBe(0);
    // Each unanswerable dialog is refused once, immediately.
    expect(runtime.written).toEqual([
      { type: "extension_ui_response", id: "ui-late", cancelled: true },
      { type: "extension_ui_response", id: "q-late", cancelled: true },
    ]);
    // A decision arriving later cannot authorise anything.
    expect(runner.resolveUiRequest("ui-late", "allow-once")).toMatchObject({ ok: false });
    expect(runner.resolveUiRequest("q-late", "allow-once")).toMatchObject({ ok: false });
    expect(runtime.written).toHaveLength(2);
  });

  it("refuses a dialog that arrives while the run is stopping", async () => {
    const { runtime, requests, runner } = harness();
    await runner.prompt("hello");
    runtime.abortBehaviour = "ok";
    const stop = runner.stop();
    runtime.push(approvalFrame("ui-stopping"));
    runtime.push({
      type: "extension_ui_request",
      id: "q-stopping",
      method: "select",
      title: "Which file?",
      options: ["a.ts"],
    });
    setTimeout(() => runtime.push({ type: "agent_end", messages: [] }), 10);
    await stop;

    expect(requests).toEqual([]);
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runtime.written.filter((frame) => frame.id === "ui-stopping")).toEqual([
      { type: "extension_ui_response", id: "ui-stopping", cancelled: true },
    ]);
    expect(runtime.written.filter((frame) => frame.id === "q-stopping")).toEqual([
      { type: "extension_ui_response", id: "q-stopping", cancelled: true },
    ]);
    expect(runner.resolveUiRequest("ui-stopping", "allow-once")).toMatchObject({ ok: false });
  });

  it("closes the generation when the runtime refuses the prompt", async () => {
    const runtime = new FakeRuntime();
    const requests: string[] = [];
    const closed: string[] = [];
    const runner = new OmpSessionRunner({
      sessionId: "omp-1",
      runtime,
      emit: () => undefined,
      onUiRequest: (request) => requests.push(request.frameId),
      onUiClosed: (requestId) => closed.push(requestId),
      convergeTimeoutMs: 50,
      abortTimeoutMs: 50,
    });
    // The runtime raises a dialog while handling the prompt, then refuses it.
    runtime.onPrompt = () => runtime.push(approvalFrame("ui-refused"));
    runtime.promptResponse = { success: false, error: "busy" };

    await expect(runner.prompt("hello")).rejects.toMatchObject({ code: "not-started" });
    expect(runner.runState()).toBe("idle");
    expect(runner.status().isRunning).toBe(false);
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runtime.written).toEqual([
      { type: "extension_ui_response", id: "ui-refused", cancelled: true },
    ]);
    expect(closed).toEqual(["ui-refused"]);
    // A decision arriving after the refusal cannot authorise anything.
    expect(runner.resolveUiRequest("ui-refused", "allow-once")).toMatchObject({ ok: false });
    expect(runtime.written).toHaveLength(1);
    runner.dispose();
  });

  it("closes the generation when the prompt request itself throws", async () => {
    const runtime = new FakeRuntime();
    const requests: string[] = [];
    const closed: string[] = [];
    const runner = new OmpSessionRunner({
      sessionId: "omp-1",
      runtime,
      emit: () => undefined,
      onUiRequest: (request) => requests.push(request.frameId),
      onUiClosed: (requestId) => closed.push(requestId),
      convergeTimeoutMs: 50,
      abortTimeoutMs: 50,
    });
    runtime.onPrompt = () => runtime.push(approvalFrame("ui-error"));
    runtime.promptFailure = new OmpRuntimeError("request-timeout", "no response within 30000 ms");

    await expect(runner.prompt("hello")).rejects.toMatchObject({ code: "request-timeout" });
    expect(runner.runState()).toBe("idle");
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runtime.written).toEqual([
      { type: "extension_ui_response", id: "ui-error", cancelled: true },
    ]);
    expect(closed).toEqual(["ui-error"]);
    // The failure did not leave the runner unusable.
    expect(runner.resolveUiRequest("ui-error", "allow-once")).toMatchObject({ ok: false });
    runner.dispose();
  });

  it("cancels a failed prompt's dialog exactly once when a transport failure races it", async () => {
    const runtime = new FakeRuntime();
    const closed: string[] = [];
    const runner = new OmpSessionRunner({
      sessionId: "omp-1",
      runtime,
      emit: () => undefined,
      onUiClosed: (requestId) => closed.push(requestId),
      convergeTimeoutMs: 50,
      abortTimeoutMs: 50,
    });
    runtime.onPrompt = () => {
      runtime.push(approvalFrame("ui-race"));
      // The transport dies while the prompt is still unanswered.
      runtime.fail(new OmpRuntimeError("transport-failed", "stdout closed"));
    };
    runtime.promptFailure = new OmpRuntimeError("transport-failed", "stdout closed");

    await expect(runner.prompt("hello")).rejects.toBeInstanceOf(OmpRuntimeError);
    expect(runtime.written.filter((frame) => frame.id === "ui-race")).toEqual([
      { type: "extension_ui_response", id: "ui-race", cancelled: true },
    ]);
    expect(closed).toEqual(["ui-race"]);
    expect(runner.runState()).toBe("idle");
    expect(runner.status().pendingToolConfirmations).toBe(0);
    runner.dispose();
  });
});

describe("terminal signal for failed prompts (F2)", () => {
  it("tells the desktop the turn is over when a refused prompt left a card behind", async () => {
    const runtime = new FakeRuntime();
    const envelopes: AgentEventEnvelope[] = [];
    const presented: string[] = [];
    const runner = new OmpSessionRunner({
      sessionId: "omp-1",
      runtime,
      emit: (envelope) => envelopes.push(envelope),
      onUiRequest: (request) => presented.push(request.frameId),
      convergeTimeoutMs: 50,
      abortTimeoutMs: 50,
    });
    runtime.onPrompt = () => runtime.push(approvalFrame("ui-refused"));
    runtime.promptResponse = { success: false, error: "busy" };

    await expect(runner.prompt("hello")).rejects.toMatchObject({ code: "not-started" });
    // The card was presented (the bridge turns this into the renderer envelope),
    // and the failure ends the turn exactly once.
    expect(presented).toEqual(["ui-refused"]);
    expect(envelopes.map((entry) => entry.event.type)).toEqual(["error"]);
    const terminal = envelopes.at(-1)!;
    expect(terminal.sessionId).toBe("omp-1");
    expect(terminal.turnId).toBe("omp-turn:omp-1:1");
    expect(terminal.event).toMatchObject({ type: "error" });
    expect(runner.runState()).toBe("idle");
    runner.dispose();
  });

  it("stays silent when a refused prompt never showed a card", async () => {
    const runtime = new FakeRuntime();
    const envelopes: AgentEventEnvelope[] = [];
    const runner = new OmpSessionRunner({
      sessionId: "omp-1",
      runtime,
      emit: (envelope) => envelopes.push(envelope),
      convergeTimeoutMs: 50,
      abortTimeoutMs: 50,
    });
    runtime.promptResponse = { success: false, error: "busy" };
    await expect(runner.prompt("hello")).rejects.toMatchObject({ code: "not-started" });
    // The caller receives the failure; there is no card to withdraw and no turn
    // to end, so the desktop is not told twice.
    expect(envelopes).toEqual([]);
    runner.dispose();
  });

  it("emits one terminal error when the prompt failure races a transport failure", async () => {
    const runtime = new FakeRuntime();
    const envelopes: AgentEventEnvelope[] = [];
    const runner = new OmpSessionRunner({
      sessionId: "omp-1",
      runtime,
      emit: (envelope) => envelopes.push(envelope),
      convergeTimeoutMs: 50,
      abortTimeoutMs: 50,
    });
    runtime.onPrompt = () => {
      runtime.push(approvalFrame("ui-race"));
      runtime.fail(new OmpRuntimeError("transport-failed", "stdout closed"));
    };
    runtime.promptFailure = new OmpRuntimeError("transport-failed", "stdout closed");

    await expect(runner.prompt("hello")).rejects.toBeInstanceOf(OmpRuntimeError);
    expect(envelopes.filter((entry) => entry.event.type === "error")).toHaveLength(1);
    expect(runtime.written.filter((frame) => frame.id === "ui-race")).toHaveLength(1);
    expect(runner.status().pendingToolConfirmations).toBe(0);
    expect(runner.runState()).toBe("idle");
    runner.dispose();
  });

  it("does not signal anything extra for a run that ends normally", async () => {
    const { runtime, envelopes, runner } = harness();
    await runner.prompt("hello");
    runtime.push(approvalFrame("ui-ok"));
    runtime.push({ type: "agent_end", messages: [] });
    expect(envelopes.filter((entry) => entry.event.type === "error")).toEqual([]);
    expect(envelopes.filter((entry) => entry.event.type === "agent_end")).toHaveLength(1);
    // A dialog arriving after that terminal event is still refused.
    runtime.push(approvalFrame("ui-late"));
    expect(runtime.written.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "ui-late",
      cancelled: true,
    });
  });
});

describe("stop owns the prompt gate for its whole span", () => {
  /** A deferred value the test resolves at a controlled moment. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
  }

  /** A runtime whose `abort` pushes `agent_end` and whose snapshot can be held. */
  function gateRuntime(commands: string[]) {
    const handlers = new Set<(frame: OmpFrame) => void>();
    const snapshot = deferred<{ success?: boolean; error?: string; data?: unknown }>();
    const runtime: OmpSessionRuntime = {
      pid: 4242,
      usable: true,
      write: () => true,
      onFrame(handler) { handlers.add(handler); return () => handlers.delete(handler); },
      onFailure: () => () => {},
      async request(command) {
        commands.push(String(command.type));
        if (command.type === "abort") {
          // The runtime converges while the runner waits: `agent_end` closes the
          // run to idle before the stop has finished reconciling/tearing down.
          for (const handler of handlers) handler({ type: "agent_end", isTerminal: true } as OmpFrame);
        }
        if (command.type === "get_subagents") {
          return snapshot.promise;
        }
        return { success: true };
      },
    };
    return { runtime, handlers, snapshot };
  }

  function gateRunner(
    runtime: OmpSessionRuntime,
    teardown: () => Promise<{ reaped: boolean; cleaned: boolean }>,
  ): OmpSessionRunner {
    return new OmpSessionRunner({
      sessionId: "omp-gate",
      runtime,
      emit: () => undefined,
      convergeTimeoutMs: 200,
      abortTimeoutMs: 100,
      teardown,
    });
  }

  it("refuses a prompt while the stop is waiting on the live child snapshot", async () => {
    const commands: string[] = [];
    const { runtime, handlers, snapshot } = gateRuntime(commands);
    const runner = gateRunner(runtime, async () => ({ reaped: true, cleaned: true }));
    await runner.prompt("first");
    for (const handler of handlers) handler({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} } as OmpFrame);
    const stop = runner.stop();
    // `agent_end` has already closed the run to idle, but the stop is still
    // reconciling the live snapshot: the stop owns the lifecycle, not the run.
    await expect(runner.prompt("second")).rejects.toMatchObject({ code: "stopping" });
    snapshot.resolve({ success: true, data: { subagents: [] } });
    await stop;
    expect(runner.runState()).toBe("idle");
    runner.dispose();
  });

  it("refuses a prompt while the stop is waiting on the process teardown", async () => {
    const commands: string[] = [];
    const { runtime, handlers, snapshot } = gateRuntime(commands);
    const teardownGate = deferred<{ reaped: boolean; cleaned: boolean }>();
    const runner = gateRunner(runtime, async () => teardownGate.promise);
    await runner.prompt("first");
    for (const handler of handlers) handler({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} } as OmpFrame);
    const stop = runner.stop();
    // The snapshot reports a surviving child, so the stop escalates to the
    // teardown — which is held. Both windows are owned by the same stop.
    snapshot.resolve({
      success: true,
      data: { subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "task-1" }] },
    });
    await expect(runner.prompt("second")).rejects.toMatchObject({ code: "stopping" });
    teardownGate.resolve({ reaped: true, cleaned: true });
    await stop;
    expect(runner.runState()).toBe("idle");
    runner.dispose();
  });

  it("refuses a prompt during a pending-reclaim retry", async () => {
    const commands: string[] = [];
    const { runtime, handlers, snapshot } = gateRuntime(commands);
    let teardownCalls = 0;
    const retryGate = deferred<{ reaped: boolean; cleaned: boolean }>();
    const runner = gateRunner(runtime, async () => {
      teardownCalls += 1;
      if (teardownCalls === 1) return { reaped: false, cleaned: false };
      return retryGate.promise;
    });
    await runner.prompt("first");
    for (const handler of handlers) handler({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} } as OmpFrame);
    const first = runner.stop();
    snapshot.resolve({
      success: true,
      data: { subagents: [{ id: "child-1", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "task-1" }] },
    });
    await first;
    expect(teardownCalls).toBe(1);
    // The obligation is retained; the retry re-enters the teardown and owns the
    // lifecycle while it is blocked there.
    const retry = runner.stop();
    await expect(runner.prompt("next")).rejects.toMatchObject({ code: "stopping" });
    retryGate.resolve({ reaped: true, cleaned: true });
    await retry;
    expect(teardownCalls).toBe(2);
    // Fully reclaimed: a prompt is allowed again and owns the fresh generation.
    const started = await runner.prompt("after");
    expect(started.generation).toBe(2);
    runner.dispose();
  });

  it("an agent_end during the stop never closes a run started after it", async () => {
    const commands: string[] = [];
    const { runtime, handlers, snapshot } = gateRuntime(commands);
    const runner = gateRunner(runtime, async () => ({ reaped: true, cleaned: true }));
    const started = await runner.prompt("first");
    expect(started.generation).toBe(1);
    for (const handler of handlers) handler({ type: "tool_execution_start", toolName: "task", toolCallId: "task-1", args: {} } as OmpFrame);
    // The abort fires `agent_end`, closing generation 1 while the stop continues.
    const stop = runner.stop();
    snapshot.resolve({ success: true, data: { subagents: [] } });
    await stop;
    // The stopped run's completion is spent; the next prompt owns the runner.
    const second = await runner.prompt("second");
    expect(second.generation).toBe(2);
    expect(runner.runState()).toBe("running");
    expect(runner.status().currentTurnId).toBe(second.turnId);
    expect(commands).toEqual(["prompt", "abort", "get_subagents", "prompt"]);
    runner.dispose();
  });
});
