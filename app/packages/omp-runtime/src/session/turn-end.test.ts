/**
 * The runner's turn-end announcements (M5/T19-B): exactly one per generation,
 * with the reason decided by the runner's own close path — never guessed from
 * ordinary envelopes.
 *
 *   - a normal `agent_end` closes the run as "completed";
 *   - an `agent_end` that arrives while the run is stopping closes "aborted";
 *   - a stop whose run had to be torn down closes "aborted";
 *   - a prompt or transport failure closes "error" — including a prompt RPC
 *     failure that presented no dialog and therefore emits no envelope;
 *   - a converter error mid-run is NOT a turn end (the run continues);
 *   - a dispose with a live turn closes "aborted";
 *   - a throwing announcement callback never blocks the close or the fan-out.
 */
import { describe, expect, it } from "vitest";

import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { OmpRuntimeError } from "../errors.js";
import type { OmpFrame } from "../protocol.js";
import { OmpSessionRunner, type OmpSessionRuntime } from "./runner.js";

type TurnEnd = { sessionId: string; turnId: string; reason: "completed" | "aborted" | "error" };

class FakeRuntime implements OmpSessionRuntime {
  readonly pid = 4242;
  usable = true;
  readonly commands: string[] = [];
  abortBehaviour: "ok" | "fail" = "ok";
  promptFailure: Error | undefined;
  private readonly frameHandlers = new Set<(frame: OmpFrame) => void>();
  private readonly failureHandlers = new Set<(error: OmpRuntimeError) => void>();

  write(frame: OmpFrame): boolean {
    return this.usable;
  }

  async request(command: OmpFrame): Promise<{ success?: boolean; error?: string }> {
    this.commands.push(String(command.type));
    if (command.type === "prompt") {
      if (this.promptFailure) throw this.promptFailure;
      return { success: true };
    }
    if (command.type === "abort") {
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

function harness(options: { throwing?: boolean } = {}) {
  const runtime = new FakeRuntime();
  const envelopes: AgentEventEnvelope[] = [];
  const turns: TurnEnd[] = [];
  const state = { attempts: 0 };
  const runner = new OmpSessionRunner({
    sessionId: "omp-1",
    runtime,
    emit: (envelope) => envelopes.push(envelope),
    convergeTimeoutMs: 200,
    abortTimeoutMs: 100,
    onTurnEnd: (info) => {
      // The throwing consumer counts the attempt before throwing, the way a
      // failed broadcast would: the runner must still complete the close.
      state.attempts += 1;
      if (options.throwing) throw new Error("announcement failed");
      turns.push(info);
    },
  });
  return { runtime, envelopes, turns, attempts: () => state.attempts, runner };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("turn-end announcements", () => {
  it("a normal agent_end announces completed exactly once", async () => {
    const { runtime, turns, runner } = harness();
    const started = await runner.prompt("hello");
    runtime.push({ type: "agent_start" });
    runtime.push({ type: "agent_end", messages: [] });
    runtime.push({ type: "agent_end", messages: [] });
    await settle();

    expect(turns).toEqual([
      { sessionId: "omp-1", turnId: started.turnId, reason: "completed" },
    ]);
  });

  it("a converter error mid-run is not a turn end and the run continues", async () => {
    const { runtime, turns, runner } = harness();
    await runner.prompt("hello");
    // `tool_execution_start` without a toolCallId makes the converter throw:
    // the runner emits an error envelope but the run stays alive.
    runtime.push({ type: "tool_execution_start", toolName: "write" });
    await settle();

    expect(turns).toHaveLength(0);
    expect(runner.runState()).toBe("running");
    runtime.push({ type: "agent_end", messages: [] });
    await settle();
    expect(turns.map((turn) => turn.reason)).toEqual(["completed"]);
  });

  it("a prompt RPC failure that presented no dialog still announces error", async () => {
    const { runtime, turns, runner } = harness();
    runtime.promptFailure = new OmpRuntimeError("not-started", "the runtime refused the prompt");
    await expect(runner.prompt("hello")).rejects.toBeInstanceOf(OmpRuntimeError);
    await settle();

    // The run was closed without any dialog and without a terminal envelope;
    // the plugin lifecycle must still learn the turn ended as an error.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.reason).toBe("error");
    expect(turns[0]?.sessionId).toBe("omp-1");
  });

  it("a transport failure announces error exactly once", async () => {
    const { runtime, turns, runner } = harness();
    await runner.prompt("hello");
    runtime.fail(new OmpRuntimeError("transport-failed", "stream broken"));
    await settle();
    runtime.fail(new OmpRuntimeError("transport-failed", "stream broken"));
    await settle();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.reason).toBe("error");
  });

  it("a stop whose run settles with agent_end announces aborted, not completed", async () => {
    const { runtime, turns, runner } = harness();
    await runner.prompt("hello");
    const stopping = runner.stop();
    // The runtime acknowledges the abort and then settles the turn: the stop
    // intent, not the late agent_end, decides the reason.
    runtime.push({ type: "agent_end", messages: [] });
    await stopping;

    expect(turns).toHaveLength(1);
    expect(turns[0]?.reason).toBe("aborted");
  });

  it("a stop whose run had to be torn down announces aborted exactly once", async () => {
    const { runtime, turns, runner } = harness();
    await runner.prompt("hello");
    await runner.stop();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.reason).toBe("aborted");
  });

  it("a dispose with a live turn announces aborted exactly once", async () => {
    const { turns, runner } = harness();
    await runner.prompt("hello");
    runner.dispose("the session was closed");
    runner.dispose("the session was closed");

    expect(turns).toHaveLength(1);
    expect(turns[0]?.reason).toBe("aborted");
  });

  it("a throwing announcement never blocks the close or the event fan-out", async () => {
    const { runtime, envelopes, turns, attempts, runner } = harness({ throwing: true });
    await runner.prompt("hello");
    runtime.push({ type: "agent_end", messages: [] });
    await settle();

    expect(attempts()).toBe(1, "the announcement must be attempted exactly once, and the throw observed");
    expect(turns).toHaveLength(0, "the throwing callback records nothing");
    expect(envelopes.some((envelope) => envelope.event.type === "agent_end")).toBe(true);
    expect(runner.runState()).toBe("idle");
  });

  it("repeated terminals for later generations are the only ones announced", async () => {
    const { runtime, turns, runner } = harness();
    await runner.prompt("first");
    runtime.push({ type: "agent_end", messages: [] });
    await settle();
    await runner.prompt("second");
    runtime.push({ type: "agent_end", messages: [] });
    await settle();

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.reason)).toEqual(["completed", "completed"]);
    expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(2);
  });
});
