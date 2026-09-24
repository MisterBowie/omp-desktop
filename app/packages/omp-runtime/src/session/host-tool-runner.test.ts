/**
 * T19-B probes: the runner must serve `host_tool_call` frames and correlate
 * `host_tool_cancel`, instead of letting both fall into the event converter.
 *
 * These probes run against the runner as it exists on the T19-B baseline
 * (`93ee82b`): the executor seam is passed as a plain option and the baseline
 * runner is expected to ignore it, so every assertion below fails on real,
 * observable behavior — the frame is counted as unmapped, no result is ever
 * written, and no pending execution is aborted on stop/dispose/transport
 * failure. Red output is the baseline's behavior, recorded before the
 * implementation landed.
 */
import { describe, expect, it } from "vitest";

import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { OmpRuntimeError } from "../errors.js";
import type { OmpFrame } from "../protocol.js";
import { OmpSessionRunner, type OmpSessionRuntime } from "./runner.js";

/** The injected seam: one recorded call per execution attempt. */
type RecordedExecution = {
  call: { id: string; toolCallId: string; toolName: string; arguments: unknown };
  run: { sessionId: string; turnId: string; generation: number } | null;
  signal: AbortSignal;
};

class FakeRuntime implements OmpSessionRuntime {
  readonly pid = 4242;
  usable = true;
  readonly written: Array<Record<string, unknown>> = [];
  readonly commands: string[] = [];
  private readonly frameHandlers = new Set<(frame: OmpFrame) => void>();
  private readonly failureHandlers = new Set<(error: OmpRuntimeError) => void>();

  write(frame: OmpFrame): boolean {
    this.written.push(frame as Record<string, unknown>);
    return this.usable;
  }

  async request(command: OmpFrame): Promise<{ success?: boolean; error?: string }> {
    this.commands.push(String(command.type));
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

function hostCallFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "host_tool_call",
    id: "host-1",
    toolCallId: "tc-1",
    toolName: "plugin_demo_echo",
    arguments: { text: "from-model" },
    ...overrides,
  };
}

function hostCancelFrame(overrides: Record<string, unknown> = {}) {
  return { type: "host_tool_cancel", id: "cancel-1", targetId: "host-1", ...overrides };
}

type ProbeHarness = {
  runtime: FakeRuntime;
  executions: RecordedExecution[];
  runner: OmpSessionRunner;
};

function harness(options: { blocking?: boolean } = {}): ProbeHarness {
  const runtime = new FakeRuntime();
  const executions: RecordedExecution[] = [];
  const runner = new OmpSessionRunner({
    sessionId: "omp-1",
    runtime,
    emit: () => undefined,
    convergeTimeoutMs: 200,
    abortTimeoutMs: 100,
    // The T19-B seam. The baseline runner ignores this option; the probe
    // asserts the behavior that only exists once the runner consumes it.
    hostToolExecutor: {
      execute: async (call, run, signal) => {
        executions.push({ call, run, signal });
        if (options.blocking) {
          // Stay pending until the signal fires; an abort surfaces as an
          // error, the way a cancelled plugin tool does.
          const { promise, reject } = Promise.withResolvers<never>();
          const onAbort = () => reject(new Error(`aborted: ${String(signal.reason ?? "cancelled")}`));
          signal.addEventListener("abort", onAbort, { once: true });
          return promise;
        }
        // Resolve only when the signal has not fired.
        const { promise, resolve, reject } = Promise.withResolvers<{
          content: Array<{ type: "text"; text: string }>;
        }>();
        const onAbort = () => reject(new Error(`aborted: ${String(signal.reason ?? "cancelled")}`));
        signal.addEventListener("abort", onAbort, { once: true });
        setImmediate(() => {
          signal.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text", text: `echo:${String(call.arguments?.text ?? "")}` }] });
        });
        return promise;
      },
    },
  });
  return { runtime, executions, runner };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("host tool frames (T19-B probe)", () => {
  it("a host_tool_call frame is executed exactly once and answered with a host_tool_result", async () => {
    const { runtime, executions, runner } = harness();
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    await settle();

    expect(executions).toHaveLength(1);
    expect(executions[0]?.call.toolName).toBe("plugin_demo_echo");
    expect(executions[0]?.call.arguments).toEqual({ text: "from-model" });
    expect(executions[0]?.run?.sessionId).toBe("omp-1");
    const results = runtime.written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("host-1");
    expect(results[0]?.result?.content?.[0]?.text).toBe("echo:from-model");
  });

  it("the frame never falls through to the event converter", async () => {
    const { runtime, runner } = harness();
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    await settle();

    const unmapped = runner.diagnostics().conversion.unmappedFrames;
    expect(unmapped["host_tool_call"]).toBeUndefined();
    expect(unmapped["host_tool_cancel"]).toBeUndefined();
  });

  it("a duplicate frame (same id) executes at most once", async () => {
    const { runtime, executions, runner } = harness();
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    runtime.push(hostCallFrame());
    runtime.push(hostCallFrame({ id: "host-1" }));
    await settle();

    expect(executions).toHaveLength(1);
    expect(runtime.written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(1);
  });

  it("a host_tool_cancel frame correlates to the pending call and aborts it without a result", async () => {
    const { runtime, executions, runner } = harness({ blocking: true });
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    await settle();
    runtime.push(hostCancelFrame());
    await settle();

    expect(executions[0]?.signal.aborted).toBe(true);
    expect(runtime.written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(0);
    expect(runner.diagnostics().conversion.unmappedFrames["host_tool_cancel"]).toBeUndefined();
  });

  it("a cancel for an unknown targetId is a no-op", async () => {
    const { runtime, executions, runner } = harness();
    await runner.prompt("call the desktop tool");
    runtime.push(hostCancelFrame({ targetId: "never-issued" }));
    await settle();

    expect(executions).toHaveLength(0);
    expect(runtime.written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(0);
    expect(runner.diagnostics().conversion.unmappedFrames["host_tool_cancel"]).toBeUndefined();
  });

  it("a call with no active run is answered isError and never executed", async () => {
    const { runtime, executions, runner } = harness();
    runtime.push(hostCallFrame());
    await settle();

    expect(executions).toHaveLength(0);
    const results = runtime.written.filter((frame) => frame.type === "host_tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("host-1");
    expect(results[0]?.isError).toBe(true);
  });

  it("stop aborts every pending host tool execution", async () => {
    const { runtime, executions, runner } = harness({ blocking: true });
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    await settle();

    await runner.stop();
    expect(executions[0]?.signal.aborted).toBe(true);
    expect(runtime.written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(0);
  });

  it("transport failure aborts every pending host tool execution", async () => {
    const { runtime, executions, runner } = harness({ blocking: true });
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    await settle();

    runtime.fail(new OmpRuntimeError("transport-failed", "stream broken"));
    await settle();
    expect(executions[0]?.signal.aborted).toBe(true);
  });

  it("dispose aborts every pending host tool execution", async () => {
    const { runtime, executions, runner } = harness({ blocking: true });
    await runner.prompt("call the desktop tool");
    runtime.push(hostCallFrame());
    await settle();

    runner.dispose("the session was closed");
    expect(executions[0]?.signal.aborted).toBe(true);
    expect(runtime.written.filter((frame) => frame.type === "host_tool_result")).toHaveLength(0);
  });
});
