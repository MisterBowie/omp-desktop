import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { OmpSpawnOptions } from "./process.js";
import { OmpRuntimeSupervisor } from "./supervisor.js";
import { MOCK_LAUNCHER, MOCK_VERSION, fakeVersionProbe, makeRoot, mockPathEntries } from "./test-harness.js";

const created: string[] = [];
const supervisors: OmpRuntimeSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.reclaimAll().catch(() => undefined);
  }
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Capture the spawn environment and forward to the real mock-runtime spawn. */
function captureSpawn(captured: OmpSpawnOptions[]) {
  return (options: OmpSpawnOptions): ChildProcessWithoutNullStreams => {
    captured.push({ command: options.command, args: [...options.args], cwd: options.cwd, env: options.env });
    return spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
  };
}

function supervisorWithProxy(
  captured: OmpSpawnOptions[],
  proxy: () => Promise<{ url: string; bypass: string } | undefined>,
): OmpRuntimeSupervisor {
  const dataRoot = makeRoot("proxy-policy");
  created.push(dataRoot);
  const supervisor = new OmpRuntimeSupervisor({
    launcherPath: MOCK_LAUNCHER,
    expectedRuntimeVersion: MOCK_VERSION,
    probeVersion: fakeVersionProbe(MOCK_VERSION),
    pathEntries: mockPathEntries(),
    spawnImpl: captureSpawn(captured),
    proxy,
    dataRoot,
  });
  supervisors.push(supervisor);
  return supervisor;
}

describe("supervisor proxy policy", () => {
  it("launches the child behind the proxy resolved for this start", async () => {
    const captured: OmpSpawnOptions[] = [];
    const supervisor = supervisorWithProxy(captured, async () => ({
      url: "http://127.0.0.1:7890",
      bypass: "localhost",
    }));
    await supervisor.start();

    const env = captured[0]?.env ?? {};
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toBe("localhost");
  });

  it("launches direct without proxy variables even when the parent process has some", async () => {
    const inherited = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://10.9.9.9:1";
    try {
      const captured: OmpSpawnOptions[] = [];
      const supervisor = supervisorWithProxy(captured, async () => undefined);
      await supervisor.start();

      expect(captured[0]?.env?.HTTPS_PROXY).toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = inherited;
    }
  });
});
