import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { createServer } from "vite";
import { catalogs } from "@pi-desktop/i18n";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("../../../packages/shared/src/protocol.ts");

/**
 * The *production* SubagentPanel path (not a HookProbe) mounted against the
 * real `api.ts` and a stubbed `window.piDesktop.invoke`. Each test drives the
 * panel's exact render wiring through controlled timers and promises.
 */
async function createRealPanelHarness() {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { SubagentPanel } = await server.ssrLoadModule("/src/components/workpanel/SubagentPanel.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

  const previous = installMinimalDom();
  // The panel's scroll surface needs just enough shape for useFollowScroll.
  const createNode = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = createNode(tag);
    node.namespaceURI = "http://www.w3.org/1999/xhtml";
    node.scrollTop = 0;
    node.scrollHeight = 100;
    node.clientHeight = 100;
    node.scrollTo = ({ top }) => { node.scrollTop = top; };
    node.querySelector = () => null;
    node.querySelectorAll = () => [];
    return node;
  };
  document.createElementNS = (namespace, tag) => {
    const node = document.createElement(tag);
    node.namespaceURI = namespace;
    return node;
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  // Controlled timers: the poll interval is a 2s window.setTimeout we fire
  // manually, never a wall-clock sleep.
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);

  const counts = { reads: 0 };
  const behaviour = { list: null, read: null };
  window.piDesktop = {
    platform: "linux",
    on: () => () => {},
    invoke: async (channel, ...args) => {
      if (channel === IPC.invoke.ompSubagentList) {
        return (behaviour.list ?? (() => ({ ok: true, data: [] })))();
      }
      if (channel === IPC.invoke.ompSubagentRead) {
        counts.reads += 1;
        return behaviour.read(args[0]);
      }
      throw new Error(`unexpected IPC ${channel}`);
    },
  };

  const container = document.createElement("div");
  const root = createRoot(container);
  const flattenText = (node) =>
    `${node._text ?? ""}${(node.childNodes ?? []).map(flattenText).join("")}`;
  const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];

  return {
    server,
    previous,
    useAppStore,
    i18n,
    timers,
    counts,
    behaviour,
    container,
    flattenText,
    nodes,
    render: (selection) =>
      act(async () => {
        root.render(createElement(I18nextProvider, { i18n }, createElement(SubagentPanel, { selection })));
      }),
    cleanup: async () => {
      await act(async () => root.unmount());
      restoreGlobals(previous);
      await server.close();
    },
  };
}

const taskMessage = (id, delegationId) => ({
  id,
  role: "tool",
  toolName: "task",
  toolCallId: id,
  content: "",
  toolArgs: { task: "delegate" },
  toolResult: { details: { delegationId, status: "running" } },
  status: "complete",
  createdAt: "2026-09-24T00:00:00Z",
});

const assistantMessage = (id, content) => ({
  id,
  role: "assistant",
  content,
  status: "complete",
  createdAt: "2026-09-24T00:00:00Z",
});

/**
 * B2: the production panel must hold one read in flight, keep accumulated rows
 * visible, and surface an incremental error with a working retry alongside
 * those rows.
 */
test("real SubagentPanel: one read on mount, retained rows plus visible error/retry, retry clears", async () => {
  const h = await createRealPanelHarness();
  try {
    let failure = false;
    let recovered = false;
    h.behaviour.list = () => ({ ok: true, data: [{ id: "child-1", parentToolCallId: "task-1" }] });
    h.behaviour.read = () =>
      failure
        ? { ok: false, error: { code: "ENGINE_CAPABILITY_UNAVAILABLE", message: "READ-FAILURE" } }
        : {
            ok: true,
            data: {
              cursor: { fromByte: 0, nextByte: recovered ? 14 : 7, reset: false },
              messages: [
                assistantMessage("kept", "KEPT-OUTPUT"),
                ...(recovered ? [assistantMessage("recovered", "RECOVERED-OUTPUT")] : []),
              ],
            },
          };

    h.useAppStore.setState({
      activeSessionId: "s",
      retainedSessionIds: ["s"],
      retainedTranscripts: {},
      transcriptViews: {},
      runningSessions: { s: true },
      sessions: [{ id: "s", title: "OMP", mode: "agent", messageCount: 1, engine: "omp" }],
      messages: [taskMessage("task-1", "child-1")],
    });

    await h.render({ sessionId: "s", delegationId: "child-1" });

    const initial = h.flattenText(h.container);
    const readsAfterMount = h.counts.reads;

    // Mounting a running child must perform exactly one list/read chain.
    assert.equal(readsAfterMount, 1, "mounting a running child performs exactly one read");

    // The initial read produced rows and scheduled the next poll 2s out.
    assert.ok(initial.includes("KEPT-OUTPUT"), "initial rows are visible");
    const scheduled = [...h.timers.entries()].find(([, timer]) => timer.delay === 2000);
    assert.ok(scheduled, "a continuation poll is scheduled 2s after completion");
    h.timers.delete(scheduled[0]);

    // The next poll fails: rows stay, the error and retry become visible.
    failure = true;
    await act(async () => { await scheduled[1].callback(); });
    const failed = h.flattenText(h.container);
    const readsAfterError = h.counts.reads;
    assert.equal(readsAfterError, 2, "the continuation poll is the second, single read");
    assert.ok(failed.includes("KEPT-OUTPUT"), "rows are retained across the error");
    assert.ok(failed.includes("READ-FAILURE"), "the incremental error is visible");

    const retryButton = h.nodes(h.container).find(
      (node) => node.nodeName === "BUTTON" && h.flattenText(node).includes("Try again"),
    );
    assert.ok(retryButton, "a retry control is visible alongside the retained rows");

    // Clicking the real rendered retry triggers exactly one more read and
    // clears the error without dropping the retained rows.
    failure = false;
    recovered = true;
    const click = {
      type: "click",
      target: retryButton,
      bubbles: true,
      button: 0,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
    };
    await act(async () => {
      for (const listener of h.container._listeners.click ?? []) listener(click);
    });
    const retried = h.flattenText(h.container);
    const readsAfterRetry = h.counts.reads;

    assert.equal(readsAfterRetry - readsAfterError, 1, "the retry click performs exactly one additional read");
    assert.ok(retried.includes("RECOVERED-OUTPUT"), "retry success lands the recovered rows");
    assert.ok(retried.includes("KEPT-OUTPUT"), "rows are retained across the retry");
    assert.ok(!retried.includes("READ-FAILURE"), "retry success clears the error");
  } finally {
    await h.cleanup();
  }
});

/**
 * The production panel keys `TranscriptDisclosureProvider` by selection, so a
 * selection change remounts the read hook. A stale pending read from the old
 * selection must neither replace the new selection's rows nor re-arm its poll.
 */
test("real SubagentPanel: a keyed selection remount isolates the stale old read", async () => {
  const h = await createRealPanelHarness();
  try {
    let resolveOld;
    const readsByChild = { "child-1": 0, "child-2": 0 };
    h.behaviour.list = () => ({
      ok: true,
      data: [
        { id: "child-1", parentToolCallId: "task-1" },
        { id: "child-2", parentToolCallId: "task-2" },
      ],
    });
    h.behaviour.read = (args) => {
      const childId = args.subagentId;
      readsByChild[childId] = (readsByChild[childId] ?? 0) + 1;
      if (childId === "child-1") {
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return {
        ok: true,
        data: { cursor: { fromByte: 0, nextByte: 5, reset: false }, messages: [assistantMessage("new", "NEW-ROW")] },
      };
    };

    h.useAppStore.setState({
      activeSessionId: "s",
      retainedSessionIds: ["s"],
      retainedTranscripts: {},
      transcriptViews: {},
      runningSessions: { s: true },
      sessions: [{ id: "s", title: "OMP", mode: "agent", messageCount: 2, engine: "omp" }],
      messages: [taskMessage("task-1", "child-1"), taskMessage("task-2", "child-2")],
    });

    // Old selection: its read is still pending.
    await h.render({ sessionId: "s", delegationId: "child-1" });
    assert.equal(h.counts.reads, 1, "the old selection starts exactly one read");

    // New selection on the same root: the keyed remount starts a fresh read.
    await h.render({ sessionId: "s", delegationId: "child-2" });
    assert.equal(h.counts.reads, 2, "the keyed remount starts exactly one new read");
    assert.equal(readsByChild["child-2"], 1, "the new read targets the new selection");
    assert.ok(h.flattenText(h.container).includes("NEW-ROW"), "the new selection renders its rows");

    // The stale old read resolves afterwards: it must not replace the new rows.
    resolveOld({
      ok: true,
      data: { cursor: { fromByte: 0, nextByte: 99, reset: false }, messages: [assistantMessage("old", "OLD-ROW")] },
    });
    await act(async () => {});
    assert.equal(h.counts.reads, 2, "the stale completion starts no further read");
    assert.ok(h.flattenText(h.container).includes("NEW-ROW"), "the new rows survive the stale completion");
    assert.ok(!h.flattenText(h.container).includes("OLD-ROW"), "the stale rows must not replace the new selection");
  } finally {
    await h.cleanup();
  }
});
