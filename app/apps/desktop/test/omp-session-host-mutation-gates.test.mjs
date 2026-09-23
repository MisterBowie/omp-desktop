import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as sharedProtocol from "../../../packages/shared/src/protocol.ts";

/**
 * J4: host-only mutations inside the M4 persistence boundary must refuse an
 * OMP session before any host mutation, while leaving the Pi path unchanged.
 *
 * moveProject, replaceMessages, saveRevision, listRevisions and
 * activateRevision all rewrite (or read) the host transcript/project binding
 * that OMP's native transcript owns. This test drives the real
 * `registerSessionIpc` handler and proves (a) an OMP session is refused with a
 * typed capability error and the host mutation is never issued, and (b) a Pi
 * session still reaches the host call.
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

function harness({ engineForSession = "pi" } = {}) {
  const handlers = new Map();
  const calls = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      if (method === "session.moveProject") return { session: { id: input.sessionId, projectPath: input.projectPath } };
      if (method === "session.replaceMessages") return { ok: true };
      if (method === "session.saveRevision") return { ok: true };
      if (method === "session.listRevisions") return { revisions: [] };
      if (method === "session.activateRevision") return { ok: true };
      return {};
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({ call: async () => ({}), clearProjectInstructionRoot() {}, clearVendorAuthBindings() {}, setProjectInstructionRoot() {} }),
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
      async engineForSession(sessionId) {
        return typeof engineForSession === "function" ? engineForSession(sessionId) : engineForSession;
      },
      async requireForSession(sessionId, capability) {
        return typeof engineForSession === "function" ? engineForSession(sessionId) : engineForSession;
      },
    },
    ompSessions: null,
  });
  return { handlers, calls };
}

test("J4: moveProject refuses an OMP session and never mutates the host", async () => {
  const { handlers, calls } = harness({ engineForSession: "omp" });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionMoveProject)({ sessionId: "omp-session-1", projectPath: "/elsewhere" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && /moving a session between projects/.test(error.message),
  );
  assert.equal(calls.some((call) => call.method === "session.moveProject"), false, "the host project row must not be moved");
});

test("J4: moveProject keeps the Pi path unchanged", async () => {
  const { handlers, calls } = harness({ engineForSession: "pi" });
  const result = await handlers.get(IPC.invoke.sessionMoveProject)({ sessionId: "pi-session-1", projectPath: "/elsewhere" });
  assert.equal(calls.some((call) => call.method === "session.moveProject"), true, "the Pi path must reach the host");
  assert.equal(result.session.projectPath, "/elsewhere");
});

test("J4: replaceMessages refuses an OMP session and never mutates the host", async () => {
  const { handlers, calls } = harness({ engineForSession: "omp" });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionReplaceMessages)({ sessionId: "omp-session-1", messages: [] }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && /transcript replacement/.test(error.message),
  );
  assert.equal(calls.some((call) => call.method === "session.replaceMessages"), false);
});

test("J4: replaceMessages keeps the Pi path unchanged", async () => {
  const { handlers, calls } = harness({ engineForSession: "pi" });
  await handlers.get(IPC.invoke.sessionReplaceMessages)({ sessionId: "pi-session-1", messages: [] });
  assert.equal(calls.some((call) => call.method === "session.replaceMessages"), true);
});

test("J4: saveRevision refuses an OMP session and never mutates the host", async () => {
  const { handlers, calls } = harness({ engineForSession: "omp" });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionSaveRevision)({ sessionId: "omp-session-1", rootUserId: "r", messages: [] }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.equal(calls.some((call) => call.method === "session.saveRevision"), false);
});

test("J4: listRevisions refuses an OMP session and never reads the host", async () => {
  const { handlers, calls } = harness({ engineForSession: "omp" });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionListRevisions)({ sessionId: "omp-session-1", rootUserId: "r" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.equal(calls.some((call) => call.method === "session.listRevisions"), false);
});

test("J4: activateRevision refuses an OMP session and never mutates the host", async () => {
  const { handlers, calls } = harness({ engineForSession: "omp" });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionActivateRevision)({ sessionId: "omp-session-1", rootUserId: "r", revisionIndex: 0 }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
  );
  assert.equal(calls.some((call) => call.method === "session.activateRevision"), false);
});

test("J4: Pi revision reads and activations are unchanged", async () => {
  const { handlers, calls } = harness({ engineForSession: "pi" });
  await handlers.get(IPC.invoke.sessionSaveRevision)({ sessionId: "pi-session-1", rootUserId: "r", messages: [] });
  await handlers.get(IPC.invoke.sessionListRevisions)({ sessionId: "pi-session-1", rootUserId: "r" });
  await handlers.get(IPC.invoke.sessionActivateRevision)({ sessionId: "pi-session-1", rootUserId: "r", revisionIndex: 0 });
  assert.equal(calls.filter((call) => call.method === "session.saveRevision").length, 1);
  assert.equal(calls.filter((call) => call.method === "session.listRevisions").length, 1);
  assert.equal(calls.filter((call) => call.method === "session.activateRevision").length, 1);
});
