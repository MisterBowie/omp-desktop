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
const { OmpEventConverter } = await import(
  pathToFileURL(join(here, "../../../packages/omp-runtime/src/session/events.ts"))
);

/**
 * The production Review tab mounted against the real store: an OMP session's
 * native edit/write results appear as read-only rows beside PI snapshots.
 * This is a component harness, not a browser/screenshot E2E.
 */
function convertedRow(id, toolName, details) {
  const converter = new OmpEventConverter({ sessionId: "s", now: () => 1 });
  return converter.convertEntry({
    id: `entry-${id}`,
    timestamp: "2026-11-05T00:00:00Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: id,
      timestamp: 1,
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details,
    },
  });
}

test("mounted Review tab lists OMP edits and writes read-only beside PI snapshots", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { ReviewTab } = await server.ssrLoadModule("/src/components/workpanel/ReviewTab.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const i18n = createInstance();
  // Same interpolation setting as the app (`src/main.tsx`); React escapes output.
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
  const previous = installMinimalDom();
  const createNode = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = createNode(tag);
    node.namespaceURI = "http://www.w3.org/1999/xhtml";
    return node;
  };
  document.createElementNS = (namespace, tag) => {
    const node = createNode(tag);
    node.namespaceURI = namespace;
    return node;
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const container = document.createElement("div");
  const root = createRoot(container);
  const flattenText = (node) => `${node._text ?? ""}${(node.childNodes ?? []).map(flattenText).join("")}`;
  const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
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
  const render = () =>
    act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ReviewTab))));

  const piReview = {
    version: 1, snapshotId: "snap-1", messageId: "pi-1", path: "src/pi.ts", operation: "edit",
    status: "modified", state: "active", additions: 1, deletions: 0,
    hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "PI_LINE" }] }], reversible: true,
  };
  const messages = [
    convertedRow("w-1", "write", { resolvedPath: "/tmp/fixture/notes/created.md" }),
    {
      id: "pi-1", role: "tool", content: "", createdAt: "2026-11-05T00:00:00Z", toolName: "Edit",
      toolStatus: "success", toolResult: { details: { root: "workspace", review: piReview } },
    },
    convertedRow("e-1", "edit", {
      diff: "-1|a1\n+1|A1",
      perFileResults: [
        { path: "/tmp/fixture/src/a.ts", diff: "-1|OLD_A\n+1|NEW_A", op: "update" },
        { path: "/tmp/fixture/src/c.ts", diff: "", op: "update", move: "/tmp/fixture/src/c.ts", sourcePath: "/tmp/fixture/src/b.ts" },
      ],
    }),
    convertedRow("e-2", "edit", { diff: "-1|x", op: "update", path: "/outside/elsewhere.txt" }),
  ];

  try {
    useAppStore.setState({ workspace: { path: "/tmp/fixture" }, messages: [] });
    await render();
    assert.ok(flattenText(container).includes(catalogs.en.panel.review.noChanges), "an empty session shows the empty state");

    await act(async () => useAppStore.setState({ messages }));
    const text = flattenText(container);
    // One PI row plus four OMP rows (a write, two files of one edit, one more edit).
    assert.ok(text.includes("5 recorded changes"), "the toolbar counts every row");
    // Only rows with line evidence add to the totals: PI +1, a.ts +1/−1, elsewhere −1.
    assert.ok(text.includes("+2") && text.includes("−2"), "the toolbar totals only proven lines");
    for (const shown of ["notes/created.md", "src/pi.ts", "src/a.ts", "src/b.ts → src/c.ts", "/outside/elsewhere.txt"]) {
      assert.ok(text.includes(shown), `the Review tab shows ${shown}`);
    }
    const sections = nodes(container).filter((node) => node.nodeName === "SECTION");
    assert.deepEqual(
      sections.map((node) => [node.getAttribute("data-source") ?? "pi", node.getAttribute("data-status")]),
      [["omp", "written"], ["pi", "modified"], ["omp", "modified"], ["omp", "renamed"], ["omp", "modified"]],
      "rows keep message order and carry their own status",
    );

    const header = (section) =>
      nodes(section).find((node) => node.nodeName === "BUTTON" && node.getAttribute("aria-expanded") !== null);
    const [writeRow, , editRow] = sections;
    assert.match(header(writeRow).getAttribute("aria-label"), /Show Written change for notes\/created\.md/);
    assert.match(header(editRow).getAttribute("aria-label"), /1 additions, 1 deletions/);

    await click(header(editRow));
    const editText = flattenText(editRow);
    assert.ok(editText.includes("OLD_A") && editText.includes("NEW_A"), "the OMP diff renders when expanded");
    assert.ok(editText.includes(catalogs.en.panel.review.ompReadOnly), "the row says it is read-only");
    assert.equal(
      nodes(editRow).some((node) => node.nodeName === "BUTTON" && String(node.className).includes("review-change-rollback")),
      false,
      "an OMP row never offers rollback",
    );

    await click(header(writeRow));
    assert.ok(flattenText(writeRow).includes(catalogs.en.panel.review.ompWriteNoDiff), "a write explains why it has no diff");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  }
});
