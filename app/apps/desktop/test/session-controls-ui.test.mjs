import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs as translations } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const allNodes = (node) => [node, ...(node.childNodes ?? []).flatMap(allNodes)];
const text = (node) => `${node._text ?? ""}${(node.childNodes ?? []).map(text).join("")}`;

test("mounted session controls: native Todos, scope isolation, steer, follow-up and draft ownership", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] } });
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const { ComposerStatus } = await server.ssrLoadModule("/src/features/chat/composer/ComposerStatus.tsx");
  const { SessionCopyActions } = await server.ssrLoadModule("/src/features/sessions/SidebarSessionMetadata.tsx");
  const { useComposerSubmit } = await server.ssrLoadModule("/src/features/chat/composer/hooks/useComposerSubmit.ts");
  const { createSessionRuntime } = await server.ssrLoadModule("/src/stores/runtime/session-runtime.ts");
  const i18n = createInstance(); await i18n.init({ lng: "en", resources: { en: { translation: translations.en } } });
  const previous = installMinimalDom();
  const createNode = document.createElement.bind(document);
  document.createElement = (tag) => { const node = createNode(tag); node.namespaceURI = "http://www.w3.org/1999/xhtml"; return node; };
  document.createElementNS = (namespace, tag) => { const node = document.createElement(tag); node.namespaceURI = namespace; return node; };
  const requests = []; const queue = []; const cleared = []; const restored = [];
  let commandsRead = null; let detailRead = null;
  window.piDesktop = { platform: "darwin", on: () => () => {}, invoke: async (channel, req) => {
    requests.push({ channel, req });
    let data;
    if (channel === IPC.invoke.agentSteer) data = { accepted: true, turnId: req.expectedTurnId };
    else if (channel === IPC.invoke.agentQueuePush) { data = { ...req, id: "q1", createdAt: new Date().toISOString() }; queue.push(data); }
    else if (channel === IPC.invoke.agentQueueList) data = { entries: queue };
    else if (channel === IPC.invoke.composerCommands) data = await commandsRead.promise;
    else if (channel === IPC.invoke.sessionGet) data = await detailRead.promise;
    else throw new Error(`Unexpected IPC ${channel}`);
    return { ok: true, data };
  } };
  useAppStore.setState({ activeSessionId: "a", messages: [], sessions: [{ id: "a", engine: "omp" }, { id: "b", engine: "omp" }],
    sessionTodos: {}, retainedTranscripts: {}, transcriptViews: {}, runningSessions: { a: true, b: true },
    pendingPlans: {}, queuedPrompts: {}, agentStatuses: { a: { currentTurnId: "turn-a" }, b: { currentTurnId: "turn-b" } } });
  const container = document.createElement("div"); const root = createRoot(container);
  async function click(node) {
    assert.ok(node, "click target exists");
    await act(async () => {
      const event = { type: "click", target: node, bubbles: true, button: 0, defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
      for (const listener of container._listeners.click ?? []) listener(event);
    });
  }
  function Status() {
    const state = useAppStore();
    return createElement(ComposerStatus, { t: i18n.t.bind(i18n), queuedPrompts: state.queuedPrompts[state.activeSessionId] ?? [],
      removeQueuedPrompt: state.removeQueuedPrompt, moveQueuedPrompt: state.moveQueuedPrompt, editQueuedPrompt: state.editQueuedPrompt,
      sendQueuedNow: state.sendQueuedNow, approvalPending: false, enhancementError: null, clearEnhancementError() {}, droppedDirectories: [] });
  }
  let value = "operator correction";
  function Submit() {
    const state = useAppStore();
    const controller = useComposerSubmit({ value, activeSessionId: state.activeSessionId, draftKey: state.activeSessionId,
      modelReady: true, sendBlocked: false, pasting: false, activeFileReferences: [], t: i18n.t.bind(i18n),
      sendPrompt: state.sendPrompt, steerPrompt: state.steerPrompt, showToast: state.showToast,
      draft: { ref: { current: null }, draftSnapshot: (content) => ({ text: content, fileReferences: [] }),
        clearDraftForKey: (key) => cleared.push(key), restoreDraftForKey: (...args) => restored.push(args), setValue() {}, setCursor() {} } });
    return createElement("div", null,
      createElement("button", { "data-submit": "steer", onClick: () => controller.submit(true) }, "Steer"),
      createElement("button", { "data-submit": "follow", onClick: () => controller.submit() }, "Follow up"));
  }
  const render = async () => act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement("div", null, createElement(Status), createElement(Submit)))));
  const tool = (sessionId, id, phases, extra = {}) => {
    const state = useAppStore.getState();
    state.handleAgentEvent({ sessionId, ts: 1, ...extra, event: { type: "tool_start", toolCallId: id, toolName: "todo", args: {} } });
    state.handleAgentEvent({ sessionId, ts: 2, ...extra, event: { type: "tool_end", toolCallId: id, result: { details: { op: "init", phases } } } });
  };
  try {
    const phases = [{ name: "Build", tasks: [
      { content: "Write code", status: "in_progress" }, { content: "Run checks", status: "blocked", blocker: "Waiting for build" },
      ...Array.from({ length: 12 }, (_, i) => ({ content: `Task ${i}`, status: "pending" })), { content: "Old task", status: "abandoned" },
    ] }];
    await act(async () => tool("a", "ta", phases)); await render();
    assert.match(text(container), /Tasks 0\/14/);
    await click(allNodes(container).find((n) => n.attributes?.["aria-expanded"] === "false"));
    assert.match(text(container), /Waiting for build/); assert.match(text(container), /Task 11/);
    await act(async () => tool("a", "child", [{ name: "Child", tasks: [{ content: "child only", status: "pending" }] }], { parentToolCallId: "parent" }));
    assert.doesNotMatch(text(container), /child only/);
    await act(async () => tool("b", "tb", [{ name: "Other", tasks: [{ content: "Other session", status: "in_progress" }] }]));
    assert.doesNotMatch(text(container), /Other session/);
    await click(allNodes(container).find((n) => n.attributes?.["data-submit"] === "steer"));
    assert.equal(requests.find((r) => r.channel === IPC.invoke.agentSteer).req.expectedTurnId, "turn-a");
    assert.equal(useAppStore.getState().messages.filter((m) => m.steering).length, 1);
    value = "follow-up text"; await render();
    await click(allNodes(container).find((n) => n.attributes?.["data-submit"] === "follow"));
    assert.equal(queue[0].sessionId, "a"); assert.match(text(container), /follow-up text/);
    assert.deepEqual(cleared, ["a", "a"]); assert.deepEqual(restored, []);
    await act(async () => useAppStore.setState({ activeSessionId: "b", messages: [] }));
    assert.match(text(container), /Other session/); assert.doesNotMatch(text(container), /Waiting for build/);
    assert.ok(allNodes(container).some((n) => n.attributes?.["aria-expanded"] === "false"));
    // Read owned native state, then deliver a newer live result before it answers.
    detailRead = deferred(); const runtime = createSessionRuntime({ get: useAppStore.getState, set: useAppStore.setState });
    const pending = runtime.loadSessionDetail("b");
    const fresh = [{ name: "Fresh", tasks: [{ content: "Latest", status: "completed" }] }];
    await act(async () => tool("b", "new", fresh));
    await act(async () => { detailRead.resolve({ session: { messages: [], todoPhases: [] } }); await pending; });
    assert.deepEqual(useAppStore.getState().sessionTodos.b, fresh);
    value = "/skill:fixture/review inspect"; commandsRead = deferred(); await render();
    const count = requests.filter((r) => [IPC.invoke.agentQueuePush, IPC.invoke.agentSteer].includes(r.channel)).length;
    await click(allNodes(container).find((n) => n.attributes?.["data-submit"] === "follow"));
    await act(async () => { useAppStore.setState({ activeSessionId: "a" }); commandsRead.resolve({ commands: [{ name: "skill:fixture/review", kind: "skill", skillId: "fixture/review" }] }); });
    assert.equal(requests.filter((r) => [IPC.invoke.agentQueuePush, IPC.invoke.agentSteer].includes(r.channel)).length, count);
    assert.deepEqual(cleared, ["a", "a"], "late discovery leaves the source draft intact");
    const copied = [];
    const renderCopy = async (projectPath) => act(async () => root.render(createElement(I18nextProvider, { i18n },
      createElement(SessionCopyActions, { projectPath, onCopy: (kind) => copied.push(kind) }))));
    await renderCopy("/bound/a");
    for (const kind of ["title", "projectPath", "id"]) await click(allNodes(container).find((n) => n.attributes?.["data-action"] === `copy-session-${kind}`));
    assert.deepEqual(copied, ["title", "projectPath", "id"]);
    await renderCopy(undefined);
    assert.ok(!allNodes(container).some((n) => n.attributes?.["data-action"] === "copy-session-projectPath"));
  } finally { await act(async () => root.unmount()); restoreGlobals(previous); await server.close(); }
});
