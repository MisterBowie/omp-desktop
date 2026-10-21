import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } = await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { createOmpHostTurnLifecycle } = await import("../electron/main/runtime/omp-session-wiring.ts");
const { createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts");
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");
const { IPC } = await import("../../../packages/shared/src/protocol.ts");

function signal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("native OMP: steer, Todo history, namespaced Skill follow-up, compact, and cancel", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 120_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-controls-")));
  const provider = await FakeProvider.start();
  const stream = signal();
  const firstAssistant = signal();
  const queuedReply = signal();
  const compactStream = signal();
  const compactStarted = signal();
  let nativeRef;
  let turnSequence = 0;
  const active = new Set();
  const queueRows = new Map();
  const history = [];
  let terminalObserver;
  const host = { async call(method, params = {}) {
    if (method === "session.get") return { session: { id: "controls", engine: "omp", projectPath: root,
      providerId: "m1fake", modelId: "local-model", mode: "agent", permissionMode: "ask" } };
    if (method === "session.getEngineRef") return { engineRef: nativeRef };
    if (method === "session.beginTurn") { assert.equal(active.size, 0, "no overlap between durable native turns"); const id = `host-${++turnSequence}`; active.add(id); return { turnId: id }; }
    if (method === "session.endTurn") { active.delete(params.turnId); return { ok: true }; }
    if (method === "session.queuePush") { queueRows.set(params.id, { ...params, position: queueRows.size, createdAt: new Date().toISOString() }); return {}; }
    if (method === "session.queueRemove") return { removed: queueRows.delete(params.id) };
    if (method === "session.queueList") return { entries: [...queueRows.values()] };
    if (method === "permissions.pending") return { requests: [] };
    if (method === "plans.pending") return { plans: [] };
    if (method === "settings.get") return {};
    throw new Error(`Unexpected host RPC: ${method}`);
  } };
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, launcherPath: resources.path, expectedRuntimeVersion: "18.3.0", sessionDir: ensureSessionStateDir(root),
    args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(here)],
    prepareRun: (paths) => {
      writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl });
      writeFileSync(join(paths.agentDir, "config.yml"), "compaction:\n  keepRecentTokens: 1\n");
    },
  });
  let hostBridge;
  const skill = { id: "fixture/review", name: "Review", description: "Fixture review instructions" };
  const phases = [{ name: "Review", tasks: [{ content: "Inspect changes", status: "completed" }] }];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor, launcher: resources.path, isPackaged: false, appPath: here,
    sessionDir: ensureSessionStateDir(root), gateResolver: () => findGateExtension(here),
    persistNativeSession: (value) => { nativeRef = value; },
    hostTurns: createOmpHostTurnLifecycle(() => host),
    onIdle: (sessionId) => hostBridge?.agentHost.kick(sessionId),
    onTurnEnd: (info) => hostBridge?.endTurn(info.sessionId, info.turnId,
      info.reason === "completed" ? "completed" : info.reason === "aborted" ? "interrupted" : "failed"),
    sessionPolicy: { policy: async () => ({ mode: "agent", permissionMode: "ask" }) },
    capabilities: { snapshot: async () => ({ skills: [skill] }) },
    hostTools: createOmpHostToolAdapter({
      plugins: { getTools: () => [], getSkills: () => [], loadSkillBody: () => { throw new Error("not found"); } },
      userMcp: { toolsForProject: async () => [], callTool: async () => { throw new Error("unused"); } },
      pluginActiveInProject: () => false,
      loadBuiltinSkillBody: (id) => id === skill.id ? { ...skill, body: "Fixture review body loaded on demand." } : null,
    }),
    emitAgentEvent: (event) => {
      history.push(event);
      hostBridge?.ingest(event);
      if (event.event.type === "agent_end") terminalObserver?.();
      if (event.event.type === "message_update") firstAssistant.resolve();
      if (event.event.type === "message_end" && event.event.message.content.includes("queued reply")) queuedReply.resolve();
    },
  });
  t.after(async () => {
    stream.resolve(); compactStream.resolve();
    await bridge.dispose();
    const stopped = await supervisor.stop();
    await provider.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(stopped.reaped, true);
    assert.equal(stopped.cleaned, true);
  });
  const handlers = new Map();
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => null, getAgentHostBridge: () => hostBridge,
    engineRouter: createEngineRouter({ status: () => supervisor.status(), sessionEngine: async () => "omp" }),
    ompSessions: bridge, logger: { app() {} }, activeTurns: new Map(),
    composerCommandService: { buildComposerCommands: async (project) => {
      assert.equal(project, root, "Skill expansion uses the session's bound project");
      return [{ name: `skill:${skill.id}`, kind: "skill", title: skill.name, skillId: skill.id }];
    } },
    acquireSessionOperation: async () => () => {}, setNotificationViewingSessionId() {},
  });
  hostBridge = createAgentHostBridge({
    invoke: (channel, args) => handlers.get(channel)(...args), channels: IPC.invoke,
    getHost: () => host, isSessionBusy: (id) => bridge.isBusy(id), log() {},
  });
  await hostBridge.agentHost.start();
  provider.script([
    { text: "first partial", finish: "stop", waitFor: stream.promise },
    { toolCalls: [
      { id: "call_todo", name: "todo", args: { op: "init", list: [{ phase: "Review", items: ["Inspect changes"] }] } },
      { id: "call_done", name: "todo", args: { op: "done", task: "Inspect changes" } },
    ], finish: "tool_calls" },
    { text: "steered reply", finish: "stop" },
    { toolCalls: [{ id: "call_skill", name: "Skill", args: { id: skill.id } }], finish: "tool_calls" },
    { text: "queued reply", finish: "stop" },
  ]);
  const firstRow = "00000000-0000-4000-8000-000000000001";
  const steeringRow = "00000000-0000-4000-8000-000000000002";
  const first = await handlers.get(IPC.invoke.agentPrompt)({ sessionId: "controls", content: "first", messageId: firstRow });
  await firstAssistant.promise;
  assert.ok(history.some(({ event }) => event.type === "status" && event.status.currentTurnId === first.turnId), "Composer receives the active steering identity");
  await handlers.get(IPC.invoke.agentSteer)({ sessionId: "controls", expectedTurnId: first.turnId, content: "operator correction", messageId: steeringRow });
  await handlers.get(IPC.invoke.agentQueuePush)({ sessionId: "controls", content: `/skill:${skill.id} queued follow-up` });
  assert.equal(queueRows.size, 1, "follow-up is durable while the stream is held");
  stream.resolve();
  await queuedReply.promise;
  // Read-only native history waits for the writer's final turn settlement.
  await new Promise((resolve) => {
    if (!bridge.isBusy("controls")) return resolve();
    const detach = supervisor.currentRuntime().onFrame((frame) => { if (frame.type === "agent_end" && frame.isTerminal !== false) { detach(); resolve(); } });
  });
  const calls = provider.requests.filter((request) => request.url.endsWith("/chat/completions"));
  assert.equal(calls.length, 5);
  assert.match(JSON.stringify(calls[1].body.messages), /operator correction/);
  assert.match(JSON.stringify(calls[3].body.messages), /queued follow-up/);
  assert.match(JSON.stringify(calls[3].body.messages), /Call the `Skill` tool/);
  assert.match(JSON.stringify(calls[4].body.messages), /Fixture review body loaded on demand/);
  assert.equal(queueRows.size, 0);
  assert.equal(turnSequence, 2, "steering does not create another durable turn");
  const echoes = history.filter(({ event }) => event.type === "user_message_persisted").map(({ event }) => event.optimisticMessageId);
  assert.deepEqual(echoes, [firstRow, steeringRow]);
  const restored = await bridge.readHistory({ sessionId: "controls", projectPath: root, ...nativeRef, messageLimit: 1 });
  assert.deepEqual(restored.todoPhases, phases, "Todo survives a paged history read without another writer");
  const staleAbort = await handlers.get(IPC.invoke.agentAbort)({ sessionId: "controls", turnId: first.turnId });
  assert.equal(staleAbort.aborted, false, "a stale turn cannot stop another operation");
  provider.script([{ text: "A saved compact summary of the work.", finish: "stop" }]);
  await handlers.get(IPC.invoke.agentCompact)({ sessionId: "controls" });
  const entries = await supervisor.currentRuntime().request({ type: "get_entries" });
  assert.ok(entries.data.entries.some((entry) => entry.type === "compaction"));
  assert.equal(history.at(-1).event.type, "compaction_end");
  assert.equal(history.at(-1).event.ok, true);
  const checkpointReply = signal();
  terminalObserver = checkpointReply.resolve;
  provider.script([{ text: "New reply after checkpoint", finish: "stop" }]);
  await handlers.get(IPC.invoke.agentPrompt)({ sessionId: "controls", content: "continue after checkpoint" });
  await checkpointReply.promise;
  terminalObserver = undefined;
  assert.match(JSON.stringify(provider.requests.at(-1).body.messages), /saved compact summary/);
  provider.script([{ text: "cancelled summary", finish: "stop", waitFor: compactStream.promise }]);
  provider.server.on("request", (request) => { if (request.url.endsWith("/chat/completions")) compactStarted.resolve(); });
  const compacting = handlers.get(IPC.invoke.agentCompact)({ sessionId: "controls" });
  const cancelled = assert.rejects(compacting, (error) => error.errorCode === "CONTEXT_COMPACTION_FAILED");
  await compactStarted.promise;
  const stop = await handlers.get(IPC.invoke.agentAbort)({ sessionId: "controls" });
  await cancelled;
  compactStream.resolve();
  assert.equal(stop.aborted, true);
  assert.equal(history.at(-1).event.ok, false);
});
