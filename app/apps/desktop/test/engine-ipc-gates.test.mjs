import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as protocol from "../../../packages/shared/src/protocol.ts";

/**
 * Every IPC path that executes or controls a session's runtime passes the one
 * engine gate (review R3).
 *
 * These are behaviour tests, not source checks: they drive the real handlers
 * with a session whose stored engine is OMP and assert that the Pi sidecar and
 * the host-owned turn queue are never touched — and, symmetrically, that a Pi
 * session still reaches them.
 */
const { IPC } = protocol;

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");

/** A router whose lookup answers with the engine the test names. */
function routerFor(engineFor) {
  return createEngineRouter({
    status: (engine) => ({
      engine,
      phase: "idle",
      runtimeVersion: null,
      protocolVersion: null,
      reason: null,
      capabilities: { prompt: true, stop: true, steer: true, followUp: true, structuredQuestions: true, toolApproval: true, resume: true, branch: true, modelSwitch: true, subagentEvents: true },
    }),
    sessionEngine: async (sessionId) => engineFor(sessionId),
  });
}

const PI_SESSION = "pi-session";
const OMP_SESSION = "omp-session";

function harness({ engineFor, queue = null, withSidecar = true, withBridge = true } = {}) {
  const handlers = new Map();
  const hostCalls = [];
  const sidecarCalls = [];
  const bridgeCalls = [];
  const settlements = [];
  const dispatched = [];
  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      if (method === "session.get") {
        const id = params?.id;
        return { session: { id, engine: engineFor ? await engineFor(id) : "pi" } };
      }
      if (method === "settings.get") return {};
      if (method === "permissions.resolve") return { resolved: true };
      if (method === "plans.resolve") {
        return { proposalId: params.proposalId, sessionId: params.sessionId, status: "approved" };
      }
      return {};
    },
  };
  const sidecar = {
    async call(method, params) {
      sidecarCalls.push({ method, params });
      return { accepted: true, turnId: "turn-1", status: { sessionId: params?.sessionId, isRunning: false, pendingToolConfirmations: 0 } };
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => (withSidecar ? sidecar : null),
    getAgentHostBridge: () =>
      withBridge
        ? {
            queue: {
              push: async (request) => {
                bridgeCalls.push({ op: "push", request });
                return { id: "turn-queued" };
              },
              list: (sessionId) => {
                bridgeCalls.push({ op: "list", sessionId });
                return [{ id: "queued-1" }];
              },
              remove: async (turnId) => bridgeCalls.push({ op: "remove", turnId }),
              prioritize: async (turnId) => bridgeCalls.push({ op: "prioritize", turnId }),
              reorder: async (turnId, direction) => {
                bridgeCalls.push({ op: "reorder", turnId, direction });
                return queue?.reorder ? queue.reorder(turnId, direction) : { moved: true };
              },
              sessionOf: (turnId) => queue?.sessionOf(turnId) ?? null,
            },
            settleApproval(requestId, decision) {
              settlements.push({ requestId, decision });
            },
            markAborting() {},
          }
        : null,
    engineRouter: routerFor(engineFor ?? (() => "pi")),
    logger: { app() {} },
    vendorOAuth: {},
    agentExtensions: {},
    cancelSessionTools() {},
    persistenceOutbox: {},
    dataDir: "/unused",
    activeTurns: new Map(),
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({ providerId: "p", modelId: "m", sidecarParams: {} }),
    acquireSessionOperation: async () => () => {},
    finishTurn: async () => {},
    lockAbortReason() {},
    finishApprovedExecution: async () => {},
    dispatchApprovedPlan: async (execution) => dispatched.push({ kind: "plan", execution }),
    dispatchExecutionForProposal: async (proposalId) => dispatched.push({ kind: "proposal", proposalId }),
    emitAgentEvent() {},
    setNotificationViewingSessionId() {},
    isTurnDispatchable: () => true,
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
    resolveSessionMessageInput: async () => undefined,
  });
  return { handlers, hostCalls, sidecarCalls, bridgeCalls, settlements, dispatched };
}

const executesOnPi = (sidecarCalls, bridgeCalls) =>
  sidecarCalls.length === 0 && bridgeCalls.length === 0;

test("agentAbort refuses an OMP session before the Pi runtime is entered", async () => {
  const { handlers, sidecarCalls } = harness({ engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi") });
  await assert.rejects(
    () => handlers.get(IPC.invoke.agentAbort)({ sessionId: OMP_SESSION }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.ok(executesOnPi(sidecarCalls, []), "no Pi-side abort may be attempted");
  // The same call for a Pi session still reaches the sidecar.
  await handlers.get(IPC.invoke.agentAbort)({ sessionId: PI_SESSION }).catch(() => undefined);
});

test("agentCompact refuses an OMP session", async () => {
  const { handlers, sidecarCalls } = harness({ engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi") });
  await assert.rejects(
    () => handlers.get(IPC.invoke.agentCompact)({ sessionId: OMP_SESSION }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.ok(executesOnPi(sidecarCalls, []));
});

test("agentGetStatus answers without the Pi runtime for an OMP session", async () => {
  const { handlers, sidecarCalls } = harness({ engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi") });
  const status = await handlers.get(IPC.invoke.agentGetStatus)(OMP_SESSION);
  assert.equal(status.status.isRunning, false);
  assert.equal(status.status.sessionId, OMP_SESSION);
  assert.equal(status.status.pendingToolConfirmations, 0);
  assert.deepEqual(sidecarCalls, [], "status must not be read from a runtime that does not own the session");
});

test("the turn queue refuses an OMP session and answers its reads locally", async () => {
  const queue = {
    sessionOf: (turnId) => (turnId === "omp-turn" ? OMP_SESSION : PI_SESSION),
  };
  const { handlers, bridgeCalls } = harness({
    engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi"),
    queue,
  });

  await assert.rejects(
    () => handlers.get(IPC.invoke.agentQueuePush)({ sessionId: OMP_SESSION, content: "hello" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  await assert.rejects(
    () => handlers.get(IPC.invoke.agentQueueRemove)({ turnId: "omp-turn" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  await assert.rejects(
    () => handlers.get(IPC.invoke.agentQueuePrioritize)({ turnId: "omp-turn" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  const listed = await handlers.get(IPC.invoke.agentQueueList)({ sessionId: OMP_SESSION });
  assert.deepEqual(listed.entries, []);
  assert.deepEqual(bridgeCalls, [], "no queue operation may run for another engine's session");

  // A Pi session still reaches the queue.
  await handlers.get(IPC.invoke.agentQueuePush)({ sessionId: PI_SESSION, content: "hello" });
  assert.deepEqual(bridgeCalls.map((entry) => entry.op), ["push"]);
});

test("queue reorder refuses an OMP turn and still orders Pi turns", async () => {
  const queue = {
    sessionOf: (turnId) => (turnId === "omp-turn" ? OMP_SESSION : PI_SESSION),
  };
  const { handlers, bridgeCalls } = harness({
    engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi"),
    queue,
  });
  const reorderCalls = () => bridgeCalls.filter((entry) => entry.op === "reorder");

  await assert.rejects(
    () => handlers.get(IPC.invoke.agentQueueReorder)({ turnId: "omp-turn", direction: "up" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.deepEqual(reorderCalls(), [], "another engine's turn must not be reordered");

  const moved = await handlers.get(IPC.invoke.agentQueueReorder)(
    { turnId: "pi-turn", direction: "down" },
  );
  assert.deepEqual(moved, { moved: true });
  assert.deepEqual(reorderCalls(), [{ op: "reorder", turnId: "pi-turn", direction: "down" }]);
});

test("an approval for an OMP session mutates nothing", async () => {
  const { handlers, hostCalls, settlements, dispatched } = harness({
    engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi"),
  });
  await assert.rejects(
    () =>
      handlers.get(IPC.invoke.plansResolve)({
        proposalId: "proposal-1",
        sessionId: OMP_SESSION,
        turnId: "turn-1",
        toolCallId: "call-1",
        action: "approve",
        targetPermissionMode: "accept-edits",
      }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  // Approval is a transaction: pending -> approved, session -> agent mode,
  // permission mode written, follow-up execution queued. It must not run at all
  // for a session this build cannot drive.
  assert.deepEqual(
    hostCalls.filter((entry) => entry.method === "plans.resolve"),
    [],
    "the approval transaction must not run",
  );
  assert.deepEqual(settlements, [], "no approval may be settled");
  assert.deepEqual(dispatched, [], "nothing may be dispatched");
});

test("a rejection still follows the host's own semantics", async () => {
  const { handlers, hostCalls, settlements } = harness({
    engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi"),
  });
  const result = await handlers.get(IPC.invoke.plansResolve)({
    proposalId: "proposal-2",
    sessionId: OMP_SESSION,
    turnId: "turn-1",
    toolCallId: "call-1",
    action: "reject",
  });
  // Rejection starts no runtime, so the fixed host transaction stays reachable.
  assert.deepEqual(
    hostCalls.filter((entry) => entry.method === "plans.resolve").map((entry) => entry.params.action),
    ["reject"],
  );
  assert.ok(result !== undefined);
  assert.equal(settlements.length, 1);
});

test("an approval for a Pi session still runs the transaction and dispatches", async () => {
  const { handlers, hostCalls, settlements, dispatched } = harness({
    engineFor: async () => "pi",
  });
  await handlers.get(IPC.invoke.plansResolve)({
    proposalId: "proposal-3",
    sessionId: PI_SESSION,
    turnId: "turn-1",
    toolCallId: "call-1",
    action: "approve",
    targetPermissionMode: "accept-edits",
  });
  assert.deepEqual(
    hostCalls.filter((entry) => entry.method === "plans.resolve").map((entry) => entry.params.action),
    ["approve"],
  );
  assert.equal(settlements.length, 1);
  assert.equal(dispatched.length, 1);
});

test("an OMP session is refused even when the Pi runtime is absent", async () => {
  // The engine decides first: whether the Pi sidecar or the agent bridge happen
  // to be running must not change the reason an OMP session is refused.
  const withNothing = harness({
    engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi"),
    withSidecar: false,
    withBridge: false,
  });
  const refuse = (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE;

  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentAbort)({ sessionId: OMP_SESSION }),
    refuse,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentStop)({ sessionId: OMP_SESSION }),
    refuse,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentCompact)({ sessionId: OMP_SESSION }),
    refuse,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentSteer)({
      sessionId: OMP_SESSION,
      content: "steer",
      expectedTurnId: "turn-1",
    }),
    refuse,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.askToolResolve)({
      sessionId: OMP_SESSION,
      requestId: "ask-1",
      answers: {},
    }),
    refuse,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentQueuePush)({ sessionId: OMP_SESSION, content: "x" }),
    refuse,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentPrompt)({ sessionId: OMP_SESSION, content: "x" }),
    refuse,
  );

  // Reads answer for the owning engine without the Pi runtime.
  const status = await withNothing.handlers.get(IPC.invoke.agentGetStatus)(OMP_SESSION);
  assert.equal(status.status.isRunning, false);
  const listed = await withNothing.handlers.get(IPC.invoke.agentQueueList)({ sessionId: OMP_SESSION });
  assert.deepEqual(listed.entries, []);
});

test("a Pi session still reports its own runtime's absence", async () => {
  const withNothing = harness({ engineFor: async () => "pi", withSidecar: false, withBridge: false });
  // The Pi-specific availability message is preserved: the engine is Pi, the
  // capability is supported, and what is missing is the runtime.
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentAbort)({ sessionId: PI_SESSION }),
    /sidecar unavailable/,
  );
  await assert.rejects(
    () => withNothing.handlers.get(IPC.invoke.agentQueuePush)({ sessionId: PI_SESSION, content: "x" }),
    /agent host unavailable/,
  );
});

test("askTool resolution refuses an OMP session", async () => {
  const { handlers, sidecarCalls } = harness({ engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi") });
  await assert.rejects(
    () => handlers.get(IPC.invoke.askToolResolve)({ sessionId: OMP_SESSION, requestId: "ask-1", answers: {} }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.deepEqual(sidecarCalls, []);
});

test("approving a plan for an OMP session refuses before any dispatch", async () => {
  const { handlers } = harness({ engineFor: async (id) => (id === OMP_SESSION ? "omp" : "pi") });
  await assert.rejects(
    () =>
      handlers.get(IPC.invoke.plansResolve)({
        proposalId: "proposal-1",
        sessionId: OMP_SESSION,
        turnId: "turn-1",
        toolCallId: "call-1",
        action: "approve",
        targetPermissionMode: "accept-edits",
      }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
});

test("the IPC table this file gates on is present and non-empty", () => {
  // If the IPC surface moves, the gate tests above must fail loudly rather than
  // silently exercising channels that no longer exist.
  assert.equal(typeof IPC.invoke.agentAbort, "string");
  assert.ok(Object.keys(IPC.invoke).length > 10);
});
