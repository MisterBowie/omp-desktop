import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as sharedProtocol from "../../../packages/shared/src/protocol.ts";

/**
 * The engine selection contract at the IPC boundary (M2/T10).
 *
 * The renderer chooses an engine by name; the desktop must hand that choice to
 * the host unchanged, must not invent one when the caller made none, and must
 * return the stored engine with every session so routing and the UI agree on
 * which engine owns it.
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

/** The real enrichment spreads the record and adds capability fields. */
const enrichSession = (session) => ({
  ...session,
  supportsReasoning: false,
  supportsVision: false,
  supportedThinkingLevels: ["off"],
});

function harness(hostRead) {
  const handlers = new Map();
  const calls = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return hostRead(method, input);
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      call: async () => ({ sessions: [{ id: "native-pi:1", source: "pi-native", engine: undefined }] }),
    }),
    dataDir: "/unused",
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: {},
    logger: { app() {} },
    plugins: { broadcastEvent() {} },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession,
    acquireSessionOperation: async () => () => {},
    stripWinLongPrefix: (value) => value,
  });
  return { handlers, calls };
}

test("an explicit engine choice reaches the host unchanged", async () => {
  const { handlers, calls } = harness(async (method) =>
    method === "session.create" ? { session: { id: "s1", title: "New task", engine: "omp" } } : {},
  );
  const created = await handlers.get(IPC.invoke.sessionCreate)({ title: "New task", engine: "omp" });
  assert.deepEqual(calls[0], { method: "session.create", input: { title: "New task", engine: "omp" } });
  // The stored engine survives enrichment: routing and the UI read it back.
  assert.equal(created.session.engine, "omp");
});

test("a caller that names no engine sends none, so the host default decides", async () => {
  const { handlers, calls } = harness(async () => ({ session: { id: "s2", title: "New task", engine: "pi" } }));
  const created = await handlers.get(IPC.invoke.sessionCreate)({ title: "New task" });
  assert.equal("engine" in calls[0].input, false);
  assert.equal(created.session.engine, "pi");
});

test("session.list keeps each session's engine, desktop and native alike", async () => {
  const { handlers } = harness(async (method) =>
    method === "session.list"
      ? {
          sessions: [
            { id: "desktop-1", title: "Pi session", engine: "pi" },
            { id: "desktop-2", title: "OMP session", engine: "omp" },
          ],
        }
      : {},
  );
  const list = await handlers.get(IPC.invoke.sessionList)();
  const byId = new Map(list.sessions.map((session) => [session.id, session]));
  assert.equal(byId.get("desktop-1").engine, "pi");
  assert.equal(byId.get("desktop-2").engine, "omp");
  assert.equal(byId.get("desktop-1").source, "desktop");
  // A native Pi record carries no engine from the host and must not gain one.
  assert.equal(byId.get("native-pi:1").engine, undefined);
});

test("an unknown engine is rejected by the host, not rewritten here", async () => {
  const { handlers, calls } = harness(async (method) => {
    if (method !== "session.create") return {};
    throw Object.assign(new Error("engine must be one of pi, omp, got claude"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionCreate)({ engine: "claude" }),
    /engine must be one of/,
  );
  assert.equal(calls[0].input.engine, "claude");
});
