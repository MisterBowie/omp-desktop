import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as protocol from "../../../packages/shared/src/protocol.ts";

/**
 * OMP inputs carry the user's attachments (R09): an image reaches the runtime
 * inline when the session's projected model takes image input, and every other
 * attachment becomes a file reference in the text, as on the Pi path.
 */
const { IPC } = protocol;
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");
const { preparePromptAttachments } = await import("../electron/main/prompt-attachments.ts");

const SESSION = "omp-attachments";
// A 1x1 PNG; the bytes only need to be stable for the digest.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-prompt-attachments-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const project = join(root, "project");
  const scratch = join(dataDir, "scratch", SESSION);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(project, { recursive: true });
  const image = join(scratch, "shot.png");
  writeFileSync(image, PNG);
  return { dataDir, project, image };
}

function harness({ dataDir, project, modelId }) {
  const handlers = new Map();
  const prompts = [];
  const steers = [];
  const host = {
    async call(method, params) {
      if (method === "settings.get") return {};
      if (method === "session.get") {
        return { session: { id: params.id, engine: "omp", mode: "agent", providerId: "fixture", modelId, projectPath: project } };
      }
      if (method === "session.getEngineRef") return { engineRef: null };
      if (method === "providers.get") {
        return {
          provider: {
            id: "fixture", apiStyle: "chat_completions", authKind: "none", baseUrl: "http://127.0.0.1:9",
            models: [{ id: "vision", supportsImages: true }, { id: "text", supportsImages: false }],
          },
        };
      }
      return {};
    },
  };
  const capabilities = { prompt: true, stop: true, steer: true, followUp: true, structuredQuestions: true, toolApproval: true, resume: true, branch: true, modelSwitch: true, subagentEvents: true, plan: true, goal: true };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    getAgentHostBridge: () => null,
    engineRouter: createEngineRouter({
      status: (engine) => ({ engine, phase: "idle", runtimeVersion: null, protocolVersion: null, reason: null, capabilities }),
      sessionEngine: async () => "omp",
    }),
    ompSessions: {
      prompt: async (input) => { prompts.push(input); return { accepted: true, turnId: "omp-turn:1", hostTurnId: null }; },
      steer: async (sessionId, content, expectedTurnId, userMessageId, requiresSkill, images) => {
        steers.push({ sessionId, content, expectedTurnId, images });
        return { accepted: true, turnId: expectedTurnId };
      },
      projectDirectory: () => project,
    },
    logger: { app() {} },
    vendorOAuth: {},
    agentExtensions: {},
    cancelSessionTools() {},
    persistenceOutbox: {},
    dataDir,
    activeTurns: new Map(),
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({ providerId: "fixture", modelId, sidecarParams: {} }),
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
  });
  return { handlers, prompts, steers };
}

const attachment = (path) => ({ path, name: "shot.png", kind: "image", mimeType: "image/png" });

test("an OMP prompt sends an image inline to a vision model", async (t) => {
  const { dataDir, project, image } = fixture(t);
  const h = harness({ dataDir, project, modelId: "vision" });
  await h.handlers.get(IPC.invoke.agentPrompt)({ sessionId: SESSION, content: "what is this?", attachments: [attachment(image)] });
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].content, "what is this?", "an inline image adds no file reference");
  assert.deepEqual(h.prompts[0].images, [{ data: PNG.toString("base64"), mimeType: "image/png" }]);
});

test("a text-only model receives the image as a file reference instead of inline data", async (t) => {
  const { dataDir, project, image } = fixture(t);
  const h = harness({ dataDir, project, modelId: "text" });
  await h.handlers.get(IPC.invoke.agentPrompt)({ sessionId: SESSION, content: "what is this?", attachments: [attachment(image)] });
  assert.equal(h.prompts[0].images, undefined);
  assert.ok(h.prompts[0].content.startsWith("what is this?\n"));
  assert.ok(h.prompts[0].content.includes(image), "the model can still read the image by path");
});

test("steering a running OMP turn carries the prepared image", async (t) => {
  const { dataDir, project, image } = fixture(t);
  const h = harness({ dataDir, project, modelId: "vision" });
  await h.handlers.get(IPC.invoke.agentSteer)({ sessionId: SESSION, content: "and this", expectedTurnId: "live", attachments: [attachment(image)] });
  assert.deepEqual(h.steers, [{
    sessionId: SESSION, content: "and this", expectedTurnId: "live",
    images: [{ data: PNG.toString("base64"), mimeType: "image/png" }],
  }]);
});

test("an attachment outside the session roots is refused before the runtime is reached", async (t) => {
  const { dataDir, project } = fixture(t);
  const outside = join(dirname(dataDir), "outside.png");
  writeFileSync(outside, PNG);
  const h = harness({ dataDir, project, modelId: "vision" });
  await assert.rejects(
    h.handlers.get(IPC.invoke.agentPrompt)({ sessionId: SESSION, content: "x", attachments: [attachment(outside)] }),
    /outside the session roots/,
  );
  assert.equal(h.prompts.length, 0);
});

test("the inline budget turns later images into file references", async (t) => {
  const { dataDir, project, image } = fixture(t);
  const second = join(dataDir, "scratch", SESSION, "second.png");
  writeFileSync(second, PNG);
  const prepared = await preparePromptAttachments(dataDir, SESSION, project, [attachment(image), attachment(second)], true, {
    inlineBudgetBytes: PNG.length,
  });
  assert.equal(typeof prepared[0].inlineData, "string", "the first image fits the budget");
  assert.equal(prepared[1].inlineData, undefined, "the second image exceeds what is left");
  assert.equal(prepared[1].fallbackPath, second);
});
