import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as sharedProtocol from "../../../packages/shared/src/protocol.ts";

/**
 * H3: the sessionConfigure IPC must carry `inconsistent` through the error, and
 * delete/archive must fail closed when an OMP session has no wired runtime.
 */
const shared = { ErrorCodes, ...sharedProtocol };
const { IPC } = sharedProtocol;

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

const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": shared,
  "../importers": {},
  "../services/session-collaboration": { readSessionCollaboration: async () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
});

function harness({ ompSessions = null, engineFor } = {}) {
  const handlers = new Map();
  const calls = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      if (method === "session.configure") return { session: { id: input?.id } };
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
    engineRouter: { async requireForSession(sessionId, capability) { return engineFor?.(sessionId, capability) ?? "omp"; } },
    ompSessions,
  });
  return { handlers, calls };
}

test("H3: sessionConfigure carries inconsistent through the IPC error", async () => {
  const { handlers } = harness({
    ompSessions: {
      async configure() {
        return { ok: false, reason: "the thinking level could not be reverted", inconsistent: true };
      },
      async disposeSession() { return { ok: true, failures: [] }; },
      async rename() { return { ok: true }; },
    },
  });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionConfigure)("omp-session-1", { mode: "agent", thinkingLevel: "high" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && error.inconsistent === true,
  );
});

test("H3: delete fails closed when an OMP session has no wired runtime", async () => {
  const { handlers, calls } = harness({ ompSessions: null });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionDelete)("omp-session-1"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && /no OMP runtime/.test(error.message),
  );
  assert.equal(calls.some((call) => call.method === "session.delete"), false, "the host row must not be deleted");
});

test("H3: archive fails closed when an OMP session has no wired runtime", async () => {
  const { handlers } = harness({ ompSessions: null });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionArchive)("omp-session-1"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && /no OMP runtime/.test(error.message),
  );
});
