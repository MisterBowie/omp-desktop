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

test("a session without an engine defaults to OMP", () => {
  const router = routerWith();
  for (const record of [{}, {engine: undefined}, null, undefined]) assert.equal(router.engineOf(record), "omp");
});

test("transcript source never selects an execution engine", () => {
  for (const source of ["desktop", "pi-native", "remote"])
    assert.equal(routerWith().engineOf({source}), "omp");
});

test("Pi is refused even if a retired status provider says idle", () => {
  for (const capability of ENGINE_CAPABILITY_KEYS) assert.throws(
    () => routerWith().require({engine: "pi"}, capability),
    {errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE},
  );
});

test("a stopped OMP runtime retains its declared prompt capability", () => {
  const router = routerWith({omp: "stopped"});
  assert.equal(router.status("omp").phase, "stopped");
  assert.deepEqual(router.liveCapabilities("omp"), closedEngineCapabilities());
  assert.equal(router.require({}, "prompt"), "omp");
});

test("an OMP session is refused every capability this release has not shipped", async () => {
  const router = routerWith();
  assert.deepEqual(router.liveCapabilities("omp"), OMP_ENGINE_CAPABILITIES);
  // M4 ships prompt/stop/resume/modelSwitch/structuredQuestions/toolApproval;
  // M5/T17 adds subagentEvents; M5/T20 adds the Plan/Goal contract modes.
  const shipped = new Set(["prompt", "stop", "resume", "steer", "followUp", "modelSwitch", "structuredQuestions", "toolApproval", "subagentEvents", "plan", "goal"]);
  for (const capability of ENGINE_CAPABILITY_KEYS) {
    if (shipped.has(capability)) {
      assert.equal(router.require({ engine: "omp" }, capability), "omp", capability);
      continue;
    }
    assert.throws(
      () => router.require({ engine: "omp" }, capability),
      (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
      capability,
    );
  }
  // The refusal names the engine it refused, so a caller can never mistake it
  // for a Pi failure it should retry on another path.
  assert.throws(
    () => router.require({ engine: "omp" }, "branch"),
    (error) => error.message.includes("omp") && error.capability === "branch",
  );
});

test("supports() answers without throwing, for UI affordances", async () => {
  const router = routerWith();
  assert.equal(router.supports({}, "prompt"), true);
  assert.equal(router.supports({ engine: "omp" }, "prompt"), true);
  assert.equal(router.supports({ engine: "omp" }, "branch"), false);
  assert.equal(router.supports({ engine: "omp" }, "steer"), true);
  assert.equal(router.supports({ engine: "omp" }, "followUp"), true);
});

test("requireContractMode refuses a declared-closed Plan/Goal before anything writes", async () => {
  // The shipped table declares both modes on both engines...
  for (const engine of ["omp"]) {
    for (const mode of ["plan", "goal"]) routerWith().requireContractMode(engine, mode);
  }
  // ...and a runtime that is merely stopped is an outage, not a closed
  // declaration: the mode stays offered while the process restarts.
  routerWith({ omp: "stopped" }).requireContractMode("omp", "plan");

  // An engine whose declaration omits Plan is refused, with the engine, the
  // capability and the shared refusal code intact.
  const closedPlan = { ...engineCapabilities("omp"), plan: false };
  const router = createEngineRouter({
    status: idleStatus,
    capabilities: (engine) => (engine === "omp" ? closedPlan : engineCapabilities(engine)),
  });
  assert.equal(router.requireContractMode("omp", "goal"), undefined);
  assert.throws(
    () => router.requireContractMode("omp", "plan"),
    (error) =>
      error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE &&
      error.capability === "plan" &&
      error.engine === "omp",
  );
  // Agent and non-contract values name no capability: there is nothing to
  // judge, and that is not the same answer as "allowed".
  for (const value of ["agent", "chat", null, undefined, "", 7]) {
    assert.equal(router.requireContractMode("omp", value), undefined);
  }
  // The declaration table also drives require(): a closed Plan key does not
  // leak into unrelated capabilities.
  assert.equal(router.require({ engine: "omp" }, "goal"), "omp");
  assert.throws(
    () => router.require({ engine: "omp" }, "plan"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
});

test("a persisted Pi session is still Pi, and an OMP one is OMP", async () => {
  const router = createEngineRouter({
    status: idleStatus,
    sessionEngine: async (sessionId) => (sessionId === "omp-session" ? "omp" : "pi"),
  });
  assert.equal(await router.engineForSession("omp-session"), "omp");
  assert.equal(await router.engineForSession("legacy-session"), "pi");
  // An OMP session is served by the OMP engine — never by Pi — and a capability
  // this release has not shipped is still refused.
  assert.equal(await router.requireForSession("omp-session", "prompt"), "omp");
  await assert.rejects(
    () => router.requireForSession("omp-session", "branch"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  await assert.rejects(router.requireForSession("legacy-session", "prompt"), {errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE});
});

test("an omitted engine resolves to the OMP product default", async () => {
  // The only case that may read as Pi: the read succeeded and the record
  // predates the engine field.
  const router = createEngineRouter({
    status: idleStatus,
    sessionEngine: async () => null,
  });
  assert.equal(await router.engineForSession("legacy"), "omp");
  assert.equal(await router.requireForSession("legacy", "prompt"), "omp");
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
  // The status reports the failure instead of inventing availability.
  assert.equal(router.status("omp").phase, "failed");
  assert.deepEqual(router.liveCapabilities("pi"), closedEngineCapabilities());
  // A runtime that cannot report its status has no live capabilities, for
  // either engine: the shipped OMP capabilities are declarations, and a
  // declaration does not make a dead runtime able to serve a prompt.
  assert.deepEqual(router.liveCapabilities("omp"), closedEngineCapabilities());
  // A capability no release has shipped is refused whatever the status says.
  assert.throws(
    () => router.require({ engine: "omp" }, "branch"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
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
  assert.equal(router.capabilities("bogus"), OMP_ENGINE_CAPABILITIES);
});
