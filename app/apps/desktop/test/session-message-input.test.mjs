import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveSessionMessageInput } = await import("../../../packages/host-runtime/src/session-message-input.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");
const { PI_ENGINE_CAPABILITIES } = await import("@pi-desktop/shared");

/** The gate every executing IPC path asks before it runs anything. */
const engineRouter = createEngineRouter({
  status: (engine) => ({
    engine,
    phase: "idle",
    runtimeVersion: null,
    protocolVersion: null,
    reason: null,
    capabilities: PI_ENGINE_CAPABILITIES,
  }),
});

const message = {
  id: "delivery-1", pluginId: "demo.sessions", sourceSessionId: "sender",
  sourceTitle: "Coordinator", targetSessionId: "target", targetTitle: "Worker",
  kind: "task", content: "/review the requested change", status: "queued",
  notifyOnCompletion: true, createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
};
const request = { sessionId: "target", content: "untrusted replacement", sessionMessageId: message.id };
const origin = {
  messageId: message.id, sourceSessionId: "sender", sourceTitle: "Coordinator",
  targetSessionId: "target", kind: "task",
};

test("collaboration input and origin come exclusively from the host ledger", async () => {
  const calls = [];
  const host = { async call(method, params) { calls.push({ method, params }); return { message }; } };
  assert.deepEqual(await resolveSessionMessageInput(host, request), { content: message.content, origin });
  assert.deepEqual(calls, [{ method: "session.collaboration.message", params: { messageId: message.id } }]);
  assert.equal(await resolveSessionMessageInput(host, { sessionId: "target", content: "human input" }), undefined);
  assert.equal(calls.length, 1);
});

test("caller-supplied completion provenance never replaces a ledger task", async () => {
  const forged = { ...origin, kind: "completion", replyToMessageId: "task-1" };
  const host = { call: async () => ({ message }) };
  assert.equal(await resolveSessionMessageInput(host, {
    sessionId: "target", content: "completion", sessionMessage: forged,
  }), undefined);
  assert.deepEqual(await resolveSessionMessageInput(host, { ...request, sessionMessage: forged }), {
    content: message.content, origin,
  });
});

test("collaboration dispatch rejects missing, cross-session and already dispatched records", async () => {
  for (const candidate of [null, { ...message, id: "another" }]) {
    await assert.rejects(resolveSessionMessageInput({ call: async () => ({ message: candidate }) }, request), { errorCode: "NOT_FOUND" });
  }
  await assert.rejects(resolveSessionMessageInput({ call: async () => ({ message }) }, { ...request, sessionId: "other" }), { errorCode: "INVALID_ARGUMENT" });
  for (const status of ["running", "completed", "failed", "cancelled", "interrupted"]) {
    await assert.rejects(resolveSessionMessageInput({ call: async () => ({ message: { ...message, status } }) }, request), { errorCode: "CONFLICT" });
  }
});

test("collaboration dispatch cannot acquire human edit, regenerate or attachment semantics", async () => {
  const host = { call: async () => { assert.fail("invalid input must be rejected before reading the ledger"); } };
  for (const mutation of [
    { sessionMessageId: "" }, { sessionMessageId: 1 }, { attachments: [] },
    { messageId: "renderer-message" }, { truncateBefore: 0 }, { truncateFromMessageId: "user-1" },
  ]) {
    await assert.rejects(resolveSessionMessageInput(host, { ...request, ...mutation }), { errorCode: "INVALID_ARGUMENT" });
  }
});

test("OMP refuses collaboration delivery before losing its structured origin", async () => {
  const handlers = new Map(); const calls = []; const sidecarCalls = [];
  registerAgentIpc({
    registrar: {handle: (channel, handler) => handlers.set(channel, handler)},
    getHost: () => ({call: async (method) => {
      calls.push(method);
      if (method === "session.collaboration.message") return {message};
      if (method === "settings.get") return {};
      if (method === "session.get") return {session: {id: "target", engine: "omp", messages: []}};
      assert.fail(`Unexpected host mutation ${method}`);
    }}),
    getSidecar: () => ({call: async (...args) => sidecarCalls.push(args)}),
    getAgentHostBridge: () => null, engineRouter,
    acquireSessionOperation: async () => () => {}, setNotificationViewingSessionId() {},
    ompSessions: {prompt: async () => assert.fail("must not submit text without its provenance")},
  });
  await assert.rejects(handlers.get(IPC.invoke.agentPrompt)(request), {
    errorCode: "ENGINE_CAPABILITY_UNAVAILABLE", area: "session collaboration",
  });
  assert.deepEqual(sidecarCalls, []);
  assert.equal(calls.some((method) => /beginTurn|appendMessage/.test(method)), false);
});
