import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { closedEngineCapabilities } from "@pi-desktop/shared";

import { OmpRuntimeError } from "./errors.js";
import { OmpRuntimeSupervisor } from "./supervisor.js";
import {
  MOCK_LAUNCHER,
  MOCK_VERSION,
  fakeVersionProbe,
  makeRoot,
  mockPathEntries,
  processAlive,
  waitFor,
} from "./test-harness.js";

const created: string[] = [];
const supervisors: OmpRuntimeSupervisor[] = [];

type SupervisorFixture = {
  supervisor: OmpRuntimeSupervisor;
  dataRoot: string;
};

function supervisorFor(
  options: Partial<Omit<ConstructorParameters<typeof OmpRuntimeSupervisor>[0], "dataRoot">> = {},
): SupervisorFixture {
  const dataRoot = makeRoot("supervisor");
  created.push(dataRoot);
  const supervisor = new OmpRuntimeSupervisor({
    launcherPath: MOCK_LAUNCHER,
    expectedRuntimeVersion: MOCK_VERSION,
    probeVersion: fakeVersionProbe(MOCK_VERSION),
    // The mock is a script with an `env node` shebang; its interpreter lives
    // outside the closed production PATH.
    pathEntries: mockPathEntries(),
    ...options,
    dataRoot,
  });
  supervisors.push(supervisor);
  return { supervisor, dataRoot };
}

function runDirs(dataRoot: string): string[] {
  const base = join(dataRoot, "omp-runtime");
  return existsSync(base) ? readdirSync(base) : [];
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.reclaimAll().catch(() => undefined);
  }
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime supervisor", () => {
  it("starts nothing until asked, then reports a running runtime", async () => {
    const { supervisor } = supervisorFor();
    const before = supervisor.status();
    expect(before.phase).toBe("stopped");
    expect(before.reason).toBe("not-started");
    // Nothing is live before a runtime exists: the declaration is a promise,
    // the status reports what can be served right now.
    expect(before.capabilities).toEqual(closedEngineCapabilities());

    const started = await supervisor.start();
    expect(started.phase).toBe("idle");
    expect(started.runtimeVersion).toBe(MOCK_VERSION);
    expect(started.protocolVersion).toBe(2);
    // M3 truth: the process is up and serves the surface this release ships.
    expect(started.reason).toBeNull();
    // A running runtime serves exactly the capabilities M4 shipped; the ones
    // still closed (steer, followUp, compact…) stay false.
    expect(started.capabilities.prompt).toBe(true);
    expect(started.capabilities.stop).toBe(true);
    expect(started.capabilities.resume).toBe(true);
    expect(started.capabilities.steer).toBe(false);
    expect(supervisor.liveCapabilities().prompt).toBe(true);
  });

  it("coalesces concurrent starts into one runtime", async () => {
    const { supervisor, dataRoot } = supervisorFor();
    const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
    expect(a.phase).toBe("idle");
    expect(b.phase).toBe("idle");
    expect(runDirs(dataRoot)).toHaveLength(1);
  });

  it("stops the runtime and removes the directory it created", async () => {
    const { supervisor, dataRoot } = supervisorFor();
    await supervisor.start();
    expect(runDirs(dataRoot)).toHaveLength(1);

    const result = await supervisor.stop();
    expect(result).toMatchObject({ stopped: true, reaped: true, cleaned: true });
    expect(runDirs(dataRoot)).toEqual([]);
    expect(supervisor.status().phase).toBe("stopped");
    expect(supervisor.pendingCleanup).toEqual([]);
  });

  it("reports a failed cleanup instead of claiming the run was reclaimed", async () => {
    const { supervisor, dataRoot } = supervisorFor();
    await supervisor.start();
    const stateDir = join(dataRoot, "omp-runtime");
    // Make the state directory unwritable: the run root can no longer be removed.
    chmodSync(stateDir, 0o500);
    try {
      const result = await supervisor.stop();
      expect(result.reaped).toBe(true);
      expect(result.cleaned).toBe(false);
      expect(result.stopped).toBe(false);
      expect(result.errors.join(" ")).toContain("could not remove");
      expect(supervisor.pendingCleanup).toHaveLength(1);
    } finally {
      chmodSync(stateDir, 0o700);
    }
    // The retained record still lets a later attempt finish the job.
    const reclaimed = await supervisor.reclaimAll();
    expect(reclaimed.some((entry) => entry.cleaned)).toBe(true);
    expect(supervisor.pendingCleanup).toEqual([]);
  });

  it("reports a start failure with its reason and never leaves a run behind", async () => {
    const dataRoot = makeRoot("supervisor-missing");
    created.push(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: join(dataRoot, "nope"),
      expectedRuntimeVersion: MOCK_VERSION,
    });
    supervisors.push(supervisor);

    await expect(supervisor.start()).rejects.toBeInstanceOf(OmpRuntimeError);
    const status = supervisor.status();
    expect(status.phase).toBe("failed");
    expect(status.reason).toBe("start-failed");
    expect(status.capabilities.prompt).toBe(false);  // a failed runtime serves nothing
    expect(runDirs(dataRoot)).toEqual([]);
  });

  it("hides the operator's environment from the runtime", async () => {
    const root = makeRoot("supervisor-env");
    created.push(root);
    const envFile = join(root, "env.json");
    const { supervisor, dataRoot } = supervisorFor({
      extraEnv: { MOCK_OMP_ENV_FILE: envFile, MOCK_OMP_MODE: "normal" },
    });
    await supervisor.start();
    const seen = JSON.parse(readFileSync(envFile, "utf8")) as {
      HOME: string;
      PI_CONFIG_DIR: string;
      PI_CODING_AGENT_DIR: string;
      credentialKeys: string[];
      desktopKeys: string[];
    };
    const runRootPrefix = join(dataRoot, "omp-runtime");
    expect(seen.HOME.startsWith(runRootPrefix)).toBe(true);
    // Both roots live inside the run directory this supervisor owns, and the
    // config root is expressed relative to the synthetic HOME it was given.
    expect(seen.PI_CODING_AGENT_DIR.startsWith(runRootPrefix)).toBe(true);
    // The config root is a fresh unique name inside the synthetic home.
    expect(seen.PI_CONFIG_DIR.startsWith(".omp-runtime-")).toBe(true);
    expect(seen.credentialKeys).toEqual([]);
    expect(seen.desktopKeys).toEqual([]);
  });

  it("terminates a detached command tree only when asked", async () => {
    const { supervisor } = supervisorFor();
    await supervisor.start();
    // A command tree the runtime detached: its own group, ignoring SIGTERM. The
    // keep-alive interval belongs to the child, not to this test: an integration
    // case has to terminate a genuinely running process, which no fake clock can
    // simulate.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      // Detached: a command runs as its own group leader, which is the case
      // `terminateOwnedTree` is built for.
      { stdio: "ignore", detached: true },
    );
    expect(child.pid).toBeDefined();
    try {
      await supervisor.terminateOwnedTree(child.pid!, { graceMs: 200 });
      expect(await waitFor(() => !processAlive(child.pid!))).toBe(true);
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await expect(supervisor.terminateOwnedTree(0)).rejects.toMatchObject({
      code: "not-started",
    });
  });

  it("terminates a bare pid that is not a group leader", async () => {
    const { supervisor } = supervisorFor();
    await supervisor.start();
    // A pid handed in from an event may not head a group; signalling `-pid`
    // would hit nothing and the process would survive while we reported success.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    try {
      const result = await supervisor.terminateOwnedTree(child.pid!, { graceMs: 200 });
      expect(result.reaped).toBe(true);
      expect(result.steps.join(" ")).toContain("not a process group");
      expect(await waitFor(() => !processAlive(child.pid!))).toBe(true);
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("reclaims every runtime it owns on shutdown", async () => {
    const { supervisor, dataRoot } = supervisorFor();
    await supervisor.start();
    const results = await supervisor.reclaimAll();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reaped: true, cleaned: true });
    expect(runDirs(dataRoot)).toEqual([]);
  });

  it("creates the state directory under the product's data root only", async () => {
    const dataRoot = makeRoot("supervisor-root");
    created.push(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      probeVersion: fakeVersionProbe(MOCK_VERSION),
      pathEntries: mockPathEntries(),
    });
    supervisors.push(supervisor);
    await supervisor.start();
    expect(readdirSync(dataRoot)).toEqual(["omp-runtime"]);
    await supervisor.stop();
  });
});
