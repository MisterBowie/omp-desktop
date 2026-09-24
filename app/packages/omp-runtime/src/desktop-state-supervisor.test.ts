/**
 * Probes for the supervisor half of the desktop-capability state (M5/T19-C).
 *
 * The trusted gate finds its state file through `OMP_DESKTOP_STATE`, which the
 * supervisor must point at `<runRoot>/desktop-state.json` at spawn time — a
 * path that only exists once the run root is minted, so it can never be a
 * static constructor argument and an embedder's `extraEnv` can never redirect
 * it. The state file is removed with the run root on stop/reclaim.
 *
 * On the T19-C baseline (`df49b84`) the supervisor sets no such variable and
 * exposes no run root: every assertion below fails on the captured spawn
 * environment or the missing getter.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { DESKTOP_STATE_ENV, DESKTOP_STATE_FILE } from "./desktop-state.js";
import { OmpRuntimeSupervisor } from "./supervisor.js";
import type { OmpSpawnOptions } from "./process.js";
import {
  MOCK_LAUNCHER,
  MOCK_VERSION,
  fakeVersionProbe,
  makeRoot,
  mockPathEntries,
} from "./test-harness.js";

const created: string[] = [];
const supervisors: OmpRuntimeSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.reclaimAll().catch(() => undefined);
  }
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function captureSpawn(captured: OmpSpawnOptions[]) {
  return (options: OmpSpawnOptions): ChildProcessWithoutNullStreams => {
    captured.push({
      command: options.command,
      args: [...options.args],
      cwd: options.cwd,
      env: options.env,
    });
    return spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
  };
}

function supervisorFor(
  captured: OmpSpawnOptions[],
  options: Partial<ConstructorParameters<typeof OmpRuntimeSupervisor>[0]> = {},
): { supervisor: OmpRuntimeSupervisor; dataRoot: string } {
  const dataRoot = makeRoot("desktop-state");
  created.push(dataRoot);
  const supervisor = new OmpRuntimeSupervisor({
    launcherPath: MOCK_LAUNCHER,
    expectedRuntimeVersion: MOCK_VERSION,
    probeVersion: fakeVersionProbe(MOCK_VERSION),
    pathEntries: mockPathEntries(),
    spawnImpl: captureSpawn(captured),
    ...options,
    dataRoot,
  });
  supervisors.push(supervisor);
  return { supervisor, dataRoot };
}

describe("desktop-capability state wiring", () => {
  it("has no run root before start and no state path before a run exists", () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor } = supervisorFor(captured);
    expect(supervisor.runRoot()).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("points OMP_DESKTOP_STATE at the owned run root and reports the run root", async () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor } = supervisorFor(captured);
    await supervisor.start();

    expect(captured).toHaveLength(1);
    const env = captured[0]!.env ?? {};
    const statePath = env[DESKTOP_STATE_ENV];
    expect(typeof statePath).toBe("string");
    expect(statePath).toBe(join(supervisor.runRoot()!, DESKTOP_STATE_FILE));
    expect(statePath.startsWith(supervisor.runRoot()!)).toBe(true);
  });

  it("does not let an embedder's extraEnv redirect the state path", async () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor } = supervisorFor(captured, {
      extraEnv: { [DESKTOP_STATE_ENV]: "/tmp/decoy-state.json" },
    });
    await supervisor.start();

    const env = captured[0]!.env ?? {};
    expect(env[DESKTOP_STATE_ENV]).toBe(join(supervisor.runRoot()!, DESKTOP_STATE_FILE));
  });

  it("removes the state file with the run root on stop", async () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor } = supervisorFor(captured);
    await supervisor.start();

    const runRoot = supervisor.runRoot()!;
    const statePath = join(runRoot, DESKTOP_STATE_FILE);
    // The bridge writes this file per prompt; planting it here proves the
    // owned cleanup removes it with the run root.
    writeFileSync(statePath, "{}");
    expect(existsSync(statePath)).toBe(true);

    const result = await supervisor.stop();
    expect(result).toMatchObject({ stopped: true, reaped: true, cleaned: true });
    expect(existsSync(statePath)).toBe(false);
    expect(supervisor.runRoot()).toBeNull();
  });
});
