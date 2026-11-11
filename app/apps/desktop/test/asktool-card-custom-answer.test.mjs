import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { createServer } from "vite";
import { catalogs } from "@pi-desktop/i18n";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

/*
 * The ask card offers its own typed-answer row only when the asker can take
 * one (`allowCustom`). OMP's `select` dialogs that cannot carry free text set
 * it to false; a card that still offered the row would turn the user's typed
 * answer into a cancelled question, and the runtime ends the turn on that.
 */

async function harness() {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previous = installMinimalDom();
  window.piDesktop = { platform: "darwin", on: () => () => {}, invoke: async () => ({ ok: true, data: null }) };
  const container = document.createElement("div");
  const root = createRoot(container);
  const { AskToolCard } = await server.ssrLoadModule("/src/components/AskToolCard.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });
  const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
  const text = (node) => `${node._text ?? ""}${(node.childNodes ?? []).map(text).join("")}`;
  const click = async (target) => {
    const event = {
      type: "click", target, bubbles: true, button: 0, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
    };
    await act(async () => {
      for (const listener of container._listeners.click ?? []) listener(event);
    });
  };
  const render = (question) =>
    act(async () =>
      root.render(createElement(I18nextProvider, { i18n }, createElement(AskToolCard, {
        key: JSON.stringify(question),
        request: { requestId: "q-1", sessionId: "s", toolCallId: "q-1", questions: [question] },
      }))),
    );
  const cleanup = async () => {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  };
  return { container, nodes, text, click, render, useAppStore, cleanup };
}

const customLabel = catalogs.en.askTool.customOption;

test("mounted: the typed-answer row follows the question's allowCustom flag", async () => {
  const h = await harness();
  try {
    const customRows = () =>
      h.nodes(h.container).filter((node) => String(node.attributes?.class ?? node.className ?? "").includes("asktool-custom-option"));

    await h.render({ question: "Which file?", options: ["a.ts", "b.ts"], multiSelect: false, allowCustom: false });
    assert.equal(customRows().length, 0);
    assert.doesNotMatch(h.text(h.container), new RegExp(customLabel));

    await h.render({ question: "Which scenario?", options: ["Mac to Windows"], multiSelect: false, allowCustom: true });
    assert.equal(customRows().length, 1);
    assert.match(h.text(h.container), new RegExp(customLabel));

    // A question from an asker that predates the flag keeps the row.
    await h.render({ question: "Which scenario?", options: ["Mac to Windows"], multiSelect: false });
    assert.equal(customRows().length, 1);
  } finally {
    await h.cleanup();
  }
});

test("mounted: picking a listed option still submits its exact label", async () => {
  const h = await harness();
  try {
    const submitted = [];
    h.useAppStore.setState({ resolveAsk: async (sessionId, resolution) => { submitted.push([sessionId, resolution]); } });
    await h.render({ question: "Which file?", options: ["a.ts (Recommended)", "b.ts"], multiSelect: false, allowCustom: false });
    const buttons = h.nodes(h.container).filter((node) => node.nodeName?.toLowerCase() === "button");
    await h.click(buttons.find((node) => h.text(node).includes("a.ts (Recommended)")));
    await h.click(buttons.find((node) => h.text(node) === catalogs.en.askTool.submit));
    assert.deepEqual(submitted, [["s", { requestId: "q-1", sessionId: "s", answers: [["a.ts (Recommended)"]] }]]);
  } finally {
    await h.cleanup();
  }
});
