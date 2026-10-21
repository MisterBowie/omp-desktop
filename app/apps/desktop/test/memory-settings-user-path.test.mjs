import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";
import { catalogs } from "@pi-desktop/i18n";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = (node) => nodes(node).map((child) => child._text ?? "").join("");
test("memory browsing keeps the selected worktree and temporary chat", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previous = installMinimalDom();
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = make(tag);
    node.namespaceURI = "http://www.w3.org/1999/xhtml";
    if (tag === "select") Object.defineProperty(node, "options", {
      get: () => nodes(node).filter((child) => child.tagName === "OPTION"),
    });
    return node;
  };
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const { MemorySettingsPage } = await server.ssrLoadModule("/src/features/settings/MemorySettingsPage.tsx");
    const requests = [];
    window.piDesktop = { platform: "darwin", on: () => () => {}, invoke: async (channel, input) => {
      let data;
      if (channel === IPC.invoke.projectList) data = { projects: [{ path: "/project", name: "Project" }] };
      else if (channel === IPC.invoke.ompMemorySettingsGet) data = { autoSave: true, autoRead: true };
      else if (channel === IPC.invoke.ompMemoryQuery) {
        requests.push(input);
        data = { total: input.sessionId ? 1 : 0, offset: 0,
          items: input.sessionId ? [{ id: "saved", content: "Worktree saved memory" }] : [] };
      } else throw new Error(`Unexpected IPC ${channel}`);
      return { ok: true, data };
    } };
    useAppStore.setState({ workspace: { path: "/project", name: "Project" }, sessions: [
      { id: "legacy", projectPath: "/project", engine: "pi" },
      { id: "isolated", projectPath: "/project", engine: "omp",
        title: "Isolated chat", worktree: { branch: "fixture" } },
      { id: "temporary", engine: "omp", title: "Temporary chat" },
    ] });
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(MemorySettingsPage))));
    const select = nodes(container).find((node) => node.tagName === "SELECT");
    for (const sessionId of ["isolated", "temporary"]) {
      await act(async () => {
        select.value = `session:${sessionId}`;
        for (const listener of container._listeners.change ?? []) listener({
          type: "change", target: select, bubbles: true, preventDefault() {}, stopPropagation() {},
        });
      });
      assert.equal(requests.at(-1).sessionId, sessionId);
      assert.match(text(container), /Worktree saved memory/);
    }
  } finally {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  }
});
