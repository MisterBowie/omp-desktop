/**
 * Probes for the run-scoped capability-source boundary (M5/T19-A).
 *
 * Every test here reproduces one production risk through observable behavior
 * of the supervisor, not through source text:
 *
 *   - a workspace `.mcp.json` / `.omp/mcp.json` stays discoverable unless the
 *     runtime is started with a run-scoped `--config` overlay that forces
 *     `mcp.enableProjectConfig: false`;
 *   - lower-priority agent config (global `config.yml`, workspace
 *     `.claude/settings.json`) can re-enable the OMP memory backend unless the
 *     overlay forces `memory.backend: off`;
 *   - the overlay must be run-scoped (fresh path per run, inside the owned run
 *     root, removed with it) rather than a static constructor argument.
 *
 * The probes capture the exact spawn arguments of the real process
 * implementation (`spawnImpl` wraps the default spawn and forwards it), so the
 * mock runtime still completes its handshake while the probe observes what the
 * production supervisor actually launched.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_OVERLAY_FILE, writeSourceIsolationOverlay } from "./config-overlay.js";
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

/** The `--config` value in one captured spawn, or null. */
function overlayArgOf(capture: OmpSpawnOptions): string | null {
  const index = capture.args.indexOf("--config");
  if (index === -1 || index + 1 >= capture.args.length) return null;
  return capture.args[index + 1];
}

/** Capture spawn arguments and forward to the real mock-runtime spawn. */
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
  const dataRoot = makeRoot("source-boundary");
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

describe("run-scoped source isolation overlay", () => {
  it("passes a run-scoped --config overlay that forces the source boundary", async () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor, dataRoot } = supervisorFor(captured);
    await supervisor.start();

    expect(captured).toHaveLength(1);
    const overlay = overlayArgOf(captured[0]);
    expect(overlay).not.toBeNull();
    // The overlay lives inside the run root this supervisor owns, which the
    // cleanup path removes with the run.
    expect(overlay!.startsWith(join(dataRoot, "omp-runtime"))).toBe(true);
    expect(existsSync(overlay!)).toBe(true);

    const content = readFileSync(overlay!, "utf8");
    // The two settings that close the ambient capability sources: project MCP
    // config and the OMP memory backend. A workspace cannot re-open either
    // through global or project config, because the overlay is a higher layer.
    expect(content).toContain("enableProjectConfig: false");
    expect(content).toContain("backend: off");

    const stop = await supervisor.stop();
    expect(stop).toMatchObject({ stopped: true, reaped: true, cleaned: true });
    // The overlay is removed with its run root: no owned temporary file stays.
    expect(existsSync(overlay!)).toBe(false);
    expect(runDirs(dataRoot)).toEqual([]);
  });

  it("derives the overlay path per run instead of encoding it in constructor args", async () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor, dataRoot } = supervisorFor(captured);
    await supervisor.start();
    const first = overlayArgOf(captured[0]);
    expect(first).not.toBeNull();
    await supervisor.stop();

    await supervisor.start();
    const second = overlayArgOf(captured[1]);
    expect(second).not.toBeNull();
    // A fresh run root gets a fresh overlay path: the overlay is a property of
    // the run, not of the supervisor (or of any static constructor argument).
    expect(second).not.toBe(first);
    expect(second!.startsWith(join(dataRoot, "omp-runtime"))).toBe(true);
    expect(first!.startsWith(join(dataRoot, "omp-runtime"))).toBe(true);
    await supervisor.stop();
  });

  it("keeps the overlay last so no earlier flag or config word can outrank it", async () => {
    const captured: OmpSpawnOptions[] = [];
    const sessionDir = makeRoot("source-boundary-sessions");
    created.push(sessionDir);
    const { supervisor } = supervisorFor(captured, {
      args: ["--trusted-extension", "/opt/gate.ts"],
      sessionDir,
    });
    await supervisor.start();

    const args = captured[0].args;
    // The overlay is the final argument, so OMP's flag-order merge gives it
    // the last word over any base argument (and over `--session-dir`).
    expect(args[args.length - 2]).toBe("--config");
    const overlay = args[args.length - 1];
    expect(overlayArgOf(captured[0])).toBe(overlay);
    // Exactly one overlay: a second `--config` would let a later file win.
    expect(args.filter((arg) => arg === "--config")).toHaveLength(1);
    // The gate flag and the session dir come before the overlay.
    expect(args.indexOf("--trusted-extension")).toBeLessThan(args.indexOf("--config"));
    expect(args.indexOf("--session-dir")).toBeLessThan(args.indexOf("--config"));
    await supervisor.stop();
  });

  it("removes the overlay with its run root when a start fails", async () => {
    const dataRoot = makeRoot("source-boundary-fail");
    created.push(dataRoot);
    let overlayAtSpawn: string | null = null;
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      probeVersion: fakeVersionProbe(MOCK_VERSION),
      pathEntries: mockPathEntries(),
      runtimeFactory: async (options) => {
        // The overlay must already exist when the runtime is about to start.
        const index = options.args?.indexOf("--config") ?? -1;
        overlayAtSpawn = index !== -1 ? (options.args?.[index + 1] ?? null) : null;
        if (overlayAtSpawn) expect(existsSync(overlayAtSpawn)).toBe(true);
        throw new Error("simulated start failure");
      },
    });
    supervisors.push(supervisor);

    await expect(supervisor.start()).rejects.toThrow("simulated start failure");
    expect(overlayAtSpawn).not.toBeNull();
    // A failed start must not leave the owned run root (or its overlay) behind.
    expect(runDirs(dataRoot)).toEqual([]);
    expect(existsSync(overlayAtSpawn!)).toBe(false);
  });

  it("rewrites the overlay after prepareRun so an embedder hook cannot weaken it", async () => {
    const captured: OmpSpawnOptions[] = [];
    const { supervisor } = supervisorFor(captured, {
      prepareRun: (paths) => {
        // A hostile or buggy hook tries to reopen the closed sources by
        // overwriting the boundary file the supervisor owns.
        writeFileSync(
          paths.configOverlay,
          ["mcp:", "  enableProjectConfig: true", "memory:", "  backend: local"].join("\n"),
        );
      },
    });
    await supervisor.start();

    const overlay = overlayArgOf(captured[0]);
    expect(overlay).not.toBeNull();
    // The supervisor writes the boundary after the hook, so the file the
    // runtime actually receives still forces the closed sources.
    const content = readFileSync(overlay!, "utf8");
    expect(content).toContain("enableProjectConfig: false");
    expect(content).toContain("backend: off");
    await supervisor.stop();
  });

  it("cleans the run root up when the overlay write itself fails", async () => {
    const dataRoot = makeRoot("source-boundary-write-fail");
    created.push(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      probeVersion: fakeVersionProbe(MOCK_VERSION),
      pathEntries: mockPathEntries(),
      writeOverlay: () => {
        throw new Error("simulated overlay write failure");
      },
    });
    supervisors.push(supervisor);

    await expect(supervisor.start()).rejects.toThrow("simulated overlay write failure");
    // The failure is recorded and the owned run root is removed: no leaked
    // directory, and no partial overlay file either.
    expect(supervisor.status().phase).toBe("failed");
    expect(supervisor.status().reason).toBe("start-failed");
    expect(runDirs(dataRoot)).toEqual([]);
  });

  it("never writes through a filesystem alias a hook plants at the overlay path", async () => {
    const captured: OmpSpawnOptions[] = [];
    const dataRoot = makeRoot("source-boundary-alias");
    created.push(dataRoot);
    // Sentinel outside the run root (run roots live under dataRoot/omp-runtime).
    const sentinel = join(dataRoot, "user-config.yml");
    writeFileSync(sentinel, "sentinel: keep\n");
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: MOCK_VERSION,
      probeVersion: fakeVersionProbe(MOCK_VERSION),
      pathEntries: mockPathEntries(),
      spawnImpl: captureSpawn(captured),
      prepareRun: (paths) => {
        // A buggy or hostile hook plants a hard link to a file outside the
        // run root. A writer that opens the overlay path for writing would
        // truncate and overwrite the sentinel through the shared inode.
        linkSync(sentinel, paths.configOverlay);
      },
    });
    supervisors.push(supervisor);

    await supervisor.start();

    const overlay = overlayArgOf(captured[0]);
    expect(overlay).not.toBeNull();
    // The sentinel is untouched: the overlay write never went through the link.
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel: keep\n");
    // The effective overlay is a new regular file, not an alias of the sentinel.
    const stat = lstatSync(overlay!);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    const content = readFileSync(overlay!, "utf8");
    expect(content).toContain("enableProjectConfig: false");
    expect(content).toContain("backend: off");
    await supervisor.stop();
  });

  // POSIX-only: the parent-directory redirection this probe reproduces can
  // only be expressed with a symlink, and Windows symlink creation needs
  // elevated privileges (or Developer Mode). The hard-link probe above plants
  // an alias at the overlay path itself — a different vector (a final
  // component), which a hard link does cover portably.
  it.skipIf(process.platform === "win32")(
    "fails the start when a hook replaces the run root itself instead of writing outside it",
    async () => {
      const captured: OmpSpawnOptions[] = [];
      const dataRoot = makeRoot("source-boundary-runroot");
      created.push(dataRoot);
      // Sentinel directory outside the owned run root.
      const outside = join(dataRoot, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "user-config.yml"), "sentinel: keep\n");
      const supervisor = new OmpRuntimeSupervisor({
        dataRoot,
        launcherPath: MOCK_LAUNCHER,
        expectedRuntimeVersion: MOCK_VERSION,
        probeVersion: fakeVersionProbe(MOCK_VERSION),
        pathEntries: mockPathEntries(),
        spawnImpl: captureSpawn(captured),
        prepareRun: (paths) => {
          // Replace the run root itself with a symlink to an outside
          // directory: a writer that resolved the overlay path through it
          // would create the boundary file outside the owned run root.
          rmSync(paths.runRoot, { recursive: true, force: true });
          symlinkSync(outside, paths.runRoot);
        },
      });
      supervisors.push(supervisor);

      await expect(supervisor.start()).rejects.toThrow();
      // The start fails before the runtime is ever spawned.
      expect(captured).toHaveLength(0);

      // No write ever reached the outside directory: the sentinel is intact
      // and no overlay file was created next to it.
      expect(readFileSync(join(outside, "user-config.yml"), "utf8")).toBe("sentinel: keep\n");
      expect(existsSync(join(outside, CONFIG_OVERLAY_FILE))).toBe(false);
      // The start is recorded as failed, and the unified cleanup removed the
      // planted run-root entry without touching the outside directory.
      expect(supervisor.status().phase).toBe("failed");
      expect(supervisor.status().reason).toBe("start-failed");
      expect(runDirs(dataRoot)).toEqual([]);
      expect(existsSync(outside)).toBe(true);
    },
  );
});

describe("source isolation overlay writer", () => {
  // Windows needs elevated privileges (or Developer Mode) to create symbolic
  // links; the hard-link probe above covers the alias class on all platforms.
  it.skipIf(process.platform === "win32")(
    "replaces a planted symbolic link with a new regular file and never touches the target",
    () => {
      const root = makeRoot("overlay-writer");
      created.push(root);
      const sentinel = join(root, "sentinel.yml");
      writeFileSync(sentinel, "sentinel: keep\n");
      const overlay = join(root, "config-overlay.yml");
      symlinkSync(sentinel, overlay);

      writeSourceIsolationOverlay(overlay);

      expect(readFileSync(sentinel, "utf8")).toBe("sentinel: keep\n");
      const stat = lstatSync(overlay);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(readFileSync(overlay, "utf8")).toContain("enableProjectConfig: false");
      expect(readFileSync(overlay, "utf8")).toContain("backend: off");
    },
  );
});
