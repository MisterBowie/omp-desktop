/**
 * No-cost smoke test against the pinned OMP runtime.
 *
 * What this proves that the mock cannot: a real `omp --mode rpc-ui` process,
 * started through this package's own launcher resolution and isolation, reaches
 * `ready`, negotiates protocol v2, answers a local command, and is reclaimed
 * with its process group and its scratch directory. No prompt is ever sent, so
 * no provider is contacted and no model is billed.
 *
 * Skipped when this checkout has no pinned launcher (the reference submodule is
 * not initialized): a missing reference is a checkout state, not a failure of
 * the runtime boundary.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { OMP_RUNTIME_VERSION } from "@pi-desktop/shared";

import { OmpRuntimeSupervisor, RUN_ROOT_PREFIX } from "./supervisor.js";
import { findPinnedLauncher } from "./launcher.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = findPinnedLauncher(PACKAGE_ROOT);
const dataRoot = join(tmpdir(), `omp-runtime-smoke-${process.pid}`);

/**
 * A model catalog for the child, so it reaches `ready` without any credential.
 *
 * The provider is a closed local port: nothing is ever sent to it, because this
 * test never prompts. The runtime needs the catalog only to have a model to
 * start with; the desktop projects the user's own configuration here in M4.
 */
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

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe.skipIf(!LAUNCHER)("pinned runtime smoke", () => {
  it("starts, negotiates v2, answers, and is reclaimed with its scratch root", async () => {
    expect(LAUNCHER).toBeTruthy();
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: LAUNCHER,
      // The one place a real version string is read: the pin this build ships.
      expectedRuntimeVersion: OMP_RUNTIME_VERSION,
      readyTimeoutMs: 60_000,
      requestTimeoutMs: 20_000,
      selfExitMs: 5_000,
      terminationGraceMs: 5_000,
      prepareRun: ({ agentDir }) => writeModelCatalog(agentDir),
    });

    try {
      const status = await supervisor.start();
      expect(status.phase).toBe("idle");
      expect(status.runtimeVersion).toBe(OMP_RUNTIME_VERSION);
      expect(status.protocolVersion).toBe(2);
      expect(status.reason).toBeNull();
      expect(status.capabilities.prompt).toBe(true);
      expect(status.capabilities.toolApproval).toBe(true);
      expect(status.capabilities.resume).toBe(true);

      const result = await supervisor.stop();
      expect(result.reaped).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(result.stopped).toBe(true);
      // The isolated run root is gone; the state directory it lived in may stay.
      const stateDir = join(dataRoot, "omp-runtime");
      const leftovers = existsSync(stateDir)
        ? readdirSync(stateDir).filter((entry) => entry.startsWith(`${RUN_ROOT_PREFIX}-`))
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      await supervisor.reclaimAll().catch(() => undefined);
    }
  }, 180_000);
});
