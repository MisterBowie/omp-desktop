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
const { createDesktopEngineRuntime, createDesktopEngineRuntimeForApp, reclaimOwnedRuntime } = await import(
  "../electron/main/runtime/engine-runtime.ts"
);

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

/** The status the OMP adapter reports when its runtime is stopped. */
function closedOmpStatus() {
  return {
    engine: "omp",
    phase: "stopped",
    runtimeVersion: null,
    protocolVersion: null,
    reason: "not-started",
    capabilities: closedEngineCapabilities(),
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

test("Pi status is retired even when an old worker is available", () => {
  for (const piLive of [true, false]) {
    const product = runtime({piLive});
    assert.equal(product.status("pi").phase, "stopped");
    assert.deepEqual(product.status("pi").capabilities, closedEngineCapabilities());
    assert.throws(() => product.engineRouter.require({engine: "pi"}, "prompt"),
      {errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE});
    assert.equal(product.engineRouter.require({}, "prompt"), "omp");
  }
});

test("OMP status comes from its runtime, and unshipped capabilities stay closed", () => {
  const idleOmp = runtime({
    ompStatus: {
      engine: "omp",
      phase: "idle",
      runtimeVersion: "18.3.0",
      protocolVersion: 2,
      reason: "not-implemented",
      capabilities: OMP_ENGINE_CAPABILITIES,
    },
  });
  const status = idleOmp.status("omp");
  assert.equal(status.phase, "idle");
  assert.equal(status.runtimeVersion, "18.3.0");
  assert.equal(status.protocolVersion, 2);
  assert.equal(status.reason, "not-implemented");
  // Running is not the same as shipped: only the capabilities M4 implements
  // are open, and the rest are refused even with the runtime up.
  assert.equal(idleOmp.engineRouter.require({ engine: "omp" }, "prompt"), "omp");
  assert.throws(
    () => idleOmp.engineRouter.require({ engine: "omp" }, "branch"),
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

test("boot wiring reads the engine from the host and gates id-only callers", async () => {
  // The production composition: the app factory builds a host-backed lookup,
  // so a stored `engine: "omp"` session is refused by the gate instead of being
  // served by the Pi runtime.
  const calls = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      if (method !== "session.get") throw new Error(`unexpected RPC ${method}`);
      return params.id === "omp-session"
        ? { session: { id: params.id, engine: "omp" } }
        : { session: { id: params.id, engine: "pi" } };
    },
  };
  const runtime = createDesktopEngineRuntimeForApp({
    dataRoot: "/tmp/engine-runtime-app-test",
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    getHost: () => host,
    piRuntimeLive: () => true,
    ompAdapterFactory: () => fakeOmpRuntime(closedOmpStatus()),
  });

  // A legacy record (no engine field) still prompts on Pi.
  assert.equal(await runtime.engineRouter.engineForSession("legacy-session"), "pi");

  // An OMP session is refused for a capability this release has not shipped,
  // with the engine and capability named, before any runtime call could happen.
  await assert.rejects(
    () => runtime.engineRouter.requireForSession("omp-session", "branch"),
    (error) => {
      assert.equal(error.errorCode, ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE);
      assert.equal(error.engine, "omp");
      assert.equal(error.capability, "branch");
      return true;
    },
  );
  assert.equal(await runtime.engineRouter.requireForSession("omp-session", "followUp"), "omp");
  // The capabilities M3 does ship pass the gate for the same session.
  assert.equal(await runtime.engineRouter.requireForSession("omp-session", "stop"), "omp");
  // The lookup itself is the only RPC made: the gate never reached a runtime,
  // and every read was the durable session record.
  assert.ok(calls.length >= 3, `expected one lookup per gate call, got ${calls.length}`);
  assert.deepEqual([...new Set(calls.map((entry) => entry.method))], ["session.get"]);
});

test("a failing host read blocks the gate instead of falling back to Pi", async () => {
  const host = {
    async call() {
      throw new Error("host unavailable");
    },
  };
  const runtime = createDesktopEngineRuntimeForApp({
    dataRoot: "/tmp/engine-runtime-app-test",
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    getHost: () => host,
    piRuntimeLive: () => true,
    ompAdapterFactory: () => fakeOmpRuntime(closedOmpStatus()),
  });
  await assert.rejects(
    () => runtime.engineRouter.requireForSession("any-session", "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_UNAVAILABLE,
  );
});

test("a missing host process blocks the gate", async () => {
  const runtime = createDesktopEngineRuntimeForApp({
    dataRoot: "/tmp/engine-runtime-app-test",
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    getHost: () => null,
    piRuntimeLive: () => true,
    ompAdapterFactory: () => fakeOmpRuntime(closedOmpStatus()),
  });
  await assert.rejects(
    () => runtime.engineRouter.requireForSession("any-session", "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_UNAVAILABLE,
  );
});

test("reclaim reports a rejected and a partial reclaim to its logger", async () => {
  const logged = [];
  const log = (message, fields) => logged.push({ message, ...fields });
  await reclaimOwnedRuntime(
    {
      reclaim: async () => {
        throw new Error("supervisor exploded");
      },
    },
    log,
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /reclaim failed/);
  assert.equal(logged[0].code, "OMP_RUNTIME_RECLAIM_FAILED");
  assert.match(logged[0].data, /supervisor exploded/);

  logged.length = 0;
  await reclaimOwnedRuntime(
    {
      reclaim: async () => [
        { stopped: true, reaped: true, cleaned: true, steps: [], errors: [] },
        {
          stopped: false,
          reaped: false,
          cleaned: false,
          steps: ["sent SIGTERM to group"],
          errors: ["process group 42 is still populated"],
        },
      ],
    },
    log,
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].code, "OMP_RUNTIME_CLEANUP_FAILED");
  assert.match(logged[0].data, /still populated/);

  logged.length = 0;
  await reclaimOwnedRuntime(
    { reclaim: async () => [{ stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }] },
    log,
  );
  assert.deepEqual(logged, []);
});

test("an engine the status function does not model still answers conservatively", () => {
  const withRuntime = runtime();
  const status = withRuntime.status("pi");
  assert.equal(status.engine, "pi");
  assert.deepEqual(Object.keys(status.capabilities).sort(), [...ENGINE_CAPABILITY_KEYS].sort());
});
