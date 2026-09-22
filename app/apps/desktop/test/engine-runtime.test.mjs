import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import {
  ENGINE_CAPABILITY_KEYS,
  ErrorCodes,
  OMP_ENGINE_CAPABILITIES,
  closedEngineCapabilities,
} from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createDesktopEngineRuntime } = await import("../electron/main/runtime/engine-runtime.ts");

/** A stand-in for the OMP adapter: only the status it reports matters here. */
function fakeOmpRuntime(status) {
  return {
    launcher: "/nonexistent/omp",
    launcherSource: null,
    tried: [],
    status: () => status,
    start: async () => status,
    stop: async () => ({ stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }),
    reclaim: async () => [],
    supervisor: () => {
      throw new Error("not used");
    },
  };
}

function runtime({
  piLive = true,
  ompStatus = {
    engine: "omp",
    phase: "stopped",
    runtimeVersion: null,
    protocolVersion: null,
    reason: "not-started",
    capabilities: closedEngineCapabilities(),
  },
} = {}) {
  return createDesktopEngineRuntime({
    dataRoot: "/tmp/engine-runtime-test",
    isPackaged: false,
    appPath: "/tmp/app",
    piRuntimeLive: () => piLive,
    ompAdapterFactory: () => fakeOmpRuntime(ompStatus),
  });
}

test("Pi reports idle only while both of its processes are up", () => {
  const live = runtime({ piLive: true });
  assert.equal(live.status("pi").phase, "idle");
  assert.equal(live.status("pi").reason, null);
  for (const capability of ENGINE_CAPABILITY_KEYS) {
    assert.equal(live.engineRouter.supports({}, capability), true, capability);
  }

  const down = runtime({ piLive: false });
  assert.equal(down.status("pi").phase, "stopped");
  assert.equal(down.status("pi").reason, "not-started");
  // A runtime that is down closes its capabilities even though Pi supports them.
  assert.deepEqual(down.status("pi").capabilities, closedEngineCapabilities());
  assert.throws(
    () => down.engineRouter.require({}, "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
});

test("OMP status comes from its runtime, and its capabilities stay closed", () => {
  const idleOmp = runtime({
    ompStatus: {
      engine: "omp",
      phase: "idle",
      runtimeVersion: "18.2.7",
      protocolVersion: 2,
      reason: "not-implemented",
      capabilities: OMP_ENGINE_CAPABILITIES,
    },
  });
  const status = idleOmp.status("omp");
  assert.equal(status.phase, "idle");
  assert.equal(status.runtimeVersion, "18.2.7");
  assert.equal(status.protocolVersion, 2);
  assert.equal(status.reason, "not-implemented");
  // Running is not the same as shipped: no capability opens in this release.
  assert.throws(
    () => idleOmp.engineRouter.require({ engine: "omp" }, "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );

  const failed = runtime({
    ompStatus: {
      engine: "omp",
      phase: "failed",
      runtimeVersion: null,
      protocolVersion: null,
      reason: "version-mismatch",
      detail: "the runtime reports 18.2.9",
      capabilities: closedEngineCapabilities(),
    },
  });
  assert.equal(failed.status("omp").reason, "version-mismatch");
});

test("the runtime a caller gets is the owner of the OMP supervisor", async () => {
  const withRuntime = runtime();
  // The adapter this module returns is the one whose reclaim the shutdown path
  // calls; a second construction would leave the first runtime unowned.
  const results = await withRuntime.ompRuntime.reclaim();
  assert.deepEqual(results, []);
  assert.equal(withRuntime.ompRuntime.launcher, "/nonexistent/omp");
});

test("an engine the status function does not model still answers conservatively", () => {
  const withRuntime = runtime();
  const status = withRuntime.status("pi");
  assert.equal(status.engine, "pi");
  assert.deepEqual(Object.keys(status.capabilities).sort(), [...ENGINE_CAPABILITY_KEYS].sort());
});
