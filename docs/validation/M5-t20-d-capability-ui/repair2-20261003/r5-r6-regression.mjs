/**
 * R5/R6 executable regression probe (M5/T20-D repair 2).
 *
 * Runs the *same* checks against two source trees given on the command line
 * (`--tree <app dir>`), so the defect is reproduced at the exact boundaries the
 * acceptance names — the shared event vocabulary + the renderer's transcript
 * reducer for R5, and the real `sessionGet` IPC handler for R6 — and the fix is
 * proven by the same script on the fixed tree:
 *
 *   baseline (2093f271): R5 = two rendered user rows for one submission;
 *                        R6 = an OMP session's `sessionGet` returns no messages.
 *   fixed:               R5 = one row; R6 = the native rows are returned.
 *
 * Nothing here is a UI run; it is the smallest executable form of both defects
 * (the real Electron UI evidence lives in the harness run next to this probe).
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const treeFlag = args.indexOf("--tree");
if (treeFlag < 0 || !args[treeFlag + 1]) {
  console.error("usage: node r5-r6-regression.mjs --tree <app directory> [--expect red|green]");
  process.exit(2);
}
const APP = resolve(args[treeFlag + 1]);
const expectFlag = args.indexOf("--expect");
const expected = expectFlag >= 0 ? args[expectFlag + 1] : null;
const report = { tree: APP, checks: [] };

register(pathToFileURL(join(APP, "apps/desktop/test/helpers/ts-import-hooks.mjs")).href);

/* ------------------------------------------------------------------ R5 --- */

const { OmpEventConverter } = await import(pathToFileURL(join(APP, "packages/omp-runtime/src/session/events.ts")).href);
const { optimisticUserMessage, upsertLiveSessionMessage, projectMessageEnd, reconcilePersistedUserMessage } = await import(
  pathToFileURL(join(APP, "apps/desktop/src/lib/session-transcript.ts")).href
);

/** The exact window the desktop paints for an admitted prompt. */
function renderedUserRows({ adopt }) {
  const RENDERER_ID = "11111111-2222-4333-8444-555555555555";
  const content = "E2E-SAME-TEXT: one submission, one bubble.";
  const converter = new OmpEventConverter({ sessionId: "session-omp", now: () => 1_000 });
  // The renderer paints the optimistic row before the prompt leaves.
  let messages = [optimisticUserMessage(RENDERER_ID, content, [], "2026-01-01T00:00:00.000Z")];
  // Main's own echo of the admitted prompt (the pre-repair behavior): the same
  // row under the renderer's id, produced by the desktop, not the runtime.
  const echo = { id: RENDERER_ID, role: "user", content, createdAt: "2026-01-01T00:00:00.000Z", status: "complete" };
  messages = upsertLiveSessionMessage(messages, echo);
  // The runtime's own user frame (the durable echo) from the converter.
  const frame = { type: "message_start", message: { role: "user", content: [{ type: "text", text: content }], timestamp: 1_000 } };
  if (adopt && typeof converter.adoptUserMessageId === "function") {
    converter.adoptUserMessageId(RENDERER_ID);
  }
  for (const event of converter.convert(frame)) {
    if (event.type === "message_start") messages = upsertLiveSessionMessage(messages, event.message);
    else if (event.type === "message_end") messages = projectMessageEnd(messages, event);
    else if (event.type === "user_message_persisted") {
      // The renderer's `user_message_persisted` handler: re-key the optimistic
      // row to the durable one, never matching by text.
      messages = reconcilePersistedUserMessage(messages, event.optimisticMessageId, event.message);
    }
  }
  const end = converter.convert({ type: "message_end", message: { role: "user", content: [{ type: "text", text: content }], timestamp: 1_000 } });
  for (const event of end) {
    if (event.type === "message_end") messages = projectMessageEnd(messages, event);
  }
  return {
    rows: messages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
    sameTextRows: messages.filter((message) => message.role === "user" && message.content === content).length,
  };
}

const preRepair = renderedUserRows({ adopt: false });
const withIdentity = renderedUserRows({ adopt: true });
report.checks.push({
  id: "R5-user-row-identity",
  rendererIdEcho: preRepair.rows.length,
  preRepairUserRows: preRepair.sameTextRows,
  withAdoptedIdentityRows: withIdentity.sameTextRows,
  withAdoptedIdentityIds: withIdentity.rows.filter((row) => row.role === "user").map((row) => row.id),
});

/* ------------------------------------------------------------------ R6 --- */

// Loaded by absolute path: this probe lives outside the repository, so the
// tree under test supplies its own compiler (and its own transpile behavior).
const tsModule = await import(pathToFileURL(join(APP, "node_modules/typescript/lib/typescript.js")).href);
const ts = tsModule.default;
const sharedProtocol = await import(pathToFileURL(join(APP, "packages/shared/src/protocol.ts")).href);
const { ErrorCodes } = await import(pathToFileURL(join(APP, "packages/shared/src/errors.ts")).href);
const { IPC } = sharedProtocol;
const sharedSurface = {
  ...sharedProtocol,
  ErrorCodes,
  ...(await import(pathToFileURL(join(APP, "packages/shared/src/plan-goal-model-gate.ts")).href)),
  ...(await import(pathToFileURL(join(APP, "packages/shared/src/engine.ts")).href)),
};

/** Load the real session IPC module with injected main-process dependencies. */
function loadSessionIpc(imports) {
  const file = join(APP, "apps/desktop/electron/main/ipc/session-ipc.ts");
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (!Object.hasOwn(imports, id)) throw new Error(`unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const nativeRows = [
  { id: "omp:session-omp:entry:m1", role: "user", content: "hello from before the restart", createdAt: "2026-01-01T00:00:00.000Z", status: "complete" },
  { id: "omp:session-omp:entry:m2", role: "assistant", content: "hi", createdAt: "2026-01-01T00:00:01.000Z", status: "complete" },
];

const { registerSessionIpc } = loadSessionIpc({
  electron: { shell: {} },
  "node:path": await import("node:path"),
  "node:fs": await import("node:fs"),
  "@pi-desktop/shared": sharedSurface,
  "../importers": {},
  "../services/session-collaboration": { readSessionCollaboration: async () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
});

const handlers = new Map();
registerSessionIpc({
  registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
  getHost: () => ({
    call: async (method) => {
      if (method === "session.get") {
        return { session: { id: "session-omp", title: "OMP session", engine: "omp", messages: [], messageCount: 0 } };
      }
      if (method === "session.getEngineRef") {
        return { engineRef: { nativeSessionId: "native-1", nativeSessionPath: "/sessions/native-1.jsonl", adapterVersion: 1, runtimeVersion: "18.3.0" } };
      }
      return {};
    },
  }),
  getSidecar: () => ({ call: async () => ({}) }),
  engineRouter: {
    engineForSession: async () => "omp",
    requireForSession: async () => "omp",
    requireContractMode: () => undefined,
  },
  ompSessions: {
    readHistory: async () => ({
      messages: nativeRows,
      messageCount: nativeRows.length,
      messageStart: 0,
      messageEnd: nativeRows.length,
      hasMoreBefore: false,
      hasMoreAfter: false,
      replacedLiveMessageIds: [],
    }),
  },
  dataDir: "/unused",
  activeTurns: new Map(),
  sessionProjects: new Map(),
  persistenceOutbox: {},
  logger: { app: () => undefined },
  plugins: { broadcastEvent: () => undefined },
  sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
  enrichSession: (session) => session,
  acquireSessionOperation: async () => () => undefined,
  stripWinLongPrefix: (value) => value,
});

const sessionGet = handlers.get(IPC.invoke.sessionGet);
const detail = await sessionGet({ id: "session-omp" });
report.checks.push({
  id: "R6-omp-sessionGet-messages",
  messageCount: (detail?.session?.messages ?? []).length,
  ids: (detail?.session?.messages ?? []).map((message) => message.id),
  hostRowMetadataKept: detail?.session?.title === "OMP session",
});

/* --------------------------------------------------------------- verdict -- */

const r5Pass = withIdentity.sameTextRows === 1;
const r6Pass = (detail?.session?.messages ?? []).length === nativeRows.length;
report.verdict = { r5Pass, r6Pass };
if (expected === "red") {
  report.expectationMet = !r5Pass || !r6Pass;
} else if (expected === "green") {
  report.expectationMet = r5Pass && r6Pass;
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.expectationMet === false ? 1 : 0);
