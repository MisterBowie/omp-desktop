import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OmpRuntimeError } from "./errors.js";
import { probeRuntimeVersion, resolveOmpLauncher, runtimeVersionMismatch } from "./launcher.js";

const created: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-launcher-"));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("launcher resolution", () => {
  it("prefers an explicit path, then the bundled one, then the dev launcher", () => {
    const root = scratch();
    const explicit = executable(root, "explicit", "#!/bin/sh\nexit 0\n");
    const bundled = executable(root, "bundled", "#!/bin/sh\nexit 0\n");
    const dev = executable(root, "dev", "#!/bin/sh\nexit 0\n");

    expect(resolveOmpLauncher({ explicitPath: explicit, bundledPath: bundled, devLauncherPath: dev })).toBe(explicit);
    expect(resolveOmpLauncher({ explicitPath: null, bundledPath: bundled, devLauncherPath: dev })).toBe(bundled);
    expect(resolveOmpLauncher({ devLauncherPath: dev })).toBe(dev);
  });

  it("refuses to resolve a bare name from PATH", () => {
    expect(() => resolveOmpLauncher({ explicitPath: "omp" })).toThrow(OmpRuntimeError);
    try {
      resolveOmpLauncher({ explicitPath: "omp" });
    } catch (error) {
      expect((error as OmpRuntimeError).code).toBe("launcher-missing");
      expect((error as OmpRuntimeError).detail).toContain("not absolute");
    }
  });

  it("reports every candidate it tried when nothing is runnable", () => {
    const root = scratch();
    writeFileSync(join(root, "not-executable"), "x", { mode: 0o644 });
    const missing = join(root, "missing");
    try {
      resolveOmpLauncher({ explicitPath: join(root, "not-executable"), bundledPath: missing });
      throw new Error("unreachable");
    } catch (error) {
      const detail = (error as OmpRuntimeError).detail ?? "";
      expect((error as OmpRuntimeError).code).toBe("launcher-missing");
      expect(detail).toContain("not-executable");
      expect(detail).toContain("missing");
    }
    expect(() => resolveOmpLauncher({})).toThrow(/no OMP runtime executable is configured/);
  });
});

describe("version probe", () => {
  it("reads the runtime's version line", async () => {
    const root = scratch();
    const launcher = executable(root, "version-ok", "#!/bin/sh\necho omp/18.2.7\n");
    const probe = await probeRuntimeVersion({ launcher, env: {}, cwd: root, timeoutMs: 5_000 });
    expect(probe).toEqual({ version: "18.2.7", reported: "omp/18.2.7", exitCode: 0 });
  });

  it("reports an unreadable answer as no version instead of inventing one", async () => {
    const root = scratch();
    const launcher = executable(root, "version-weird", "#!/bin/sh\necho something else\n");
    const probe = await probeRuntimeVersion({ launcher, env: {}, cwd: root, timeoutMs: 5_000 });
    expect(probe.version).toBeNull();
    expect(probe.reported).toBe("something else");
  });

  it("fails typed and bounded when the launcher hangs", async () => {
    const root = scratch();
    const launcher = executable(root, "version-hang", "#!/bin/sh\nsleep 30\n");
    await expect(
      probeRuntimeVersion({ launcher, env: {}, cwd: root, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "ready-timeout" });
  });

  it("fails typed when the launcher cannot be executed at all", async () => {
    const root = scratch();
    const missing = join(root, "does-not-exist");
    await expect(
      probeRuntimeVersion({ launcher: missing, env: {}, cwd: root, timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ code: "spawn-failed" });
  });

  it("compares against the pinned version and can be disabled", () => {
    expect(runtimeVersionMismatch("18.2.7", "18.2.7")).toBeNull();
    expect(runtimeVersionMismatch(null, "18.2.7")).toEqual({ expected: "18.2.7", reported: null });
    expect(runtimeVersionMismatch("18.0.0", "18.2.7")).toEqual({
      expected: "18.2.7",
      reported: "18.0.0",
    });
    expect(runtimeVersionMismatch("anything", null)).toBeNull();
  });
});
