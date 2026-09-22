/**
 * Lifecycle tests for ownership retention (review R4/R5).
 *
 * These drive the supervisor through states a real child cannot be forced into
 * — a process group that survives SIGKILL, a stop racing a start — by injecting
 * the runtime handle. The alternative (a child that ignores SIGKILL) does not
 * exist, and asserting the state machine by reading the source would not prove
 * that ownership survives.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OmpRuntimeError } from "./errors.js";
import {
  OmpRuntimeSupervisor,
  RUN_ROOT_PREFIX,
  ownsRun,
  type ManagedOmpRuntime,
  type OmpRuntimeSupervisorOptions,
  type OwnedOmpRuntime,
} from "./supervisor.js";
import {
  OmpRuntimeProcess,
  startupFailureOwnership,
  type OmpRuntimeProcessOptions,
  type OmpStopOptions,
  type OmpStopResult,
} from "./process.js";
import { terminateProcessTree } from "./process-group.js";
import {
  MOCK_LAUNCHER,
  MOCK_VERSION,
  fakeVersionProbe,
  makeRoot,
  mockPathEntries,
  processAlive,
  waitFor,
} from "./test-harness.js";
import { OMP_RUNTIME_VERSION } from "@pi-desktop/shared";

const created: string[] = [];
const supervisors: OmpRuntimeSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.reclaimAll().catch(() => undefined);
  }
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stopResult(overrides: Partial<OmpStopResult> = {}): OmpStopResult {
  return {
    reaped: true,
    escalated: "none",
    steps: ["fake stop"],
    abortAcknowledged: true,
    errors: [],
    ...overrides,
  };
}

/** A runtime handle whose stop verdict the test controls, call by call. */
class FakeRuntime implements ManagedOmpRuntime {
  readonly pid = 4242;
  readonly pgid = 4242;
  currentPhase: "idle" | "failed" = "idle";
  readonly runtimeVersion = MOCK_VERSION;
  readonly protocolVersion = 2;
  stopCalls = 0;
  lastOptions: OmpStopOptions | undefined;

  constructor(private readonly verdicts: OmpStopResult[]) {}

  async stop(options: OmpStopOptions = {}): Promise<OmpStopResult> {
    this.stopCalls += 1;
    this.lastOptions = options;
    const verdict = this.verdicts[Math.min(this.stopCalls - 1, this.verdicts.length - 1)]!;
    if (!verdict.reaped) this.currentPhase = "failed";
    return verdict;
  }
}

function supervisorWithRuntime(
  verdicts: OmpStopResult[],
  options: Partial<OmpRuntimeSupervisorOptions> = {},
): { supervisor: OmpRuntimeSupervisor; dataRoot: string; runtime: FakeRuntime } {
  const dataRoot = makeRoot("lifecycle");
  created.push(dataRoot);
  const runtime = new FakeRuntime(verdicts);
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot,
    // The launcher must resolve; the injected factory never runs it.
    launcherPath: MOCK_LAUNCHER,
    expectedRuntimeVersion: OMP_RUNTIME_VERSION,
    pathEntries: mockPathEntries(),
    runtimeFactory: async (runtimeOptions: OmpRuntimeProcessOptions) => {
      // The run root the supervisor made must exist before ownership is taken.
      mkdirSync(runtimeOptions.cwd, { recursive: true });
      writeFileSync(join(runtimeOptions.cwd, "marker"), "x");
      return runtime;
    },
    ...options,
  });
  supervisors.push(supervisor);
  return { supervisor, dataRoot, runtime };
}

function runRoots(dataRoot: string): string[] {
  const base = join(dataRoot, "omp-runtime");
  try {
    return readdirSync(base).filter((entry) => entry.startsWith(RUN_ROOT_PREFIX));
  } catch {
    return [];
  }
}

describe("ownership after a failed reclaim", () => {
  it("keeps the runtime and its directory when the process group survives", async () => {
    const { supervisor, dataRoot, runtime } = supervisorWithRuntime([
      stopResult({ reaped: false, errors: ["runtime process group is still populated after SIGKILL"] }),
    ]);
    await supervisor.start();
    const runRoot = runRoots(dataRoot)[0];
    expect(runRoot).toBeDefined();

    const result = await supervisor.stop();
    expect(result).toMatchObject({ stopped: false, reaped: false, cleaned: false });
    expect(result.errors.join(" ")).toContain("still populated");
    // Ownership survives: the directory a live process uses is not deleted, and
    // the status does not pretend the run ended.
    expect(runRoots(dataRoot)).toEqual([runRoot]);
    expect(supervisor.status().phase).toBe("failed");
    expect(supervisor.status().reason).toBe("unreclaimed");
    expect(supervisor.liveCapabilities().prompt).toBe(false);
  });

  it("refuses to start a second runtime while the previous one is unreclaimed", async () => {
    const { supervisor } = supervisorWithRuntime([stopResult({ reaped: false })]);
    await supervisor.start();
    await supervisor.stop();
    await expect(supervisor.start()).rejects.toBeInstanceOf(OmpRuntimeError);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "not-started" });
  });

  it("retries the stop, and only removes the directory once the group is gone", async () => {
    const { supervisor, dataRoot, runtime } = supervisorWithRuntime([
      stopResult({ reaped: false }),
      stopResult({ reaped: true, escalated: "kill" }),
    ]);
    await supervisor.start();
    const runRoot = runRoots(dataRoot)[0];
    expect((await supervisor.stop()).reaped).toBe(false);
    expect(runRoots(dataRoot)).toEqual([runRoot]);

    const retry = await supervisor.stop();
    expect(retry).toMatchObject({ stopped: true, reaped: true, cleaned: true });
    expect(runtime.stopCalls).toBe(2);
    expect(runRoots(dataRoot)).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
  });

  it("reclaims a retained run through reclaimAll by re-terminating its group", async () => {
    const { supervisor, dataRoot } = supervisorWithRuntime([stopResult({ reaped: false })], {
      // The group never confirms as empty, so the obligation must survive the
      // sweep rather than being cleaned on an optimistic verdict.
      terminateTree: async () => ({
        reaped: false,
        escalated: "kill" as const,
        steps: ["injected: survived"],
      }),
    });
    await supervisor.start();
    await supervisor.stop();
    expect(runRoots(dataRoot)).toHaveLength(1);

    const results = await supervisor.reclaimAll();
    // The retained run is retried: this fake still refuses to reap, so the
    // directory must stay and the record must remain for the next attempt.
    expect(results.some((entry) => entry.reaped === false && entry.cleaned === false)).toBe(true);
    expect(runRoots(dataRoot)).toHaveLength(1);

    const again = await supervisor.reclaimAll();
    expect(again.every((entry) => entry.cleaned === false)).toBe(true);
    expect(runRoots(dataRoot)).toHaveLength(1);
  });

  it("reports a directory that could not be removed and keeps retrying it", async () => {
    const dataRoot = makeRoot("lifecycle-dir");
    created.push(dataRoot);
    const runtime = new FakeRuntime([stopResult()]);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        return runtime;
      },
    });
    supervisors.push(supervisor);
    await supervisor.start();
    const runRoot = runRoots(dataRoot)[0]!;

    // Make the state directory unwritable so the run root cannot be unlinked.
    const stateDir = join(dataRoot, "omp-runtime");
    chmodSync(stateDir, 0o500);
    try {
      const result = await supervisor.stop();
      expect(result).toMatchObject({ reaped: true, cleaned: false, stopped: false });
      // A cleanup failure is a failure: the caller must never read `stopped`
      // out of a run it could not reclaim.
      expect(supervisor.status().phase).toBe("failed");
      expect(supervisor.status().reason).toBe("unreclaimed");
      expect(supervisor.pendingCleanup).toHaveLength(1);
    } finally {
      chmodSync(stateDir, 0o700);
    }
    const reclaimed = await supervisor.reclaimAll();
    expect(reclaimed.some((entry) => entry.cleaned)).toBe(true);
    expect(supervisor.status().phase).toBe("stopped");
    expect(runRoot.length).toBeGreaterThan(0);
  });
});

describe("startup failure ownership (S4)", () => {
  it("adopts a process the failed handshake could not stop", async () => {
    const dataRoot = makeRoot("startup-orphan");
    created.push(dataRoot);
    let terminationAttempts = 0;
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      probeVersion: fakeVersionProbe(MOCK_VERSION),
      pathEntries: mockPathEntries(),
      readyTimeoutMs: 300,
      selfExitMs: 50,
      // `deaf` never becomes ready *and* ignores EOF and SIGTERM, so the failed
      // handshake really does leave a process behind; a real SIGKILL always
      // wins, so the first termination's verdict is injected.
      runtimeFactory: async (options: OmpRuntimeProcessOptions) =>
        OmpRuntimeProcess.start({
          ...options,
          terminateTree: async (child, pgid, terminateOptions) => {
            terminationAttempts += 1;
            if (terminationAttempts === 1) {
              return { reaped: false, escalated: "kill" as const, steps: ["injected: survived"] };
            }
            return terminateProcessTree(child, pgid, terminateOptions);
          },
        }),
      extraEnv: { MOCK_OMP_MODE: "deaf-unready" },
    });
    supervisors.push(supervisor);

    let failure: unknown;
    try {
      await supervisor.start();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OmpRuntimeError);
    const ownership = startupFailureOwnership(failure);
    expect(ownership, "the failure must carry the process it could not stop").not.toBeNull();

    // The supervisor owns the group: the directory stays, the status says so,
    // and a second runtime is refused while this one is unreclaimed.
    expect(runRoots(dataRoot)).toHaveLength(1);
    expect(supervisor.status().phase).toBe("failed");
    expect(supervisor.status().reason).toBe("unreclaimed");
    await expect(supervisor.start()).rejects.toMatchObject({ code: "not-started" });

    const pid = ownership!.runtime.pid;
    expect(pid).toBeGreaterThan(0);
    expect(processAlive(pid!)).toBe(true);

    // The retry really terminates it, then removes the directory.
    const retried = await supervisor.stop();
    expect(retried).toMatchObject({ stopped: true, reaped: true, cleaned: true });
    expect(terminationAttempts).toBeGreaterThanOrEqual(2);
    expect(await waitFor(() => !processAlive(pid!))).toBe(true);
    expect(runRoots(dataRoot)).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
  }, 30_000);

  it("reports the plain failure when the handshake's process was reaped", async () => {
    const dataRoot = makeRoot("startup-clean");
    created.push(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      probeVersion: fakeVersionProbe(MOCK_VERSION),
      pathEntries: mockPathEntries(),
      readyTimeoutMs: 300,
      extraEnv: { MOCK_OMP_MODE: "never-ready" },
    });
    supervisors.push(supervisor);
    let failure: unknown;
    try {
      await supervisor.start();
    } catch (error) {
      failure = error;
    }
    // Nothing survived, so there is no ownership to hand over and no directory
    // left to owe.
    expect(startupFailureOwnership(failure)).toBeNull();
    expect(runRoots(dataRoot)).toEqual([]);
  }, 20_000);
});

describe("retained records and reused pids (S5)", () => {
  it("a directory-only retry never signals the old group", async () => {
    const dataRoot = makeRoot("sweep-directory-only");
    created.push(dataRoot);
    const runtime = new FakeRuntime([stopResult()]);
    const terminations: number[] = [];
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        return runtime;
      },
      terminateTree: async (_child, pgid) => {
        terminations.push(pgid);
        return { reaped: true, escalated: "term" as const, steps: ["injected"] };
      },
    });
    supervisors.push(supervisor);
    await supervisor.start();

    // The process is reaped but its directory cannot be removed yet.
    const stateDir = join(dataRoot, "omp-runtime");
    chmodSync(stateDir, 0o500);
    try {
      const result = await supervisor.stop();
      expect(result).toMatchObject({ reaped: true, cleaned: false });
    } finally {
      chmodSync(stateDir, 0o700);
    }
    expect(supervisor.pendingCleanup).toHaveLength(1);
    expect(supervisor.pendingCleanup[0]!.reaped).toBe(true);
    expect(supervisor.pendingCleanup[0]!.pgid).toBe(0);

    const swept = await supervisor.reclaimAll();
    expect(swept.some((entry) => entry.cleaned)).toBe(true);
    // The group was already empty: signalling those numbers again could reach
    // an unrelated process that inherited them.
    expect(terminations).toEqual([]);
    expect(runRoots(dataRoot)).toEqual([]);
  });

  it("a live retry does terminate the retained group", async () => {
    const dataRoot = makeRoot("sweep-live");
    created.push(dataRoot);
    const runtime = new FakeRuntime([stopResult({ reaped: false }), stopResult({ reaped: false })]);
    const terminations: number[] = [];
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        return runtime;
      },
      terminateTree: async (_child, pgid) => {
        terminations.push(pgid);
        // Still unable to empty the group: the obligation must survive.
        return { reaped: false, escalated: "kill" as const, steps: ["injected: survived"] };
      },
    });
    supervisors.push(supervisor);
    await supervisor.start();

    const swept = await supervisor.reclaimAll();
    expect(swept[0]).toMatchObject({ reaped: false });
    // The sweep terminated the group it still owned, and did not delete the
    // directory of a process that is still there.
    expect(terminations).toEqual([runtime.pgid]);
    expect(runRoots(dataRoot)).toHaveLength(1);
    expect(supervisor.pendingCleanup.length).toBeGreaterThan(0);
    expect(supervisor.pendingCleanup.every((entry) => entry.reaped === false)).toBe(true);
  });
});

describe("ghost ownership after a sweep (S7)", () => {
  /** A supervisor whose runtime never reaps, but whose sweep can. */
  function ghostFixture() {
    const dataRoot = makeRoot("sweep-ghost");
    created.push(dataRoot);
    const runtimes: FakeRuntime[] = [];
    const terminations: number[] = [];
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        const runtime = new FakeRuntime([stopResult({ reaped: false })]);
        runtimes.push(runtime);
        return runtime;
      },
      // The sweep's own terminator *can* empty the group, which is the case the
      // runtime-level stop could not reach.
      terminateTree: async (_child, pgid) => {
        terminations.push(pgid);
        return { reaped: true, escalated: "kill" as const, steps: ["injected: reaped"] };
      },
    });
    supervisors.push(supervisor);
    return { supervisor, dataRoot, runtimes, terminations };
  }

  it("releases ownership when the sweep reclaims the retained run", async () => {
    const { supervisor, dataRoot, runtimes } = ghostFixture();
    await supervisor.start();
    const runRoot = runRoots(dataRoot)[0];
    expect(runRoot).toBeDefined();

    // The first stop cannot reap, so the run is retained and the sweep is the
    // one that finishes it.
    const swept = await supervisor.reclaimAll();
    expect(swept.some((entry) => entry.reaped && entry.cleaned)).toBe(true);
    expect(supervisor.pendingCleanup).toEqual([]);
    expect(runRoots(dataRoot)).toEqual([]);

    // Nothing is owned any more: reporting `failed`/`unreclaimed` here would
    // describe a group and a directory that no longer exist.
    expect(supervisor.status().phase).toBe("stopped");
    expect(supervisor.status().reason).toBe("not-started");

    // And the engine can be started again, which is the behaviour the ghost
    // ownership made impossible.
    const restarted = await supervisor.start();
    expect(restarted.phase).toBe("idle");
    expect(runtimes).toHaveLength(2);
  });

  it("a retried stop clears the record the sweep retained for it", async () => {
    const dataRoot = makeRoot("sweep-then-stop");
    created.push(dataRoot);
    // The group survives the first stop and the sweep, then empties on the
    // retried stop: the retained record must go with it.
    const runtime = new FakeRuntime([stopResult({ reaped: false }), stopResult()]);
    const terminations: number[] = [];
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        return runtime;
      },
      terminateTree: async () => {
        terminations.push(1);
        return { reaped: false, escalated: "kill" as const, steps: ["injected: survived"] };
      },
    });
    supervisors.push(supervisor);
    await supervisor.start();

    const swept = await supervisor.reclaimAll();
    expect(swept.every((entry) => !entry.cleaned)).toBe(true);
    expect(supervisor.pendingCleanup).toHaveLength(1);
    expect(supervisor.status().phase).toBe("failed");

    // The ordinary stop is the retry that finishes the run.
    const stopped = await supervisor.stop();
    expect(stopped).toMatchObject({ stopped: true, reaped: true, cleaned: true });
    expect(supervisor.pendingCleanup).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
    expect(runRoots(dataRoot)).toEqual([]);

    // Nothing is left to retry, and no stale record can signal the old group.
    const signalsBefore = terminations.length;
    const again = await supervisor.reclaimAll();
    expect(again).toEqual([]);
    expect(terminations.length).toBe(signalsBefore);
  });

  it("keeps the directory debt without signalling the emptied group again", async () => {
    const dataRoot = makeRoot("sweep-dir-only");
    created.push(dataRoot);
    const runtime = new FakeRuntime([stopResult({ reaped: false })]);
    const terminations: number[] = [];
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        return runtime;
      },
      // The sweep empties the group; the directory is what cannot be removed.
      terminateTree: async (_child, pgid) => {
        terminations.push(pgid);
        return { reaped: true, escalated: "kill" as const, steps: ["injected: reaped"] };
      },
    });
    supervisors.push(supervisor);
    await supervisor.start();
    const runRoot = runRoots(dataRoot)[0]!;
    const stateDir = join(dataRoot, "omp-runtime");
    chmodSync(stateDir, 0o500);
    try {
      const swept = await supervisor.reclaimAll();
      // The first entry is the runtime stop; the last one is the retained record.
      expect(swept.at(-1)).toMatchObject({ reaped: true, cleaned: false });
      // The process is gone, so nothing may signal its old group again; the
      // directory is still owed, so the engine stays failed and unstartable.
      expect(supervisor.pendingCleanup).toEqual([
        expect.objectContaining({ reaped: true, pid: 0, pgid: 0 }),
      ]);
      expect(runRoots(dataRoot)).toEqual([runRoot]);
      expect(supervisor.status().phase).toBe("failed");
      expect(supervisor.status().reason).toBe("unreclaimed");
      await expect(supervisor.start()).rejects.toMatchObject({ code: "not-started" });

      const signalsAfterFirstSweep = terminations.length;
      await supervisor.reclaimAll();
      expect(terminations.length).toBe(signalsAfterFirstSweep);
    } finally {
      chmodSync(stateDir, 0o700);
    }

    // Once the directory can be removed, the debt clears.
    const final = await supervisor.reclaimAll();
    expect(final.some((entry) => entry.cleaned)).toBe(true);
    expect(supervisor.pendingCleanup).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
    expect(terminations.length).toBe(1);
  });

  it("releases ownership only for the run that was reclaimed", async () => {
    const owned = (runRoot: string): OwnedOmpRuntime =>
      ({ runRoot }) as unknown as OwnedOmpRuntime;
    // A sweep of any other run must not release this one.
    expect(ownsRun(owned("/tmp/run-a"), "/tmp/run-a")).toBe(true);
    expect(ownsRun(owned("/tmp/run-a"), "/tmp/run-b")).toBe(false);
    expect(ownsRun(null, "/tmp/run-a")).toBe(false);
  });
});

describe("retained record bookkeeping (S8)", () => {
  it("replaces the retained live record when the retried stop reaps the group", async () => {
    const dataRoot = makeRoot("record-replace");
    created.push(dataRoot);
    // The group survives the sweep, then empties on the retried stop, whose
    // directory removal fails.
    const runtime = new FakeRuntime([stopResult({ reaped: false }), stopResult()]);
    const terminations: number[] = [];
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        return runtime;
      },
      terminateTree: async (_child, pgid) => {
        terminations.push(pgid);
        return { reaped: false, escalated: "kill" as const, steps: ["injected: survived"] };
      },
    });
    supervisors.push(supervisor);
    await supervisor.start();
    const runRoot = runRoots(dataRoot)[0]!;

    const swept = await supervisor.reclaimAll();
    expect(swept.every((entry) => !entry.cleaned)).toBe(true);
    expect(supervisor.pendingCleanup).toHaveLength(1);
    expect(supervisor.pendingCleanup[0]).toMatchObject({ runRoot: join(dataRoot, "omp-runtime", runRoot) });
    expect(supervisor.pendingCleanup[0]).toMatchObject({ reaped: false, pid: 4242 });

    const stateDir = join(dataRoot, "omp-runtime");
    chmodSync(stateDir, 0o500);
    try {
      // The retried stop reaps the group; the directory is the part that fails.
      const stopped = await supervisor.stop();
      expect(stopped).toMatchObject({ reaped: true, cleaned: false });
      // One run, one record: a live-looking copy of a run whose group is
      // already empty must not survive next to the directory-only record.
      expect(supervisor.pendingCleanup).toHaveLength(1);
      expect(supervisor.pendingCleanup[0]).toMatchObject({ reaped: true, pid: 0, pgid: 0 });
      expect(supervisor.status().phase).toBe("failed");
      expect(supervisor.status().reason).toBe("unreclaimed");
      await expect(supervisor.start()).rejects.toMatchObject({ code: "not-started" });

      // While only the directory is owed, no sweep may signal the old group.
      const signalsBefore = terminations.length;
      await supervisor.reclaimAll();
      expect(terminations.length).toBe(signalsBefore);
      expect(supervisor.pendingCleanup).toHaveLength(1);
    } finally {
      chmodSync(stateDir, 0o700);
    }

    // Once the directory can be removed, the debt clears for good.
    const final = await supervisor.reclaimAll();
    expect(final.some((entry) => entry.cleaned)).toBe(true);
    expect(supervisor.pendingCleanup).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
    expect(runRoots(dataRoot)).toEqual([]);
    expect(terminations.length).toBe(1);
  });

});

describe("concurrent lifecycle", () => {
  it("shares one stop attempt between concurrent callers", async () => {
    const { supervisor, runtime } = supervisorWithRuntime([stopResult()]);
    await supervisor.start();
    const [first, second, third] = await Promise.all([
      supervisor.stop(),
      supervisor.stop(),
      supervisor.stop(),
    ]);
    expect(runtime.stopCalls).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("reclaims a runtime whose start is still in flight", async () => {
    const dataRoot = makeRoot("lifecycle-race");
    created.push(dataRoot);
    const runtime = new FakeRuntime([stopResult()]);
    let releaseStart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      runtimeFactory: async (options: OmpRuntimeProcessOptions) => {
        mkdirSync(options.cwd, { recursive: true });
        await gate;
        return runtime;
      },
    });
    supervisors.push(supervisor);

    const starting = supervisor.start();
    const stopping = supervisor.stop();
    releaseStart?.();
    await starting;
    const result = await stopping;

    // The start completed after the stop began; the runtime it installed is the
    // one that must be reclaimed, or it would outlive every caller that asked.
    expect(result.stopped).toBe(true);
    expect(runtime.stopCalls).toBe(1);
    expect(runRoots(dataRoot)).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
  });

  it("refuses a concurrent start while an unreclaimed run is retained", async () => {
    const { supervisor } = supervisorWithRuntime([stopResult({ reaped: false })]);
    await supervisor.start();
    await supervisor.stop();
    const attempts = await Promise.allSettled([supervisor.start(), supervisor.start()]);
    expect(attempts.every((entry) => entry.status === "rejected")).toBe(true);
  });
});
