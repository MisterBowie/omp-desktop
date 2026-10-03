import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import { pathToFileURL } from "node:url";
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
register(pathToFileURL(path.join(import.meta.dirname, "helpers", "ts-import-hooks.mjs")));
// Deferred on purpose: these .ts modules must be loaded *after* the import hook
// above is registered, which a static import would run before.
const shared = {
  ErrorCodes,
  ...sharedProtocol,
  ...(await import("../../../packages/shared/src/plan-goal-model-gate.ts")),
  ...(await import("../../../packages/shared/src/engine.ts")),
};
const { IPC } = sharedProtocol;
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");

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

function harness(hostRead, engineRouter, ompSessions = null) {
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
    ...(engineRouter ? { engineRouter } : {}),
    ...(ompSessions ? { ompSessions } : {}),
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

test("a Plan/Goal mode the engine does not declare is refused before any write", async () => {
  // A declaration table that omits both contract modes, driven through the real
  // router: this is the branch a future engine (or a reduced build) takes, and
  // hiding the composer chip must not be the only thing standing in the way.
  const closed = {
    ...(await import("../../../packages/shared/src/engine.ts")).PI_ENGINE_CAPABILITIES,
    plan: false,
    goal: false,
  };
  const router = createEngineRouter({
    status: (engine) => ({
      engine,
      phase: "idle",
      runtimeVersion: null,
      protocolVersion: null,
      reason: null,
      capabilities: closed,
    }),
    capabilities: () => closed,
    sessionEngine: async () => "pi",
  });

  // session.create: refused before the host ever sees the request.
  const created = harness(async () => ({}), router);
  for (const mode of ["plan", "goal"]) {
    await assert.rejects(
      () => created.handlers.get(IPC.invoke.sessionCreate)({ title: "New task", mode }),
      (error) =>
        error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && error.capability === mode,
    );
  }
  assert.deepEqual(created.calls, [], "a refused creation reached the host");

  // session.configure: the mode the write would leave behind is judged, and the
  // only host call is the read the merged pair needs.
  const configured = harness(
    async (method) =>
      method === "session.get"
        ? { session: { id: "s1", engine: "pi", mode: "agent", providerId: null } }
        : { session: { id: "s1", engine: "pi", mode: "plan", providerId: null } },
    router,
  );
  await assert.rejects(
    () => configured.handlers.get(IPC.invoke.sessionConfigure)("s1", { mode: "plan" }),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && error.capability === "plan",
  );
  assert.deepEqual(configured.calls.map((call) => call.method), ["session.get"]);

  // Positive control: the shipped declarations let both writes through.
  const open = createEngineRouter({
    status: (engine) => ({
      engine,
      phase: "idle",
      runtimeVersion: null,
      protocolVersion: null,
      reason: null,
      capabilities: shared.engineCapabilities(engine),
    }),
    sessionEngine: async () => "pi",
  });
  const allowed = harness(
    async (method) =>
      method === "session.get"
        ? { session: { id: "s2", engine: "pi", mode: "agent", providerId: null } }
        : { session: { id: "s2", engine: "pi", mode: "plan", providerId: null } },
    open,
  );
  const result = await allowed.handlers.get(IPC.invoke.sessionConfigure)("s2", { mode: "plan" });
  assert.equal(result.session.mode, "plan");
  assert.deepEqual(allowed.calls.map((call) => call.method), ["session.get", "session.configure"]);
});

/* ------------------------------------------------------------------------- */
/* OMP native history (M5/T20-R2)                                             */
/* ------------------------------------------------------------------------- */

const ompSessionRow = {
  id: "omp-session",
  title: "OMP session",
  engine: "omp",
  messageCount: 0,
  messages: [],
  projectPath: "/projects/omp",
  providerId: "provider-1",
  modelId: "model-1",
  thinkingLevel: "medium",
};

function ompHarness({ readHistory, engine = "omp" }) {
  const calls = [];
  const reads = [];
  const router = createEngineRouter({
    status: (id) => ({ engine: id, phase: "idle", runtimeVersion: null, protocolVersion: null, reason: null, capabilities: {} }),
    sessionEngine: async (sessionId) => {
      calls.push(sessionId);
      return engine;
    },
  });
  const built = harness(
    async (method, input) => {
      if (method === "session.get") return { session: { ...ompSessionRow } };
      if (method === "session.getEngineRef") {
        return {
          engineRef: {
            nativeSessionId: "native-1",
            nativeSessionPath: "/sessions/native-1.jsonl",
            adapterVersion: 1,
            runtimeVersion: "18.3.0",
          },
        };
      }
      throw new Error(`unexpected host call ${method}: ${JSON.stringify(input)}`);
    },
    router,
    {
      readHistory: async (input) => {
        reads.push(input);
        return readHistory(input);
      },
    },
  );
  return { ...built, reads, engineLookups: calls };
}

test("sessionGet merges the native transcript over the host row for an OMP session", async () => {
  const { handlers, reads, engineLookups } = ompHarness({
    readHistory: async () => ({
      messages: [
        { id: "omp:omp-session:entry:m1", role: "user", content: "hello", createdAt: "2026-01-01T00:00:00.000Z", status: "complete" },
        { id: "omp:omp-session:entry:m2", role: "assistant", content: "hi", createdAt: "2026-01-01T00:00:01.000Z", status: "complete" },
      ],
      messageCount: 2,
      messageStart: 0,
      messageEnd: 2,
      hasMoreBefore: false,
      hasMoreAfter: false,
      replacedLiveMessageIds: ["live-1"],
    }),
  });
  const result = await handlers.get(IPC.invoke.sessionGet)({
    id: "omp-session",
    messageLimit: 50,
    contentLimit: 4096,
  });

  assert.deepEqual(engineLookups, ["omp-session"]);
  // The transcript is the native projection; the host row still supplies every
  // metadata field (and its always-empty host messages are replaced).
  assert.deepEqual(result.session.messages.map((message) => message.id), [
    "omp:omp-session:entry:m1",
    "omp:omp-session:entry:m2",
  ]);
  assert.equal(result.session.messageCount, 2);
  assert.equal(result.session.messageStart, 0);
  assert.equal(result.session.hasMoreBefore, false);
  assert.deepEqual(result.session.replacedLiveMessageIds, ["live-1"]);
  assert.equal(result.session.title, "OMP session");
  assert.equal(result.session.projectPath, "/projects/omp");
  assert.equal(result.session.providerId, "provider-1");
  assert.equal(result.session.supportsVision, false, "enrichment still runs");

  // The native reference is read at the main/host boundary and handed to the
  // bridge; the caller's window travels through unchanged.
  assert.deepEqual(reads, [
    {
      sessionId: "omp-session",
      projectPath: "/projects/omp",
      providerId: "provider-1",
      modelId: "model-1",
      thinkingLevel: "medium",
      nativeSessionId: "native-1",
      nativeSessionPath: "/sessions/native-1.jsonl",
      adapterVersion: 1,
      runtimeVersion: "18.3.0",
      messageLimit: 50,
      contentLimit: 4096,
    },
  ]);
});

test("an OMP history read failure is reported instead of an empty transcript", async () => {
  const { handlers } = ompHarness({
    readHistory: async () => {
      throw Object.assign(new Error("the transcript could not be read"), { errorCode: "OMP_HISTORY_READ_FAILED" });
    },
  });
  await assert.rejects(
    () => handlers.get(IPC.invoke.sessionGet)({ id: "omp-session" }),
    (error) => error.errorCode === "OMP_HISTORY_READ_FAILED",
  );
});

test("a Pi session keeps the host transcript and never reads the native runtime", async () => {
  const { handlers, reads } = ompHarness({
    engine: "pi",
    readHistory: async () => {
      throw new Error("a Pi session must not read the OMP transcript");
    },
  });
  const result = await handlers.get(IPC.invoke.sessionGet)({ id: "omp-session" });
  assert.deepEqual(reads, []);
  assert.deepEqual(result.session.messages, []);
});

test("an unreadable engine record leaves the host transcript in place", async () => {
  const handlers = new Map();
  const router = createEngineRouter({
    status: (id) => ({ engine: id, phase: "idle", runtimeVersion: null, protocolVersion: null, reason: null, capabilities: {} }),
    sessionEngine: async () => {
      throw new Error("host unavailable");
    },
  });
  let reads = 0;
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method) => (method === "session.get" ? { session: { ...ompSessionRow } } : {}) }),
    getSidecar: () => ({ call: async () => ({}) }),
    engineRouter: router,
    ompSessions: {
      readHistory: async () => {
        reads += 1;
        throw new Error("must not be called");
      },
    },
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
  const result = await handlers.get(IPC.invoke.sessionGet)({ id: "omp-session" });
  assert.equal(reads, 0);
  assert.deepEqual(result.session.messages, []);
});

test("sessionOpen projects the native transcript the same way", async () => {
  const { handlers, reads } = ompHarness({
    readHistory: async () => ({
      messages: [{ id: "omp:omp-session:entry:m1", role: "user", content: "hello", createdAt: "2026-01-01T00:00:00.000Z", status: "complete" }],
      messageCount: 1,
      messageStart: 0,
      messageEnd: 1,
      hasMoreBefore: false,
      hasMoreAfter: false,
      replacedLiveMessageIds: [],
    }),
  });
  const result = await handlers.get(IPC.invoke.sessionOpen)("omp-session");
  assert.deepEqual(result.session.messages.map((message) => message.content), ["hello"]);
  assert.equal(reads[0].messageLimit, 1);
});
