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
  type ManagedOmpRuntime,
  type OmpRuntimeSupervisorOptions,
} from "./supervisor.js";
import type { OmpRuntimeProcessOptions, OmpStopOptions, OmpStopResult } from "./process.js";
import { MOCK_LAUNCHER, MOCK_VERSION, makeRoot, mockPathEntries } from "./test-harness.js";
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
    const { supervisor, dataRoot } = supervisorWithRuntime([stopResult({ reaped: false })]);
    await supervisor.start();
    await supervisor.stop();
    expect(runRoots(dataRoot)).toHaveLength(1);

    const results = await supervisor.reclaimAll();
    expect(results).toHaveLength(1);
    // The retained run is retried: this fake still refuses to reap, so the
    // directory must stay and the record must remain for the next attempt.
    expect(results[0]).toMatchObject({ reaped: false, cleaned: false });
    expect(runRoots(dataRoot)).toHaveLength(1);

    const again = await supervisor.reclaimAll();
    expect(again[0]!.cleaned).toBe(false);
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
      expect(supervisor.status().reason).toBe("unreclaimed");
      expect(supervisor.status().phase).toBe("failed");
    } finally {
      chmodSync(stateDir, 0o700);
    }
    const reclaimed = await supervisor.reclaimAll();
    expect(reclaimed.some((entry) => entry.cleaned)).toBe(true);
    expect(supervisor.status().phase).toBe("stopped");
    expect(runRoot.length).toBeGreaterThan(0);
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
