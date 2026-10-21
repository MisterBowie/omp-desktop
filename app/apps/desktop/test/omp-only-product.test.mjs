import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
register(pathToFileURL(join(import.meta.dirname, "helpers/ts-import-hooks.mjs")));
const { normalizeEngineId, engineCapabilities } = await import("@pi-desktop/shared");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");
const { createRuntimeLifecycle } = await import("../electron/main/runtime/lifecycle.ts");

test("the product defaults to OMP and exposes no Pi execution capabilities", async () => {
  assert.equal(normalizeEngineId(undefined), "omp");
  assert.equal(normalizeEngineId(null), "omp");
  assert.equal(Object.values(engineCapabilities("pi")).some(Boolean), false);
  const router = createEngineRouter({
    sessionEngine: async () => "pi",
    status: (engine) => ({ engine, phase: "idle", capabilities: engineCapabilities(engine) }),
  });
  await assert.rejects(router.requireForSession("old-pi", "prompt"), {
    errorCode: "ENGINE_CAPABILITY_UNAVAILABLE",
  });
});

test("normal boot and restart never start the retired Pi agent sidecar", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-only-boot-"));
  let piStarts = 0;
  const state = { host: null, sidecar: null };
  const host = { call: async (method) => {
    if (method === "plugins.list") return { plugins: [] };
    if (method === "workspace.get") return { workspace: null };
    return {};
  } };
  const lifecycle = createRuntimeLifecycle({
    runtimeState: state, dataDir: directory,
    logger: { app() {} }, sendToRenderer() {},
    startHost: async () => { state.host = host; },
    startSidecar: async () => { piStarts++; },
    drainApprovedPlanExecutions: async () => {},
    applyNetworkProxyFromAppSettings: async () => {},
    plugins: { setServices() {} }, setCurrentWorkspacePath() {}, rememberPluginScopes() {},
    refreshUserMcp: async () => {}, isQuitting: () => false, getDisplayLocale: () => "en",
  });
  try {
    await lifecycle.bootBackends();
    assert.equal(piStarts, 0);
    await assert.rejects(lifecycle.superviseRestart("sidecar"), /OMP/);
    assert.equal(piStarts, 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
