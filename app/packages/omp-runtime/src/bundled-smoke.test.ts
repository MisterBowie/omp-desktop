/**
 * Startup assertions for the bundled sidecar (M5/T20-R4B, ADR 0307).
 *
 * Two things are proved here. First, always: a runtime whose identity (its
 * `--version`) or protocol (its `ready`/`negotiate_protocol` handshake) is not
 * the one this build pins must not become a usable engine — the session layer
 * only offers capabilities on an `idle` runtime, so a refusal here is what
 * stops an unusable session from being created. Second, when
 * `OMP_SIDECAR_TEST_RESOURCES` names a built resources root (the directory that
 * plays `process.resourcesPath`, i.e. the parent of `omp-runtime/`): the real,
 * compiled sidecar — the exact artifact `scripts/omp-sidecar.mjs` produced — is
 * verified, started under the desktop's isolation, asserted to negotiate v2,
 * and reclaimed with its process group and scratch root. No prompt is ever
 * sent, so no provider is contacted and no model is billed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OMP_RUNTIME_VERSION } from "@pi-desktop/shared";

import { verifyBundledRuntime } from "./bundled.js";
import { MOCK_LAUNCHER, mockPathEntries, processAlive, waitFor } from "./test-harness.js";
import { OmpRuntimeSupervisor, RUN_ROOT_PREFIX, type OmpRuntimeSupervisorOptions } from "./supervisor.js";

const created: string[] = [];

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `omp-bundled-start-${label}-`));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A model catalog for the child, so it reaches `ready` with no credential. */
function writeModelCatalog(agentDir: string): void {
  writeFileSync(
    join(agentDir, "models.yml"),
    `providers:
  smoke:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        api: openai-completions
        contextWindow: 200000
        supportsTools: true
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`,
    "utf8",
  );
}

describe("identity and protocol assertions", () => {
  it("refuses a runtime that reports a version other than the pinned one", async () => {
    const dataRoot = scratch("version");
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      pathEntries: mockPathEntries(),
      extraEnv: { MOCK_OMP_VERSION: "omp/18.2.7" },
    });
    await expect(supervisor.start()).rejects.toMatchObject({ code: "version-mismatch" });
    const status = supervisor.status();
    expect(status.phase).toBe("failed");
    expect(status.reason).toBe("version-mismatch");
    expect(status.capabilities.prompt).toBe(false);
  });

  it("refuses a runtime that will not negotiate the required protocol", async () => {
    const dataRoot = scratch("protocol");
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: MOCK_LAUNCHER,
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      pathEntries: mockPathEntries(),
      extraEnv: { MOCK_OMP_MODE: "refuse-v2" },
      readyTimeoutMs: 10_000,
    });
    await expect(supervisor.start()).rejects.toMatchObject({ code: "protocol-unsupported" });
    const status = supervisor.status();
    expect(status.phase).toBe("failed");
    expect(status.reason).toBe("protocol-unsupported");
    expect(status.capabilities.prompt).toBe(false);
  });
});

const ARTIFACT_ROOT = process.env.OMP_SIDECAR_TEST_RESOURCES ?? null;

describe.skipIf(!ARTIFACT_ROOT)("real bundled sidecar", () => {
  const resources = ARTIFACT_ROOT as string;

  function makeSupervisor(
    dataRoot: string,
    overrides: Partial<OmpRuntimeSupervisorOptions> = {},
  ): OmpRuntimeSupervisor {
    return new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: verifyBundledRuntime({ resourcesPath: resources }).path,
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      readyTimeoutMs: 120_000,
      requestTimeoutMs: 30_000,
      selfExitMs: 5_000,
      terminationGraceMs: 10_000,
      ...overrides,
    });
  }

  function leftoverRuns(dataRoot: string): string[] {
    const stateDir = join(dataRoot, "omp-runtime");
    return existsSync(stateDir)
      ? readdirSync(stateDir).filter((entry) => entry.startsWith(`${RUN_ROOT_PREFIX}-`))
      : [];
  }

  it("verifies, starts under isolation, negotiates v2, and is reclaimed", async () => {
    const dataRoot = scratch("real");
    // Decoys at the paths a child would reach if the isolation variables were
    // forwarded: nothing here may be created or written.
    const decoys = join(dataRoot, "decoy-user");
    const xdg = join(decoys, "xdg");
    const profile = join(decoys, "omp-profile");
    mkdirSync(xdg, { recursive: true });
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "canary"), "must not be touched\n");
    const decoyDataRoot = join(decoys, "pi-desktop");
    mkdirSync(decoyDataRoot, { recursive: true });

    const seen: { home?: string; configRoot?: string; launchDir?: string } = {};
    const supervisor = makeSupervisor(dataRoot, {
      extraEnv: {
        XDG_CONFIG_HOME: xdg,
        XDG_DATA_HOME: xdg,
        OMP_PROFILE: profile,
        PI_DESKTOP_DATA_DIR: decoyDataRoot,
      },
      prepareRun: (paths) => {
        seen.home = paths.home;
        seen.configRoot = paths.configRoot;
        seen.launchDir = paths.launchDir;
        writeModelCatalog(paths.agentDir);
      },
    });

    try {
      const status = await supervisor.start();
      expect(status.phase).toBe("idle");
      // The identity assertion on the real artifact: the compiled binary
      // reported the pinned version and the handshake settled on protocol v2.
      expect(status.runtimeVersion).toBe(OMP_RUNTIME_VERSION);
      expect(status.protocolVersion).toBe(2);
      expect(status.reason).toBeNull();

      // Isolation: HOME and the config root stayed inside this run's owned
      // directory, and the steering variables never reached the child.
      expect(seen.home?.startsWith(join(dataRoot, "omp-runtime"))).toBe(true);
      expect(seen.home?.endsWith("home")).toBe(true);
      expect(seen.home).not.toBe(process.env.HOME);
      expect(seen.configRoot?.startsWith(seen.home as string)).toBe(true);
      expect(readdirSync(xdg)).toEqual([]);
      expect(readdirSync(profile)).toEqual(["canary"]);
      expect(readdirSync(decoyDataRoot)).toEqual([]);
      expect(existsSync(seen.home as string)).toBe(true);

      const result = await supervisor.stop();
      expect(result.stopped).toBe(true);
      expect(result.reaped).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(leftoverRuns(dataRoot)).toEqual([]);
    } finally {
      await supervisor.reclaimAll().catch(() => undefined);
    }
  }, 300_000);

  it("reclaims the run when the sidecar dies abnormally", async () => {
    const dataRoot = scratch("abnormal");
    const supervisor = makeSupervisor(dataRoot, {
      prepareRun: ({ agentDir }) => writeModelCatalog(agentDir),
    });
    try {
      await supervisor.start();
      const runtime = supervisor.currentRuntime();
      expect(runtime).not.toBeNull();
      const pgid = runtime?.pgid as number;
      // Kill the whole group from outside, as a crash of the machine or an
      // operator `kill -9` would: the stop path must still find nothing alive
      // and remove the owned run directory.
      process.kill(-pgid, "SIGKILL");
      expect(await waitFor(() => !processAlive(pgid), 10_000)).toBe(true);

      const result = await supervisor.stop();
      expect(result.cleaned).toBe(true);
      expect(result.reaped).toBe(true);
      expect(leftoverRuns(dataRoot)).toEqual([]);
    } finally {
      await supervisor.reclaimAll().catch(() => undefined);
    }
  }, 300_000);

  it("cleans up when the sidecar never becomes ready", async () => {
    const dataRoot = scratch("timeout");
    const supervisor = makeSupervisor(dataRoot, {
      readyTimeoutMs: 50,
      prepareRun: ({ agentDir }) => writeModelCatalog(agentDir),
    });
    try {
      await expect(supervisor.start()).rejects.toMatchObject({ code: "ready-timeout" });
      expect(supervisor.status().phase).toBe("failed");
      expect(leftoverRuns(dataRoot)).toEqual([]);
    } finally {
      await supervisor.reclaimAll().catch(() => undefined);
    }
  }, 300_000);
});
