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
 * B2: the *production* SubagentPanel path (not a HookProbe) must hold one
 * read in flight, keep accumulated rows visible, and surface an incremental
 * error with a working retry alongside those rows. The panel mounts the real
 * `api.ts` against a stubbed `window.piDesktop.invoke`, so this exercises the
 * exact render wiring the earlier HookProbe could not.
 */
test("real SubagentPanel: one read on mount, retained rows plus visible error/retry, retry clears", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  let root;
  let previous;
  try {
    const { SubagentPanel } = await server.ssrLoadModule("/src/components/workpanel/SubagentPanel.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

    previous = installMinimalDom();
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

    let failure = false;
    let recovered = false;
    let reads = 0;
    window.piDesktop = {
      platform: "linux",
      on: () => () => {},
      invoke: async (channel) => {
        if (channel === IPC.invoke.ompSubagentList) {
          return { ok: true, data: [{ id: "child-1", parentToolCallId: "task-1" }] };
        }
        if (channel === IPC.invoke.ompSubagentRead) {
          reads += 1;
          return failure
            ? { ok: false, error: { code: "ENGINE_CAPABILITY_UNAVAILABLE", message: "READ-FAILURE" } }
            : {
                ok: true,
                data: {
                  cursor: { fromByte: 0, nextByte: recovered ? 14 : 7, reset: false },
                  messages: [
                    { id: "kept", role: "assistant", content: "KEPT-OUTPUT", status: "complete", createdAt: "2026-09-24T00:00:00Z" },
                    ...(recovered
                      ? [{ id: "recovered", role: "assistant", content: "RECOVERED-OUTPUT", status: "complete", createdAt: "2026-09-24T00:00:01Z" }]
                      : []),
                  ],
                },
              };
        }
        throw new Error(`unexpected IPC ${channel}`);
      },
    };

    useAppStore.setState({
      activeSessionId: "s",
      retainedSessionIds: ["s"],
      retainedTranscripts: {},
      transcriptViews: {},
      runningSessions: { s: true },
      sessions: [{ id: "s", title: "OMP", mode: "agent", messageCount: 1, engine: "omp" }],
      messages: [
        {
          id: "task-1",
          role: "tool",
          toolName: "task",
          toolCallId: "task-1",
          content: "",
          toolArgs: { task: "delegate" },
          toolResult: { details: { delegationId: "child-1", status: "running" } },
          status: "complete",
          createdAt: "2026-09-24T00:00:00Z",
        },
      ],
    });

    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nextProvider, { i18n }, createElement(SubagentPanel, { selection: { sessionId: "s", delegationId: "child-1" } })));
    });

    const flattenText = (node) =>
      `${node._text ?? ""}${(node.childNodes ?? []).map(flattenText).join("")}`;
    const initial = flattenText(container);
    const readsAfterMount = reads;

    // Mounting a running child must perform exactly one list/read chain.
    assert.equal(readsAfterMount, 1, "mounting a running child performs exactly one read");

    // The initial read produced rows and scheduled the next poll 2s out.
    assert.ok(initial.includes("KEPT-OUTPUT"), "initial rows are visible");
    const scheduled = [...timers.entries()].find(([, timer]) => timer.delay === 2000);
    assert.ok(scheduled, "a continuation poll is scheduled 2s after completion");
    timers.delete(scheduled[0]);

    // The next poll fails: rows stay, the error and retry become visible.
    failure = true;
    await act(async () => { await scheduled[1].callback(); });
    const failed = flattenText(container);
    const readsAfterError = reads;
    assert.equal(readsAfterError, 2, "the continuation poll is the second, single read");
    assert.ok(failed.includes("KEPT-OUTPUT"), "rows are retained across the error");
    assert.ok(failed.includes("READ-FAILURE"), "the incremental error is visible");

    const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
    const retryButton = nodes(container).find(
      (node) => node.nodeName === "BUTTON" && flattenText(node).includes("Try again"),
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
      for (const listener of container._listeners.click ?? []) listener(click);
    });
    const retried = flattenText(container);
    const readsAfterRetry = reads;

    assert.equal(readsAfterRetry - readsAfterError, 1, "the retry click performs exactly one additional read");
    assert.ok(retried.includes("RECOVERED-OUTPUT"), "retry success lands the recovered rows");
    assert.ok(retried.includes("KEPT-OUTPUT"), "rows are retained across the retry");
    assert.ok(!retried.includes("READ-FAILURE"), "retry success clears the error");
  } finally {
    if (root) await act(async () => root.unmount());
    if (previous) restoreGlobals(previous);
    await server.close();
  }
});
