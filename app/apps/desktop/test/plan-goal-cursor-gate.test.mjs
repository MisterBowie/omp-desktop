import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as sharedProtocol from "../../../packages/shared/src/protocol.ts";

/**
 * T20-R3C: a session may not combine an active Cursor model/provider with Plan
 * or Goal mode (user-approved product decision; the Cursor exec channel cannot
 * honour PI's transition-tool contract — docs/validation/M5-omp-transition-patch.md
 * §9/§10).
 *
 * These drive the real IPC handlers, so they prove the invariant holds at the
 * boundaries that accept a transition, a model change, or a new session — not
 * merely that the renderer hides a control. Every refusal must also prove it
 * happened *before* any runtime work or durable write.
 */
const { IPC } = sharedProtocol;

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}

const sharedGate = await import("../../../packages/shared/src/plan-goal-model-gate.ts");

const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": { ErrorCodes, ...sharedProtocol, ...sharedGate },
  "../importers": {},
  "../services/session-collaboration": { readSessionCollaboration: async () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
});

const PLAN_SESSION = "plan-session";
const CURSOR_PROVIDER = "cursor";

function engineRouterFor(engineFor) {
  return {
    async requireForSession(sessionId, capability) {
      return engineFor(sessionId, capability);
    },
    require(session) {
      return session?.engine ?? "pi";
    },
    supports() {
      return true;
    },
  };
}

/**
 * Prompt path. `records` maps a session id to the durable record the host
 * answers `session.get` with (mode/providerId/modelId/engine).
 */
function promptHarness({ records, ompPromptCalls = [], hostCalls = [], sidecarCalls = [], bridgeCalls = [] }) {
  const handlers = new Map();
  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      if (method === "session.get") {
        const record = records[params?.id];
        return record ? { session: { id: params.id, ...record } } : { session: null };
      }
      if (method === "settings.get") return {};
      if (method === "session.beginTurn") return { turnId: "turn-1" };
      if (method === "session.getEngineRef") return { engineRef: null };
      return {};
    },
  };
  const sidecar = {
    async call(method, params) {
      sidecarCalls.push({ method, params });
      return { accepted: true, turnId: "turn-1" };
    },
    setProjectInstructionRoot() {},
    clearProjectInstructionRoot() {},
    clearVendorAuthBindings() {},
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => ({
      queue: { push: async () => ({ id: "turn-queued" }), list: () => [], remove: async () => {}, prioritize: async () => {}, reorder: async () => ({ moved: true }), sessionOf: () => null },
      settleApproval() {},
      markAborting() {},
    }),
    engineRouter: engineRouterFor((id) => records[id]?.engine ?? "pi"),
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
    dispatchApprovedPlan: async () => {},
    dispatchExecutionForProposal: async () => {},
    emitAgentEvent() {},
    setNotificationViewingSessionId() {},
    isTurnDispatchable: () => true,
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
    resolveSessionMessageInput: async () => undefined,
    ompSessions: {
      async prompt(input) {
        ompPromptCalls.push(input);
        return { accepted: true, turnId: "turn-1" };
      },
    },
  });
  return { handlers, hostCalls, sidecarCalls, bridgeCalls };
}

const prompt = (handlers, sessionId) =>
  handlers.get(IPC.invoke.agentPrompt)({ sessionId, content: "hello" });

/** Configure/create path. */
function sessionHarness({ records, ompConfigureCalls = [], hostCalls = [] }) {
  const handlers = new Map();
  const host = {
    async call(method, input) {
      hostCalls.push({ method, input });
      if (method === "session.get") {
        const record = records[input?.id];
        return record ? { session: { id: input.id, ...record } } : { session: null };
      }
      if (method === "session.configure") return { session: { id: input?.id, ...records[input?.id], ...input } };
      if (method === "session.create") {
        return { session: { id: "created", ...input } };
      }
      if (method === "session.delete") return { ok: true };
      return {};
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({ call: async () => ({}), clearProjectInstructionRoot() {}, clearVendorAuthBindings() {} }),
    dataDir: "/unused",
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: { dropSession: async () => {} },
    logger: { app() {} },
    plugins: { broadcastEvent() {} },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (session) => ({ ...session, supportsReasoning: false, supportsVision: false, supportedThinkingLevels: ["off"] }),
    acquireSessionOperation: async () => () => {},
    stripWinLongPrefix: (value) => value,
    engineRouter: engineRouterFor((id) => records[id]?.engine ?? "omp"),
    ompSessions: {
      async configure(sessionId, config) {
        ompConfigureCalls.push({ sessionId, config });
        return { ok: true };
      },
      async disposeSession() {
        return { ok: true, failures: [] };
      },
      async rename() {
        return { ok: true };
      },
    },
  });
  return { handlers, hostCalls, ompConfigureCalls };
}

const isCursorRefusal = (error) => error.errorCode === ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED;

test("a persisted Plan session bound to Cursor is refused before any runtime work", async () => {
  const records = { [PLAN_SESSION]: { engine: "pi", mode: "plan", providerId: CURSOR_PROVIDER, modelId: "claude-4.6-opus-high" } };
  const { handlers, sidecarCalls, hostCalls } = promptHarness({ records });
  await assert.rejects(() => prompt(handlers, PLAN_SESSION), (error) => {
    assert.equal(isCursorRefusal(error), true, `unexpected refusal: ${error.message}`);
    // The payload names the pair, so the renderer can render `errors.<code>`
    // and the reason is not flattened into a generic error.
    assert.equal(error.mode, "plan");
    assert.equal(error.providerId, CURSOR_PROVIDER);
    return true;
  });
  assert.equal(sidecarCalls.length, 0, "no Pi turn may start for the refused pair");
  assert.equal(hostCalls.some((call) => call.method === "agent.prompt"), false);
});

test("a persisted Goal session bound to Cursor is refused on the OMP path too", async () => {
  const records = { [PLAN_SESSION]: { engine: "omp", mode: "goal", providerId: CURSOR_PROVIDER, modelId: "gpt-5.2" } };
  const ompPromptCalls = [];
  const { handlers } = promptHarness({ records, ompPromptCalls });
  await assert.rejects(() => prompt(handlers, PLAN_SESSION), (error) => {
    assert.equal(isCursorRefusal(error), true, `unexpected refusal: ${error.message}`);
    assert.equal(error.mode, "goal");
    return true;
  });
  assert.equal(ompPromptCalls.length, 0, "no OMP prompt may be dispatched");
});

test("Agent mode with the Cursor provider still prompts", async () => {
  const records = { [PLAN_SESSION]: { engine: "omp", mode: "agent", providerId: CURSOR_PROVIDER, modelId: "claude-4.6-opus-high" } };
  const ompPromptCalls = [];
  const { handlers } = promptHarness({ records, ompPromptCalls });
  await prompt(handlers, PLAN_SESSION);
  assert.equal(ompPromptCalls.length, 1, "a normal Cursor session outside Plan/Goal keeps working");
  assert.equal(ompPromptCalls[0].providerId, CURSOR_PROVIDER);
});

test("Plan mode on a normal provider still dispatches", async () => {
  // OMP branch: the whole prompt path runs, so the runtime call itself proves it.
  {
    const records = { [PLAN_SESSION]: { engine: "omp", mode: "plan", providerId: "openai", modelId: "gpt-5.2" } };
    const ompPromptCalls = [];
    const { handlers } = promptHarness({ records, ompPromptCalls });
    await prompt(handlers, PLAN_SESSION);
    assert.equal(ompPromptCalls.length, 1, "a Plan session on a normal provider still reaches its runtime");
  }
  // Pi branch: reaching the durable turn is past the gate; the turn itself is
  // owned by the Pi-side tests, not re-implemented in this stub.
  {
    const records = { [PLAN_SESSION]: { engine: "pi", mode: "plan", providerId: "openai", modelId: "gpt-5.2" } };
    const { handlers, hostCalls } = promptHarness({ records });
    await prompt(handlers, PLAN_SESSION).catch((error) => {
      assert.equal(isCursorRefusal(error), false, "the gate must not fire for a non-Cursor provider");
    });
    assert.equal(
      hostCalls.some((call) => call.method === "session.beginTurn"),
      true,
      "a Plan session on a normal provider still enters its turn",
    );
  }
});

test("providers that only resemble Cursor are not refused", async () => {
  for (const providerId of ["Cursor", "CURSOR", " cursor", "plugin:acme:cursor"]) {
    const records = { [PLAN_SESSION]: { engine: "pi", mode: "plan", providerId, modelId: "m" } };
    const { handlers } = promptHarness({ records });
    await prompt(handlers, PLAN_SESSION).catch((error) => {
      assert.equal(isCursorRefusal(error), false, `provider ${providerId} must not be matched by name`);
    });
  }
});

test("entering Plan or Goal on a Cursor-bound session is refused without a write", async () => {
  for (const mode of ["plan", "goal"]) {
    const records = { [PLAN_SESSION]: { engine: "omp", mode: "agent", providerId: CURSOR_PROVIDER, modelId: "m" } };
    const ompConfigureCalls = [];
    const { handlers, hostCalls } = sessionHarness({ records, ompConfigureCalls });
    await assert.rejects(
      () => handlers.get(IPC.invoke.sessionConfigure)(PLAN_SESSION, { mode }),
      (error) => {
        assert.equal(isCursorRefusal(error), true, `entering ${mode} must be refused: ${error.message}`);
        assert.equal(error.mode, mode);
        return true;
      },
    );
    assert.equal(ompConfigureCalls.length, 0, "the OMP bridge must not see the refused configuration");
    assert.equal(hostCalls.some((call) => call.method === "session.configure"), false);
  }
});

test("binding the Cursor provider while Plan is active is refused without a write", async () => {
  const records = { [PLAN_SESSION]: { engine: "pi", mode: "plan", providerId: "openai", modelId: "gpt-5.2" } };
  const { handlers, hostCalls } = sessionHarness({ records });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionConfigure)(PLAN_SESSION, { mode: "plan", providerId: CURSOR_PROVIDER, modelId: "m" }),
    (error) => isCursorRefusal(error),
  );
  assert.equal(hostCalls.some((call) => call.method === "session.configure"), false, "no durable write may happen");
});

test("a model change that carries no mode is judged against the stored mode", async () => {
  const records = { [PLAN_SESSION]: { engine: "omp", mode: "goal", providerId: "openai", modelId: "gpt-5.2" } };
  const ompConfigureCalls = [];
  const { handlers } = sessionHarness({ records, ompConfigureCalls });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionConfigure)(PLAN_SESSION, { providerId: CURSOR_PROVIDER, modelId: "m" }),
    (error) => isCursorRefusal(error),
  );
  assert.equal(ompConfigureCalls.length, 0);
});

test("both escape paths stay open and non-Cursor sessions are unchanged", async () => {
  // (a) leaving Plan mode for Agent keeps the Cursor model: the mode-side fix.
  {
    const records = { [PLAN_SESSION]: { engine: "omp", mode: "plan", providerId: CURSOR_PROVIDER, modelId: "m" } };
    const ompConfigureCalls = [];
    const { handlers } = sessionHarness({ records, ompConfigureCalls });
    await handlers.get(IPC.invoke.sessionConfigure)(PLAN_SESSION, { mode: "agent" });
    assert.equal(ompConfigureCalls.length, 1, "switching to Agent must be accepted");
  }
  // (b) keeping Plan mode and choosing another model: the model-side fix.
  {
    const records = { [PLAN_SESSION]: { engine: "omp", mode: "plan", providerId: CURSOR_PROVIDER, modelId: "m" } };
    const ompConfigureCalls = [];
    const { handlers } = sessionHarness({ records, ompConfigureCalls });
    await handlers.get(IPC.invoke.sessionConfigure)(PLAN_SESSION, { mode: "plan", providerId: "openai", modelId: "gpt-5.2" });
    assert.equal(ompConfigureCalls.length, 1, "choosing another model must be accepted");
  }
  // (c) an ordinary provider in Plan mode.
  {
    const records = { [PLAN_SESSION]: { engine: "pi", mode: "plan", providerId: "openai", modelId: "gpt-5.2" } };
    const { handlers, hostCalls } = sessionHarness({ records });
    await handlers.get(IPC.invoke.sessionConfigure)(PLAN_SESSION, { mode: "plan", providerId: "anthropic", modelId: "claude-sonnet" });
    assert.equal(hostCalls.some((call) => call.method === "session.configure"), true);
  }
});

test("creating a session cannot persist the refused pair", async () => {
  const records = {};
  const { handlers, hostCalls } = sessionHarness({ records });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionCreate)({ title: "t", mode: "plan", providerId: CURSOR_PROVIDER, modelId: "m" }),
    (error) => isCursorRefusal(error),
  );
  assert.equal(hostCalls.some((call) => call.method === "session.create"), false, "no session may be created");
  await handlers.get(IPC.invoke.sessionCreate)({ title: "t", mode: "plan", providerId: "openai", modelId: "gpt-5.2" });
  assert.equal(hostCalls.some((call) => call.method === "session.create"), true);
});
