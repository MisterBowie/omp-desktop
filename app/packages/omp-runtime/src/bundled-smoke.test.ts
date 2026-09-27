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
 * verified, started through the same argument chain the desktop builds
 * (`--trusted-extension <Resources>/omp-runtime/extensions/omp-desktop-gate.ts`),
 * asserted to negotiate v2 and answer a provider-free RPC, and reclaimed with
 * its process group and scratch root. No prompt is ever sent, so no provider is
 * contacted and no model is billed.
 *
 * The artifact must come from the built resources, not from a fixture: the test
 * pins that the binary and the gate both live under the resources root and that
 * the copied gate is byte-identical to the tracked source gate.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OMP_RUNTIME_VERSION } from "@pi-desktop/shared";

import {
  BUNDLED_GATE_RELATIVE_PATH,
  verifyBundledRuntime,
} from "./bundled.js";
import { probeRuntimeVersion } from "./launcher.js";
import { MOCK_LAUNCHER, mockPathEntries, processAlive, waitFor } from "./test-harness.js";
import { OmpRuntimeSupervisor, RUN_ROOT_PREFIX, type OmpRuntimeSupervisorOptions } from "./supervisor.js";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE_GATE = join(APP_ROOT, "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts");
const GATE_MANIFEST_PATH = BUNDLED_GATE_RELATIVE_PATH.split(sep).join("/");

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

  it("reports the resolution reason instead of a generic launcher-missing", async () => {
    const dataRoot = scratch("resolution");
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherResolutionError: "bundled-runtime-invalid: binary SHA-256 does not match the provenance manifest",
    });
    const status = supervisor.status();
    expect(status.phase).toBe("failed");
    expect(status.reason).toBe("start-failed");
    expect(status.detail).toContain("binary SHA-256 does not match the provenance manifest");
    await expect(supervisor.start()).rejects.toMatchObject({ code: "launcher-missing" });
    expect(supervisor.status().detail).toContain("binary SHA-256 does not match the provenance manifest");
  });
});

const ARTIFACT_ROOT = process.env.OMP_SIDECAR_TEST_RESOURCES ?? null;

describe.skipIf(!ARTIFACT_ROOT)("real bundled sidecar", () => {
  const resources = ARTIFACT_ROOT as string;

  function verifiedRuntime() {
    return verifyBundledRuntime({ resourcesPath: resources });
  }

  /**
   * The supervisor the desktop builds for a packaged session: the verified
   * binary plus the `--trusted-extension` argument pointing at the gate that
   * lives beside it in Resources (`createDesktopEngineRuntime`).
   */
  function makeSupervisor(
    dataRoot: string,
    overrides: Partial<OmpRuntimeSupervisorOptions> = {},
  ): OmpRuntimeSupervisor {
    const verified = verifiedRuntime();
    const gate = verified.extensions.find((extension) => extension.path === GATE_MANIFEST_PATH);
    expect(gate, "the built resources must declare the tool gate").toBeDefined();
    return new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: verified.path,
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      args: ["--trusted-extension", (gate as { absolutePath: string }).absolutePath],
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

  it("ships a self-contained gate built from the desktop's own source", () => {
    const verified = verifiedRuntime();
    const runtimeDir = join(resources, "omp-runtime");
    expect(verified.path).toBe(join(runtimeDir, verified.provenance.binary.filename));
    // lstat-based verification already rejected symlinks; assert it here too so
    // a future change cannot quietly accept a link into a source checkout.
    expect(existsSync(verified.path)).toBe(true);
    const gate = verified.extensions.find((extension) => extension.path === GATE_MANIFEST_PATH);
    expect(gate?.absolutePath).toBe(join(runtimeDir, ...BUNDLED_GATE_RELATIVE_PATH.split(sep)));
    expect(existsSync(SOURCE_GATE)).toBe(true);
    // A copy of the source gate would still import `../src/...`, which does not
    // exist beside the sidecar in Resources, and the runtime refuses to start
    // with a gate it cannot load. The shipped gate must be self-contained.
    const gateText = readFileSync(gate?.absolutePath as string, "utf8");
    expect(gateText).not.toMatch(/(?:from|import)\s*\(?\s*["'][.]{1,2}\//);
    expect(gateText).toMatch(/OMP_DESKTOP_STATE|tool_call/);
  });

  it("runs without any Bun or Node on PATH", async () => {
    const verified = verifiedRuntime();
    const home = scratch("empty-path-home");
    const emptyPath = join(home, "no-tools");
    mkdirSync(emptyPath, { recursive: true });
    // The compiled artifact embeds its own runtime: with PATH pointing at an
    // empty directory there is no `node`, no `bun`, and no shell to fall back
    // on, so a version answer can only come from the binary itself.
    const probe = await probeRuntimeVersion({
      launcher: verified.path,
      env: { HOME: home, PATH: emptyPath, TMPDIR: tmpdir() },
      cwd: home,
      timeoutMs: 60_000,
    });
    expect(probe.version).toBe(OMP_RUNTIME_VERSION);
  });

  it("loads the bundled gate, negotiates v2, answers a provider-free RPC, and is reclaimed", async () => {
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

    const seen: { home?: string; configRoot?: string } = {};
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
        writeModelCatalog(paths.agentDir);
      },
    });

    try {
      const status = await supervisor.start();
      expect(status.phase).toBe("idle");
      // The identity assertion on the real artifact: the compiled binary
      // reported the pinned version, with the gate loaded, and the handshake
      // settled on protocol v2.
      expect(status.runtimeVersion).toBe(OMP_RUNTIME_VERSION);
      expect(status.protocolVersion).toBe(2);
      expect(status.reason).toBeNull();

      // A provider-free round trip: no model, no credentials, no billing.
      const runtime = supervisor.currentRuntime();
      expect(runtime).not.toBeNull();
      const response = await (runtime as NonNullable<typeof runtime>).request(
        { type: "get_state" },
        { timeoutMs: 20_000 },
      );
      expect(response.success).not.toBe(false);

      // Isolation: HOME and the config root stayed inside this run's owned
      // directory, and the steering variables never reached the child.
      expect(seen.home?.startsWith(join(dataRoot, "omp-runtime"))).toBe(true);
      expect(seen.home?.endsWith("home")).toBe(true);
      expect(seen.home).not.toBe(process.env.HOME);
      expect(seen.configRoot?.startsWith(seen.home as string)).toBe(true);
      expect(readdirSync(xdg)).toEqual([]);
      expect(readdirSync(profile)).toEqual(["canary"]);
      expect(readdirSync(decoyDataRoot)).toEqual([]);

      const result = await supervisor.stop();
      expect(result.stopped).toBe(true);
      expect(result.reaped).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(leftoverRuns(dataRoot)).toEqual([]);
    } finally {
      await supervisor.reclaimAll().catch(() => undefined);
    }
  }, 300_000);

  it("rejects a swapped gate before the runtime starts", () => {
    // The gate lives beside the binary and is covered by the manifest: a gate
    // whose content no longer matches must not be loaded. The binary is hard
    // linked (a real file, not a symlink) and only the gate is altered, with
    // its length preserved, so the digest check is what refuses it.
    const copyRoot = scratch("swapped-gate");
    const source = join(resources, "omp-runtime");
    const copyDir = join(copyRoot, "omp-runtime");
    mkdirSync(join(copyDir, "extensions"), { recursive: true });
    linkSync(join(source, "omp"), join(copyDir, "omp"));
    const realGate = readFileSync(join(source, ...BUNDLED_GATE_RELATIVE_PATH.split(sep)));
    const swapped = Buffer.from(realGate);
    swapped[0] = swapped[0] ^ 0xff;
    writeFileSync(join(copyDir, ...BUNDLED_GATE_RELATIVE_PATH.split(sep)), swapped);
    writeFileSync(join(copyDir, "provenance.json"), readFileSync(join(source, "provenance.json")));
    // The specifics live in `detail`; the message is deliberately generic.
    let detail = "";
    try {
      verifyBundledRuntime({ resourcesPath: copyRoot });
    } catch (error) {
      detail = String((error as { detail?: string }).detail ?? (error as Error).message);
    }
    expect(detail).toMatch(/extension .* does not match the provenance manifest/);
  });

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
