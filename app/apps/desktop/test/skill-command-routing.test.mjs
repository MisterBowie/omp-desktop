import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createComposerCommandService } = await import("../electron/main/ipc/composer-ipc.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");

test("Skill namespace and OMP IPC resolve the durable project again at dispatch", async () => {
  const roots = []; const dispatched = []; const handlers = new Map();
  let enabled = true;
  let referenceAvailable = true;
  const service = createComposerCommandService({
    plugins: { listLoaded: () => [], getCommands: () => [], getSkills: () => enabled ? [{ id: "fixture/review", pluginId: "fixture", name: "Review" }] : [] },
    agentExtensions: { allCommands: () => [] },
    activeUserSkills: async (root) => { roots.push(root); return [{ id: "user/global", name: "Global" }]; },
    pluginActiveInProject: (_, root) => root === "/bound/project-a",
    loadComposerTemplatesCached: async () => [{ name: "skill:fixture/review" }],
  });
  const commands = await service.buildComposerCommands("/bound/project-a");
  assert.equal(commands.find((c) => c.name === "skill:fixture/review").kind, "skill");
  assert.equal(commands.find((c) => c.name === "skill:user/global").skillId, "user/global");
  assert.ok(commands.filter((c) => c.kind === "skill").every((c) => c.name.startsWith("skill:")));
  const host = { async call(method) {
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: "a", engine: "omp", projectPath: "/bound/project-a", mode: "agent" } };
    if (method === "session.getEngineRef") {
      if (!referenceAvailable) throw new Error("reference read unavailable");
      return {};
    }
    throw new Error(`Unexpected host call ${method}`);
  } };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host, getSidecar: () => null,
    getAgentHostBridge: () => null, logger: { app() {} }, activeTurns: new Map(),
    acquireSessionOperation: async () => () => {}, setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => "/visible/project-b", composerCommandService: service,
    engineRouter: createEngineRouter({ sessionEngine: async () => "omp", status: () => ({ engine: "omp", phase: "idle", runtimeVersion: "18.3.0", protocolVersion: 2, reason: null, capabilities: {} }) }),
    ompSessions: {
      prompt: async (input) => { dispatched.push(input); return { accepted: true, turnId: "t" }; },
      projectDirectory: () => "/bound/project-a",
      steer: async (sessionId, content, expectedTurnId) => { dispatched.push({ sessionId, content, expectedTurnId }); return { accepted: true, turnId: "t" }; },
    },
  });
  const prompt = handlers.get(IPC.invoke.agentPrompt);
  const steer = handlers.get(IPC.invoke.agentSteer);
  await prompt({ sessionId: "a", content: "/skill:fixture/review inspect changes" });
  await steer({ sessionId: "a", content: "/skill:fixture/review adjust", expectedTurnId: "t" });
  assert.ok(roots.every((root) => root === "/bound/project-a"));
  assert.match(dispatched[0].content, /Call the `Skill` tool with id "fixture\/review"/);
  assert.match(dispatched[1].content, /adjust/);
  enabled = false;
  await assert.rejects(prompt({ sessionId: "a", content: "/skill:fixture/review retry" }), (e) => e.errorCode === "INVALID_ARGUMENT");
  assert.equal(dispatched.length, 2, "a removed skill is refused before runtime admission");
  referenceAvailable = false;
  await assert.rejects(prompt({ sessionId: "a", content: "/skill:user/global continue" }), /reference read unavailable/);
  assert.equal(dispatched.length, 2, "a reference failure cannot silently start a fresh native conversation");
});
