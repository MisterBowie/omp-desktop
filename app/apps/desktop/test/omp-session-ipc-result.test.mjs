import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { err, ok, ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as sharedProtocol from "../../../packages/shared/src/protocol.ts";

/**
 * J1: the `inconsistent` marker must survive the REAL IPC Result contract,
 * through BOTH surfaces:
 *
 * 1. The main-process side: this test loads the real `registerIpcHandlers`
 *    (and therefore its real `wrap()`), registers the real `sessionConfigure`
 *    handler through it, and asserts the `Result` a renderer `invoke()`
 *    consumes — `result.error.details` — carries `inconsistent: true`.
 *
 * 2. The renderer side: it then imports the real `src/lib/api.ts`, installs a
 *    `window.piDesktop.invoke` bridge backed by that wrapped handler, calls the
 *    real `api.configureSession(...)`, and asserts the final caught Error has
 *    `error.code === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE`,
 *    `error.details.inconsistent === true`, and the useful configure reason in
 *    `error.message`.
 */

const { IPC } = sharedProtocol;

// The transpiled main modules resolve `@pi-desktop/shared` from the object
// below, and the Plan/Goal × Cursor gate lives in that package, so the hook and
// the module must exist before the first `load()` runs.
const { register: registerImportHooks } = await import("node:module");
registerImportHooks(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const sharedPlanGoalGate = await import("../../../packages/shared/src/plan-goal-model-gate.ts");

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}

// The real session handler under test.
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": { ErrorCodes, ...sharedProtocol, ...sharedPlanGoalGate },
  "../importers": {},
  "../services/session-collaboration": { readSessionCollaboration: async () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
});

const noop = () => {};
const noopRegister = () => {};

// The real `registerIpcHandlers` wrapper, with every sibling registrar mocked
// out except the real `registerSessionIpc` under test.
const { registerIpcHandlers } = load("../electron/main/ipc/register.ts", {
  "node:path": path,
  electron: { dialog: {} },
  "@pi-desktop/shared": { err, ok, ErrorCodes, IPC },
  "../remote/backend-router": { ROUTE_LOCAL: Symbol("local") },
  "../agent-extensions-ipc": { registerAgentExtensionIpc: noopRegister },
  "../npm-preferences": { readNpmPath: noop, writeNpmPath: noop },
  "./agent-ipc": { registerAgentIpc: noopRegister },
  "./app-ipc": { registerAppIpc: noopRegister },
  "./diagnostics-ipc": { registerDiagnosticsIpc: noopRegister },
  "./market-ipc": { registerMarketIpc: noopRegister },
  "./mcp-ipc": { registerMcpIpc: noopRegister },
  "../mcp-registry-catalog": { searchMcpMarket: noop },
  "./notification-ipc": { registerNotificationIpc: noopRegister },
  "./plugin-ipc": { registerPluginIpc: noopRegister },
  "./plugin-ui-ipc": { registerPluginUiIpc: noopRegister },
  "./provider-ipc": { registerProviderIpc: noopRegister },
  "./pulls-ipc": { registerPullsIpc: noopRegister },
  "./scheduled-ipc": { registerScheduledIpc: noopRegister },
  "./session-ipc": { registerSessionIpc },
  "./settings-ipc": { registerSettingsIpc: noopRegister },
  "./skills-ipc": { registerSkillsIpc: noopRegister },
  "./agent-import-ipc": { registerAgentImportIpc: noopRegister },
  "./remote-host-ipc": { registerRemoteHostIpc: noopRegister },
  "../skill-market-catalog": { fetchSkillMarketDocument: noop, searchSkillMarket: noop },
  "./window-ipc": { registerWindowIpc: noopRegister },
  "./workspace-ipc": { createComposerTemplateLoader: () => noop, registerWorkspaceIpc: noopRegister },
  "./composer-ipc": { registerComposerIpc: noopRegister },
  "./speech-ipc": { registerSpeechIpc: noopRegister },
});

function harness({ ompConfigure } = {}) {
  const wrapped = new Map();
  const ipcMain = { handle: (channel, fn) => wrapped.set(channel, fn) };
  const host = { call: async () => ({}) };
  registerIpcHandlers({
    ipcMain,
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
    engineRouter: { async engineForSession() { return "omp"; }, async requireForSession() { return "omp"; } },
    ompSessions: {
      async configure() {
        return ompConfigure?.() ?? { ok: true };
      },
      async rename() { return { ok: true }; },
      async disposeSession() { return { ok: true, failures: [] }; },
    },
    traySessions: { observeInvoke() {}, setPreferences() {} },
  });
  return { wrapped };
}

// The REAL renderer API surface. Node 24 strips `api.ts` itself; the
// extensionless/`.js`->`.ts` sibling hook resolves any transitive relative
// imports, and `@pi-desktop/shared` resolves through the workspace package
// (same channel strings as the source modules loaded above).
const { register } = await import("node:module");
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");

test("J1: registerIpcHandlers wraps a configure refusal so error.details.inconsistent === true", async () => {
  const { wrapped } = harness({
    ompConfigure: () => ({ ok: false, reason: "the thinking level could not be reverted", inconsistent: true }),
  });
  const handler = wrapped.get(IPC.invoke.sessionConfigure);
  assert.ok(handler, "sessionConfigure must be registered through the real wrapper");

  const result = await handler({}, "omp-session-1", { mode: "agent", thinkingLevel: "high" });
  assert.equal(result.ok, false, "the refusal must be a Result failure");
  assert.equal(result.error.code, ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE, "the typed error code must survive");
  assert.match(result.error.message, /thinking level could not be reverted/, "the useful message must survive");
  assert.equal(result.error.details?.inconsistent, true, "the marker must reach error.details (the renderer contract)");
});

test("J1: a clean configure success still flows through the wrapper as an ok Result", async () => {
  const { wrapped } = harness({ ompConfigure: () => ({ ok: true }) });
  const result = await wrapped.get(IPC.invoke.sessionConfigure)({}, "omp-session-1", { mode: "agent" });
  assert.equal(result.ok, true);
});

test("J1: renderer api.configureSession rejects with the caught Error carrying error.details.inconsistent === true", async () => {
  const { wrapped } = harness({
    ompConfigure: () => ({ ok: false, reason: "the thinking level could not be reverted", inconsistent: true }),
  });
  const previous = globalThis.window;
  try {
    // A controlled preload bridge backed by the real wrapped handler above, so
    // the real renderer `invoke()` reads a real Result and converts it exactly
    // as production does.
    globalThis.window = {
      piDesktop: {
        invoke: async (channel, ...args) => {
          assert.equal(channel, IPC.invoke.sessionConfigure, "the renderer must call sessionConfigure");
          const handler = wrapped.get(channel);
          assert.ok(handler, "sessionConfigure must be registered through the real wrapper");
          return handler({}, ...args);
        },
        on: () => () => {},
        channels: IPC,
        platform: "linux",
      },
    };
    await assert.rejects(
      api.configureSession("omp-session-1", { mode: "agent", thinkingLevel: "high" }),
      (error) => {
        assert.equal(error.code, ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE, "the typed error code must reach the renderer");
        assert.match(error.message, /thinking level could not be reverted/, "the useful configure reason must survive");
        assert.equal(error.details?.inconsistent, true, "the marker must reach the caught renderer Error");
        return true;
      },
    );
  } finally {
    globalThis.window = previous;
  }
});
