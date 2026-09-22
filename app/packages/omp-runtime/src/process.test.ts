import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OmpRuntimeError } from "./errors.js";
import { OmpRuntimeProcess } from "./process.js";
import { processGroupLiveness, terminateProcessTree } from "./process-group.js";
import {
  MOCK_LAUNCHER,
  MOCK_VERSION,
  fakeVersionProbe,
  makeMockLayout,
  processAlive,
  readLog,
  recordedPids,
  removeRoot,
  startMock,
  waitFor,
} from "./test-harness.js";

/** Stop a runtime and always remove its scratch root, even when a test fails. */
async function withRuntime<T>(
  started: Awaited<ReturnType<typeof startMock>>,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    await started.process.stop().catch(() => undefined);
    removeRoot(started.layout.root);
  }
}

describe("runtime startup", () => {
  it("reaches a negotiated v2 session against the mock runtime", async () => {
    const started = await startMock("start");
    await withRuntime(started, async () => {
      const { process: runtime } = started;
      expect(runtime.protocolVersion).toBe(2);
      expect(runtime.runtimeVersion).toBe(MOCK_VERSION);
      expect(runtime.ready.supportedProtocolVersions).toEqual([1, 2]);
      expect(runtime.currentPhase).toBe("idle");
      expect(readLog(started.layout.logPath)).toContain("ready");
    });
  });

  it("refuses a runtime that reports a different version", async () => {
    const layout = makeMockLayout("version-mismatch", { version: "omp/17.0.0" });
    try {
      await expect(
        OmpRuntimeProcess.start({
          launcher: MOCK_LAUNCHER,
          cwd: layout.cwd,
          env: layout.env,
          expectedRuntimeVersion: MOCK_VERSION,
          probeVersion: fakeVersionProbe("17.0.0", "omp/17.0.0"),
        }),
      ).rejects.toMatchObject({ code: "version-mismatch" });
      // The mismatch is decided before a process exists, so nothing is running.
      expect(existsSync(layout.pidFile)).toBe(false);
    } finally {
      removeRoot(layout.root);
    }
  });

  it("refuses a runtime that does not advertise protocol v2", async () => {
    const layout = makeMockLayout("refuse-v2", { mode: "refuse-v2" });
    try {
      await expect(
        OmpRuntimeProcess.start({
          launcher: MOCK_LAUNCHER,
          cwd: layout.cwd,
          env: layout.env,
          expectedRuntimeVersion: MOCK_VERSION,
          probeVersion: fakeVersionProbe(MOCK_VERSION),
          readyTimeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "protocol-unsupported" });
      const [pid] = recordedPids(layout.pidFile);
      expect(pid).toBeDefined();
      expect(await waitFor(() => !processAlive(pid!))).toBe(true);
    } finally {
      removeRoot(layout.root);
    }
  });

  it("rejects a runtime whose framing limits differ from ours", async () => {
    const layout = makeMockLayout("framing", { mode: "framing-mismatch" });
    try {
      await expect(
        OmpRuntimeProcess.start({
          launcher: MOCK_LAUNCHER,
          cwd: layout.cwd,
          env: layout.env,
          expectedRuntimeVersion: MOCK_VERSION,
          probeVersion: fakeVersionProbe(MOCK_VERSION),
          readyTimeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "protocol-unsupported" });
      // The failed handshake must reap what it spawned.
      const [pid] = recordedPids(layout.pidFile);
      expect(pid).toBeDefined();
      expect(await waitFor(() => !processAlive(pid!))).toBe(true);
    } finally {
      removeRoot(layout.root);
    }
  });

  it("times out a runtime that never becomes ready and reaps it", async () => {
    const layout = makeMockLayout("never-ready", { mode: "never-ready" });
    try {
      await expect(
        OmpRuntimeProcess.start({
          launcher: MOCK_LAUNCHER,
          cwd: layout.cwd,
          env: layout.env,
          expectedRuntimeVersion: MOCK_VERSION,
          probeVersion: fakeVersionProbe(MOCK_VERSION),
          readyTimeoutMs: 400,
        }),
      ).rejects.toMatchObject({ code: "ready-timeout" });
      const [pid] = recordedPids(layout.pidFile);
      expect(pid).toBeDefined();
      expect(await waitFor(() => !processAlive(pid!))).toBe(true);
    } finally {
      removeRoot(layout.root);
    }
  });

  it("reports a crash before readiness as a transport failure, not a timeout", async () => {
    const layout = makeMockLayout("crash", { mode: "exit-immediately" });
    try {
      await expect(
        OmpRuntimeProcess.start({
          launcher: MOCK_LAUNCHER,
          cwd: layout.cwd,
          env: layout.env,
          expectedRuntimeVersion: MOCK_VERSION,
          probeVersion: fakeVersionProbe(MOCK_VERSION),
          readyTimeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "not-started" });
    } finally {
      removeRoot(layout.root);
    }
  });
});

describe("request lifecycle", () => {
  it("matches responses by id and forwards events", async () => {
    const started = await startMock("requests");
    await withRuntime(started, async () => {
      const events: string[] = [];
      started.process.onFrame((frame) => {
        if (frame.type === "mock_event") events.push("event");
      });
      const response = await started.process.request({ type: "mock_event" });
      expect(response).toMatchObject({ success: true, id: expect.any(String) });
      expect(events).toEqual(["event"]);
    });
  });

  it("reassembles a response larger than one line", async () => {
    const started = await startMock("chunked");
    await withRuntime(started, async () => {
      const response = await started.process.request(
        { type: "mock_large" },
        { timeoutMs: 10_000 },
      );
      expect(response.success).toBe(true);
      const payload = (response.data as { payload?: string } | undefined)?.payload ?? "";
      expect(payload.length).toBe(1_200_000);
      const diagnostics = started.process.diagnostics();
      expect(diagnostics.chunks).toBeGreaterThan(1);
    });
  });

  it("fails the stream when a chunk sequence is corrupted", async () => {
    const started = await startMock("chunk-fault");
    await withRuntime(started, async () => {
      await expect(
        started.process.request({ type: "mock_corrupt_chunk" }, { timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: "transport-failed" });
      expect(started.process.diagnostics().protocolErrors.join("|")).toContain("chunk:");
    });
  });

  it("distinguishes a real deadline from a broken stream", async () => {
    const started = await startMock("timeout");
    await withRuntime(started, async () => {
      await expect(
        started.process.request({ type: "mock_never_respond" }, { timeoutMs: 300 }),
      ).rejects.toMatchObject({ code: "request-timeout" });
      // The stream is still healthy: the timeout was its own deadline.
      expect(started.process.currentPhase).toBe("idle");
      await expect(started.process.request({ type: "abort" })).resolves.toMatchObject({
        success: true,
      });
    });
  });

  it("refuses to send a chunk frame to the runtime", async () => {
    const started = await startMock("no-inbound-chunks");
    await withRuntime(started, async () => {
      await expect(
        started.process.request({ type: "rpc_chunk", chunkId: "x", index: 0 }),
      ).rejects.toMatchObject({ code: "transport-failed" });
    });
  });

  it("settles every pending request when the runtime exits", async () => {
    const started = await startMock("exit-mid-flight");
    await withRuntime(started, async () => {
      const pending = [
        started.process.request({ type: "mock_never_respond" }, { timeoutMs: 30_000 }),
        started.process.request({ type: "mock_never_respond" }, { timeoutMs: 30_000 }),
      ];
      // Handlers attach before the stop, so a synchronous rejection during
      // teardown cannot surface as an unhandled rejection.
      const settled = Promise.allSettled(pending);
      await started.process.stop({ skipAbort: true });
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(OmpRuntimeError);
        }
      }
    });
  });

  it("reports the runtime's stderr as diagnostics only", async () => {
    const started = await startMock("stderr");
    await withRuntime(started, async () => {
      await started.process.request({ type: "stderr_noise" });
      expect(started.process.diagnostics().stderrTail).toContain("diagnostic line");
    });
  });
});

describe("stop ordering", () => {
  it("stops in protocol before breaking the bridge", async () => {
    const started = await startMock("stop-order");
    await withRuntime(started, async () => {
      const result = await started.process.stop();
      expect(result.abortAcknowledged).toBe(true);
      expect(result.reaped).toBe(true);
      const log = readLog(started.layout.logPath);
      expect(log.indexOf("abort")).toBeGreaterThan(-1);
      expect(log.indexOf("eof")).toBeGreaterThan(log.indexOf("abort"));
      expect(result.steps.join(" | ")).toContain("closed stdin");
    });
  });

  it("sends abort_bash when the caller knows a command is running", async () => {
    const started = await startMock("stop-abort-bash");
    await withRuntime(started, async () => {
      await started.process.stop({ abortBash: true });
      const log = readLog(started.layout.logPath);
      expect(log.indexOf("abort_bash")).toBeGreaterThan(log.indexOf("abort"));
      expect(log.indexOf("eof")).toBeGreaterThan(log.indexOf("abort_bash"));
    });
  });

  it("escalates to SIGKILL when the runtime ignores SIGTERM and EOF", async () => {
    const started = await startMock("stop-unresponsive", {
      mode: "deaf",
      processOptions: {
        abortSettleMs: 50,
        selfExitMs: 200,
        terminationGraceMs: 300,
        terminationKillGraceMs: 300,
      },
    });
    await withRuntime(started, async () => {
      const result = await started.process.stop();
      expect(result.escalated).toBe("kill");
      expect(result.reaped).toBe(true);
      const log = readLog(started.layout.logPath);
      expect(log).toContain("sigterm-ignored");
    });
  }, 20_000);

  it("reclaims a descendant that outlives the group leader", async () => {
    const started = await startMock("leader-exit", { mode: "detached-descendant" });
    await withRuntime(started, async () => {
      const pids = recordedPids(started.layout.pidFile);
      expect(pids.length).toBe(2);
      const leader = pids[0]!;
      const descendant = pids[1]!;
      // The leader exits on its own; the descendant keeps the group populated.
      expect(await waitFor(() => !processAlive(leader))).toBe(true);
      expect(processAlive(descendant)).toBe(true);

      const result = await started.process.stop();
      expect(result.reaped).toBe(true);
      expect(result.escalated).not.toBe("none");
      expect(await waitFor(() => !processAlive(descendant))).toBe(true);
    });
  });

  it("runs one stop sequence when several callers stop at once", async () => {
    const started = await startMock("stop-concurrent");
    await withRuntime(started, async () => {
      const results = await Promise.all([
        started.process.stop(),
        started.process.stop(),
        started.process.stop(),
      ]);
      // One abort and one EOF: three concurrent stops must not each drive the
      // child through the same sequence.
      const log = readLog(started.layout.logPath);
      expect(log.filter((entry) => entry === "abort")).toHaveLength(1);
      expect(log.filter((entry) => entry === "eof")).toHaveLength(1);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(results[0]!.reaped).toBe(true);
    });
  });

  it("does not cache a stop whose process group survived", async () => {
    const started = await startMock("stop-retry", {
      mode: "deaf",
      processOptions: {
        abortSettleMs: 50,
        selfExitMs: 100,
        terminationGraceMs: 100,
        terminationKillGraceMs: 500,
      },
    });
    await withRuntime(started, async () => {
      // The mock ignores EOF and SIGTERM. The first escalation is reported as
      // unreaped on purpose: a group that survived must stay retryable, or the
      // ownership could never be disposed of.
      let attempts = 0;
      const injected = async (child: any, pgid: number, options: any) => {
        attempts += 1;
        if (attempts === 1) return { reaped: false, escalated: "kill" as const, steps: ["injected: survived"] };
        return terminateProcessTree(child, pgid, options);
      };
      const process_ = await OmpRuntimeProcess.start({
        launcher: MOCK_LAUNCHER,
        cwd: started.layout.cwd,
        env: started.layout.env,
        expectedRuntimeVersion: MOCK_VERSION,
        probeVersion: fakeVersionProbe(MOCK_VERSION),
        readyTimeoutMs: 5_000,
        abortSettleMs: 50,
        selfExitMs: 100,
        terminationGraceMs: 100,
        terminationKillGraceMs: 500,
        terminateTree: injected,
      });
      try {
        const first = await process_.stop();
        expect(first.reaped).toBe(false);
        expect(first.escalated).toBe("kill");
        expect(process_.currentPhase).toBe("failed");
        // The retry runs the escalation again rather than returning the cached
        // failure, and this time the group is really gone.
        const second = await process_.stop();
        expect(second.reaped).toBe(true);
        expect(attempts).toBe(2);
        expect(process_.currentPhase).toBe("stopped");
      } finally {
        await process_.stop().catch(() => undefined);
        await started.process.stop().catch(() => undefined);
      }
    });
  }, 30_000);

  it("is idempotent and reports the same verdict twice", async () => {
    const started = await startMock("stop-twice");
    await withRuntime(started, async () => {
      const first = await started.process.stop();
      const second = await started.process.stop();
      expect(second).toEqual(first);
      expect(processGroupLiveness(started.process.pgid ?? 0)).toBe("empty");
    });
  });
});
