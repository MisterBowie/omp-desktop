import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pi-desktop/shared";
import type { OmpSessionRuntime } from "./runner.js";
import { OmpManualCompaction } from "./compaction.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(request: OmpSessionRuntime["request"]) {
  const events: AgentEvent[] = [];
  const runtime: OmpSessionRuntime = {
    pid: 1, usable: true, request,
    write: () => true, onFrame: () => () => {}, onFailure: () => () => {},
  };
  const reclaim = vi.fn(async () => ({ reaped: true, cleaned: true }));
  const control = new OmpManualCompaction({ emit: (event) => events.push(event), reclaim, timeoutMs: 10 });
  return { control, events, runtime, reclaim };
}

describe("manual OMP compaction ownership", () => {
  it("blocks reuse after an uncertain request until a failed reclamation is retried", async () => {
    const h = harness(async () => { throw new Error("transport timeout"); });
    h.reclaim.mockResolvedValueOnce({ reaped: false, cleaned: false });
    await expect(h.control.run(async () => h.runtime)).rejects.toMatchObject({ errorCode: "CONTEXT_COMPACTION_FAILED" });
    expect(h.control.busy).toBe(true);
    await expect(h.control.run(async () => h.runtime)).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
    expect((await h.control.stop()).toreDown).toBe(true);
    expect(h.control.busy).toBe(false);
  });
  it("finishes the manual UI lifecycle without creating a prompt or a host turn", async () => {
    const commands: string[] = [];
    const h = harness(async (command) => { commands.push(String(command.type)); return { success: true }; });
    await expect(h.control.run(async () => h.runtime)).resolves.toEqual({ accepted: true });
    expect(commands).toEqual(["compact"]);
    expect(h.events).toEqual([
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", ok: true, willRetry: false },
    ]);
    expect(h.control.busy).toBe(false);
  });

  it("refuses overlap and never submits a compaction cancelled during startup", async () => {
    const ready = deferred<OmpSessionRuntime>();
    const request = vi.fn(async () => ({ success: true }));
    const h = harness(request);
    const operation = h.control.run(() => ready.promise);
    const rejected = expect(operation).rejects.toMatchObject({ errorCode: "CONTEXT_COMPACTION_FAILED" });
    await expect(h.control.run(async () => h.runtime)).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
    const stop = h.control.stop();
    ready.resolve(h.runtime);
    await rejected;
    expect((await stop).converged).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ type: "compaction_end", ok: false });
  });

  it("uses native abort and rejects a late successful compact response after cancellation", async () => {
    const response = deferred<{ success: true }>();
    const submitted = deferred<void>();
    const commands: string[] = [];
    const h = harness(async (command) => {
      commands.push(String(command.type));
      if (command.type === "compact") { submitted.resolve(); return response.promise; }
      response.resolve({ success: true });
      return { success: true };
    });
    const operation = h.control.run(async () => h.runtime);
    const rejected = expect(operation).rejects.toMatchObject({ errorCode: "CONTEXT_COMPACTION_FAILED" });
    await submitted.promise;
    expect((await h.control.stop()).converged).toBe(true);
    await rejected;
    expect(commands).toEqual(["compact", "abort"]);
    expect(h.reclaim).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ ok: false });
  });

  it("reclaims an unresponsive process and keeps admission closed until its request settles", async () => {
    vi.useFakeTimers();
    try {
      const response = deferred<{ success: true }>();
      const submitted = deferred<void>();
      const h = harness(async (command) => {
        if (command.type === "compact") { submitted.resolve(); return response.promise; }
        return { success: false };
      });
      const operation = h.control.run(async () => h.runtime);
      const rejected = expect(operation).rejects.toMatchObject({ errorCode: "CONTEXT_COMPACTION_FAILED" });
      await submitted.promise;
      const stop = h.control.stop();
      await vi.advanceTimersByTimeAsync(10);
      expect((await stop).toreDown).toBe(true);
      expect(h.control.busy).toBe(true);
      response.resolve({ success: true });
      await rejected;
      expect(h.control.busy).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
