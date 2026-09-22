import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import {
  ENGINE_CAPABILITY_KEYS,
  ErrorCodes,
  OMP_ENGINE_CAPABILITIES,
  PI_ENGINE_CAPABILITIES,
  closedEngineCapabilities,
  engineCapabilities,
} from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");

/** Status provider reporting both engines as available. */
function idleStatus(engine) {
  return {
    engine,
    phase: "idle",
    runtimeVersion: null,
    protocolVersion: null,
    reason: null,
    capabilities: engineCapabilities(engine),
  };
}

/** A status provider whose phase the test controls per engine. */
function routerWith(phases = {}) {
  return createEngineRouter({
    status: (engine) => ({
      engine,
      phase: phases[engine] ?? "idle",
      runtimeVersion: null,
      protocolVersion: null,
      reason: null,
      capabilities: engineCapabilities(engine),
    }),
  });
}

test("a session without an engine belongs to Pi", async () => {
  const router = routerWith();
  assert.equal(router.engineOf({}), "pi");
  assert.equal(router.engineOf({ engine: undefined }), "pi");
  assert.equal(router.engineOf(null), "pi");
  assert.equal(router.engineOf(undefined), "pi");
  // A value this build does not know must not become the newest engine.
  assert.equal(router.engineOf({ engine: "claude" }), "pi");
  assert.equal(router.engineOf({ engine: "OMP" }), "pi");
  assert.equal(router.engineOf({ engine: "omp" }), "omp");
});

test("a transcript source is never read as an engine", async () => {
  const router = routerWith();
  // `source` answers "who owns the transcript"; feeding it to the router must
  // not move a native or remote session onto another engine.
  for (const source of ["desktop", "pi-native", "remote"]) {
    assert.equal(router.engineOf({ source }), "pi", source);
  }
});

test("Pi keeps every capability open while its runtime is up", async () => {
  const router = routerWith();
  for (const capability of ENGINE_CAPABILITY_KEYS) {
    assert.equal(router.require({}, capability), "pi", capability);
  }
});

test("a stopped runtime closes a statically supported capability", async () => {
  const router = routerWith({ pi: "stopped" });
  assert.throws(
    () => router.require({}, "prompt"),
    (error) => {
      assert.equal(error.errorCode, ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE);
      assert.equal(error.engine, "pi");
      assert.equal(error.capability, "prompt");
      assert.match(error.message, /does not support "prompt"/);
      return true;
    },
  );
  assert.equal(router.status("pi").phase, "stopped");
  assert.deepEqual(router.liveCapabilities("pi"), closedEngineCapabilities());
});

test("an OMP session is refused every capability this release has not shipped", async () => {
  const router = routerWith();
  assert.deepEqual(router.liveCapabilities("omp"), OMP_ENGINE_CAPABILITIES);
  for (const capability of ENGINE_CAPABILITY_KEYS) {
    assert.throws(
      () => router.require({ engine: "omp" }, capability),
      (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
      capability,
    );
  }
  // The refusal names the engine it refused, so a caller can never mistake it
  // for a Pi failure it should retry on another path.
  assert.throws(
    () => router.require({ engine: "omp" }, "prompt"),
    (error) => error.message.includes("omp") && error.capability === "prompt",
  );
});

test("supports() answers without throwing, for UI affordances", async () => {
  const router = routerWith();
  assert.equal(router.supports({}, "prompt"), true);
  assert.equal(router.supports({ engine: "omp" }, "prompt"), false);
  assert.equal(router.supports({ engine: "omp" }, "branch"), false);
});

test("a persisted Pi session is still Pi, and an OMP one is OMP", async () => {
  const router = createEngineRouter({
    status: idleStatus,
    sessionEngine: async (sessionId) => (sessionId === "omp-session" ? "omp" : "pi"),
  });
  assert.equal(await router.engineForSession("omp-session"), "omp");
  assert.equal(await router.engineForSession("legacy-session"), "pi");
  await assert.rejects(
    () => router.requireForSession("omp-session", "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.equal(await router.requireForSession("legacy-session", "prompt"), "pi");
});

test("a record without an engine field is a legacy Pi session", async () => {
  // The only case that may read as Pi: the read succeeded and the record
  // predates the engine field.
  const router = createEngineRouter({
    status: idleStatus,
    sessionEngine: async () => null,
  });
  assert.equal(await router.engineForSession("legacy"), "pi");
  assert.equal(await router.requireForSession("legacy", "prompt"), "pi");
});

test("a failed engine lookup refuses instead of assuming Pi", async () => {
  const router = createEngineRouter({
    status: idleStatus,
    sessionEngine: async () => {
      throw new Error("host unavailable");
    },
  });
  await assert.rejects(
    () => router.engineForSession("unknown"),
    (error) => {
      assert.equal(error.errorCode, ErrorCodes.ENGINE_UNAVAILABLE);
      assert.match(error.message, /host unavailable/);
      return true;
    },
  );
  // The refusal must stop the operation before any runtime is entered: an
  // unknown session is not a legacy session.
  await assert.rejects(
    () => router.requireForSession("unknown", "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_UNAVAILABLE,
  );
});

test("an engine value this build does not know refuses", async () => {
  const router = createEngineRouter({
    status: idleStatus,
    sessionEngine: async () => "claude",
  });
  await assert.rejects(
    () => router.requireForSession("future-session", "prompt"),
    (error) => {
      assert.equal(error.errorCode, ErrorCodes.ENGINE_UNAVAILABLE);
      assert.match(error.message, /does not know: claude/);
      return true;
    },
  );
});

test("a router without a lookup refuses id-only gates", async () => {
  const router = createEngineRouter({ status: idleStatus });
  await assert.rejects(
    () => router.requireForSession("some-session", "prompt"),
    (error) => error.errorCode === ErrorCodes.ENGINE_UNAVAILABLE,
  );
});

test("a status provider that throws cannot open a capability", async () => {
  const router = createEngineRouter({
    status: () => {
      throw new Error("no supervisor");
    },
  });
  assert.equal(router.status("omp").phase, "failed");
  assert.deepEqual(router.liveCapabilities("pi"), closedEngineCapabilities());
  assert.throws(() => router.require({}, "prompt"));
});

test("engine capability declarations stay complete for both engines", async () => {
  const router = routerWith();
  for (const engine of ["pi", "omp"]) {
    assert.deepEqual(
      Object.keys(router.capabilities(engine)).sort(),
      [...ENGINE_CAPABILITY_KEYS].sort(),
      engine,
    );
  }
  assert.equal(router.capabilities("pi"), PI_ENGINE_CAPABILITIES);
  assert.equal(router.capabilities("omp"), OMP_ENGINE_CAPABILITIES);
  // An engine the router does not know reads as Pi's declaration, never OMP's.
  assert.equal(router.capabilities("bogus"), PI_ENGINE_CAPABILITIES);
});
