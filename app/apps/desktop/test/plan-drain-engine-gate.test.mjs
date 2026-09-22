import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";

/**
 * The restore/drain path must decide the engine before it changes anything
 * durable (review S2B).
 *
 * `plans.claimExecution` moves a queued execution to running, and the failure
 * path rewrites it as interrupted. Gating afterwards therefore leaves a row
 * mutated for a runtime that never ran it. These tests drive the real
 * `createPlanRuntime` — not a source excerpt — and count what the host saw.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);

const PI_SESSION = "pi-session";
const OMP_SESSION = "omp-session";

/** A validated execution descriptor: the drain drops descriptors it cannot read. */
function queuedExecution(sessionId) {
  return {
    id: `execution-${sessionId}`,
    proposalId: `proposal-${sessionId}`,
    sessionId,
    kind: "plan",
    state: "queued",
    plan: "1. do the thing",
    title: "Approved plan",
    question: "Proceed?",
    artifact: { relativePath: ".pi/plans/plan.md", sha256: "a".repeat(64), sizeBytes: 12 },
  };
}

/** Everything the plan runtime needs, with the calls it makes recorded. */
function harness({ queued, engineFor, engineRouter = null }) {
  const hostCalls = [];
  const sidecarCalls = [];
  const logs = [];
  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      switch (method) {
        case "plans.queuedExecutions":
          return { executions: queued };
        case "session.get":
          return { session: { id: params.id, engine: await engineFor(params.id) } };
        case "settings.get":
          return {};
        case "plans.claimExecution":
          return { execution: { ...queued[0], state: "running" } };
        case "session.beginTurn":
          return { turnId: "turn-1" };
        default:
          return {};
      }
    },
  };
  const sidecar = {
    async call(method, params) {
      sidecarCalls.push({ method, params });
      return { accepted: true };
    },
  };
  const dependencies = {
    runtimeState: { host, sidecar, agentHostBridge: null },
    planState: {},
    logger: {
      app: (...args) =>
        logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")),
    },
    sendToRenderer: () => {},
    // The real coordination instance: the plan finalizer reads turn state by
    // name from it, and a stub would only prove the stub works.
    coordination: createSessionCoordination({
      activeTurns: new Map(),
      getMainWindow: () => null,
      getViewingSessionId: () => null,
    }),
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(),
    finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(),
    pendingExecutionFinishes: new Map(),
    announceTurnEnded: () => {},
    emitAgentEvent: () => {},
    acquireSessionOperation: async () => () => {},
    resolveAgentRuntimeLaunch: async () => ({
      providerId: "provider",
      modelId: "model",
      projectPath: "/tmp/project",
      sidecarParams: { sessionId: "any" },
    }),
    getEngineRouter:
      engineRouter ??
      (() =>
        createEngineRouter({
          status: (engine) => ({
            engine,
            phase: "idle",
            runtimeVersion: null,
            protocolVersion: null,
            reason: null,
            capabilities: {},
          }),
          sessionEngine: async (sessionId) => engineFor(sessionId),
        })),
    isQuitting: () => false,
  };
  return { dependencies, hostCalls, sidecarCalls, logs };
}

const methodsOf = (calls) => calls.map((entry) => entry.method);

test("a queued execution for another engine is skipped without touching anything", async () => {
  const { dependencies, hostCalls, sidecarCalls, logs } = harness({
    queued: [queuedExecution(OMP_SESSION)],
    engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi"),
  });
  await createPlanRuntime(dependencies).drainApprovedPlanExecutions();

  // The only host work is reading the queue and the session's engine: no state
  // transition, no turn, no execution, no interruption rewrite.
  assert.deepEqual(methodsOf(hostCalls), ["plans.queuedExecutions", "session.get"]);
  assert.deepEqual(sidecarCalls, [], "no Pi runtime method may be called");
  const reported = logs.join(" ");
  assert.match(reported, /approved plan execution skipped/);
  assert.match(reported, new RegExp(ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE));
});

test("a queued execution for a Pi session still dispatches", async () => {
  const { dependencies, hostCalls, sidecarCalls } = harness({
    queued: [queuedExecution(PI_SESSION)],
    engineFor: async () => "pi",
  });
  await createPlanRuntime(dependencies).drainApprovedPlanExecutions();

  const methods = methodsOf(hostCalls);
  assert.ok(methods.includes("plans.claimExecution"), methods.join(","));
  assert.ok(methods.includes("session.beginTurn"), methods.join(","));
  assert.deepEqual(
    sidecarCalls.map((entry) => entry.method),
    ["agent.executeApprovedPlan"],
  );
});

test("a composition without the engine gate claims nothing", async () => {
  const { dependencies, hostCalls, sidecarCalls } = harness({
    queued: [queuedExecution(PI_SESSION)],
    engineFor: async () => "pi",
    engineRouter: () => null,
  });
  await createPlanRuntime(dependencies).drainApprovedPlanExecutions();

  assert.equal(
    hostCalls.filter((entry) => entry.method === "plans.claimExecution").length,
    0,
    "an unattributable execution must not be claimed",
  );
  assert.deepEqual(sidecarCalls, []);
});
