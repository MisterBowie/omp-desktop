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
const { OmpEventConverter } = await import(
  pathToFileURL(join(here, "../../../packages/omp-runtime/src/session/events.ts"))
);

/**
 * The production ToolRow path (not an SSR snapshot and not a HookProbe) mounted
 * against the real `useOpenPreviewTarget`/`api.ts` and a stubbed
 * `window.piDesktop.invoke`. A restored/child OMP row carries no `toolArgs`, so
 * the editable path a `files` block exposes must be clickable through the real
 * host resolver — opening once on success and reporting missing/error without
 * opening. This is a component harness, not a browser/screenshot E2E.
 */
async function createToolRowHarness() {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { ToolRow } = await server.ssrLoadModule(
    "/src/features/chat/transcript/ToolRow.tsx",
  );
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");

  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

  const previous = installMinimalDom();
  const createNode = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = createNode(tag);
    node.namespaceURI = "http://www.w3.org/1999/xhtml";
    node.scrollTop = 0;
    node.scrollHeight = 100;
    node.clientHeight = 100;
    node.scrollTo = ({ top }) => {
      node.scrollTop = top;
    };
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

  const resolved = [];
  const opened = [];
  const toasts = [];
  let resolution = "success";
  window.piDesktop = {
    platform: "darwin",
    on: () => () => {},
    invoke: async (channel, ...args) => {
      if (channel === IPC.invoke.fsResolveRef) {
        resolved.push(args[0]);
        if (resolution === "error") throw new Error("controlled resolver unavailable");
        if (resolution === "missing") return { ok: true, data: { match: null } };
        return {
          ok: true,
          data: {
            match: {
              root: "workspace",
              relativePath: "src/a.ts",
              absolutePath: "/tmp/fixture/src/a.ts",
              matchedBy: "exact-relative",
              projectRoot: { primary: true },
            },
          },
        };
      }
      throw new Error(`Unexpected IPC ${channel}`);
    },
  };

  useAppStore.setState({
    activeSessionId: "s",
    workspace: { path: "/tmp/fixture" },
    pluginViews: [],
    openFileInWorkPanel: (...args) => opened.push(args),
    showToast: (...args) => toasts.push(args),
    transcriptViews: {},
    retainedTranscripts: {},
    runningSessions: {},
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  const flattenText = (node) =>
    `${node._text ?? ""}${(node.childNodes ?? []).map(flattenText).join("")}`;
  const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
  const click = async (target) => {
    const event = {
      type: "click",
      target,
      bubbles: true,
      button: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    await act(async () => {
      for (const listener of container._listeners.click ?? []) listener(event);
    });
  };

  return {
    server,
    previous,
    useAppStore,
    ToolRow,
    i18n,
    root,
    container,
    flattenText,
    nodes,
    click,
    resolved,
    opened,
    toasts,
    setResolution: (mode) => {
      resolution = mode;
    },
  };
}

function convertedRow(id, toolName, text, details) {
  const converter = new OmpEventConverter({ sessionId: "s", now: () => 1 });
  return converter.convertEntry({
    id,
    timestamp: "2026-09-24T00:00:00Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: id,
      timestamp: 1,
      isError: false,
      content: [{ type: "text", text }],
      details,
    },
  });
}

test("mounted ToolRow: disclosure, real host resolution, and missing/error feedback", async () => {
  const harness = await createToolRowHarness();
  const {
    server,
    previous,
    useAppStore,
    ToolRow,
    i18n,
    root,
    container,
    flattenText,
    nodes,
    click,
    resolved,
    opened,
    toasts,
    setResolution,
  } = harness;
  const fixtures = [
    {
      id: "lsp-row",
      toolName: "lsp",
      text: "src/a.ts:1:7 diagnostic marker 2322",
      details: { action: "diagnostics", serverName: "typescript", success: true },
      marker: "diagnostic marker 2322",
    },
    {
      id: "debug-row",
      toolName: "debug",
      text: "No debug session to terminate.",
      details: { action: "terminate", success: true },
      marker: "No debug session to terminate.",
    },
    {
      id: "edit-row",
      toolName: "edit",
      text: "Updated src/a.ts",
      details: { path: "src/a.ts", diff: "-1|BEFORE\n+1|AFTER", op: "update" },
      marker: "AFTER",
      openFile: true,
    },
  ];
  try {
    for (const fixture of fixtures) {
      const row = convertedRow(fixture.id, fixture.toolName, fixture.text, fixture.details);
      assert.equal(row.toolArgs, undefined, `${fixture.id}: a restored/child row has no toolArgs`);
      await act(async () =>
        root.render(
          createElement(
            I18nextProvider,
            { i18n },
            createElement(ToolRow, { key: fixture.id, message: row }),
          ),
        ),
      );
      const header = nodes(container).find(
        (node) =>
          node.nodeName === "BUTTON" && node.getAttribute("aria-expanded") === "false",
      );
      assert.ok(header, `${fixture.id}: collapsed row has a disclosure`);
      await click(header);
      assert.ok(
        flattenText(container).includes(fixture.marker),
        `${fixture.id}: the expanded ToolRow exposes result meaning`,
      );
      if (!fixture.openFile) continue;
      const link = nodes(container).find(
        (node) =>
          node.nodeName === "BUTTON" &&
          node.className.includes("tool-file-item") &&
          flattenText(node).includes("src/a.ts"),
      );
      assert.ok(link, "edit result has an existing file-opening affordance");
      await click(link);
      assert.equal(resolved.length, 1, "file click uses actual host resolution");
      assert.equal(opened.length, 1, "resolved file opens once");
      assert.equal(opened[0][0], "src/a.ts");
      for (const mode of ["missing", "error"]) {
        setResolution(mode);
        const resolvesBefore = resolved.length;
        const toastsBefore = toasts.length;
        await click(link);
        assert.equal(resolved.length, resolvesBefore + 1, `${mode}: click reaches the host`);
        assert.equal(opened.length, 1, `${mode}: unresolved path never opens a file`);
        assert.equal(toasts.length, toastsBefore + 1, `${mode}: existing error feedback appears`);
        assert.equal(toasts.at(-1)[1].variant, "error");
      }
    }
  } finally {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  }
});

test("mounted ToolRow: auto-open never resolves a file and a restored row has no toolArgs", async () => {
  const harness = await createToolRowHarness();
  const {
    server,
    previous,
    ToolRow,
    i18n,
    root,
    container,
    flattenText,
    resolved,
    opened,
  } = harness;
  try {
    const row = convertedRow("edit-row", "edit", "Updated src/a.ts", {
      path: "src/a.ts",
      diff: "-1|BEFORE\n+1|AFTER",
      op: "update",
    });
    assert.equal(row.toolArgs, undefined, "a restored/child row has no toolArgs");
    await act(async () =>
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ToolRow, { key: "edit-row", message: row, autoOpen: true }),
        ),
      ),
    );
    assert.ok(
      flattenText(container).includes("AFTER"),
      "auto-open expands the body but the diff still renders",
    );
    assert.equal(resolved.length, 0, "auto-open does not resolve any file");
    assert.equal(opened.length, 0, "auto-open does not open any file");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  }
});
