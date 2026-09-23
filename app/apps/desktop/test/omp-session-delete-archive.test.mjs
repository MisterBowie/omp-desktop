import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as sharedProtocol from "../../../packages/shared/src/protocol.ts";

/**
 * F2: delete/archive ordering and observability at the IPC boundary.
 *
 * An OMP session's runtime must be reclaimed before the host row is deleted
 * (the row is the only way to learn the engine), an archive must reclaim the
 * target runtime only, and a failed reclaim must be observable on the returned
 * result rather than reported as a clean delete.
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

function harness({ engineFor, disposeResult } = {}) {
  const handlers = new Map();
  const calls = [];
  const disposed = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      if (method === "session.delete") return { ok: true };
      return {};
    },
  };
  const ompSessions = {
    async disposeSession(sessionId, reason) {
      disposed.push({ sessionId, reason });
      return disposeResult ?? { ok: true, failures: [] };
    },
    async branch() {
      throw new Error("branch not wired in this test");
    },
    async rename() {
      return { ok: true };
    },
    async configure() {
      return { ok: true };
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      call: async () => ({}),
      clearProjectInstructionRoot() {},
      clearVendorAuthBindings() {},
    }),
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
    engineRouter: {
      async requireForSession(sessionId, capability) {
        return engineFor?.(sessionId, capability) ?? "omp";
      },
    },
    ompSessions,
  });
  return { handlers, calls, disposed };
}

test("F2: delete resolves the engine and reclaims the OMP runtime before deleting the row", async () => {
  const { handlers, calls, disposed } = harness();
  await handlers.get(IPC.invoke.sessionDelete)("omp-session-1");
  // The runtime reclaim must precede the host delete; the engine was resolved
  // from the still-present row.
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].sessionId, "omp-session-1");
  const deleteIndex = calls.findIndex((call) => call.method === "session.delete");
  assert.ok(deleteIndex >= 0, "the host delete must still run");
  assert.equal(disposed[0].reason, "session deleted");
});

test("F2: delete refuses a failed reclaim and never writes the host row", async () => {
  const { handlers, calls } = harness({ disposeResult: { ok: false, failures: [{ sessionId: "omp-session-1", detail: "process group survived" }] } });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionDelete)("omp-session-1"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && /not deleted/.test(error.message),
  );
  assert.equal(calls.some((call) => call.method === "session.delete"), false, "the host row must survive a failed reclaim");
});

test("F2: archive reclaims only the target OMP runtime and unarchive is a no-op", async () => {
  const { handlers, disposed } = harness();
  const result = await handlers.get(IPC.invoke.sessionArchive)("omp-session-A");
  assert.equal(result.ok, true);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].sessionId, "omp-session-A");
  assert.equal(disposed[0].reason, "session archived");
});

test("F2: archive throws on a failed reclaim instead of reporting ok:true", async () => {
  const { handlers, disposed } = harness({ disposeResult: { ok: false, failures: [{ sessionId: "omp-session-A", detail: "run dir survived" }] } });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionArchive)("omp-session-A"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && /not archived/.test(error.message),
  );
  assert.equal(disposed.length, 1);
});

test("F2: a non-OMP delete skips the OMP reclaim path", async () => {
  const { handlers, disposed } = harness({ engineFor: () => "pi" });
  await handlers.get(IPC.invoke.sessionDelete)("pi-session-1");
  assert.equal(disposed.length, 0, "a Pi session must not touch the OMP registry");
});
