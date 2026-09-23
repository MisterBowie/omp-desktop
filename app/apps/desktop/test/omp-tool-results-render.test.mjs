import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The OMP edit/LSP/debug adaptation emits existing block kinds (code, diff,
 * fields, note), so this proves the real `ToolDetailBlocks` renders them into
 * visible markup rather than only checking the pure presenter's shapes.
 */
test("ToolDetailBlocks renders OMP edit, LSP and debug blocks", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  const originalFilter = globalThis.NodeFilter;
  try {
    const { ToolDetailBlocks } = await server.ssrLoadModule("/src/components/ToolDetails.tsx");
    const { buildToolPresentation } = await server.ssrLoadModule("/src/lib/tool-presentation.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (blocks) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(ToolDetailBlocks, { blocks })),
      );

    const lsp = render(
      buildToolPresentation(
        {
          toolName: "lsp",
          toolResult: {
            content: [{ type: "text", text: "Diagnostics: 1 error(s)\nType 'number' is not assignable to type 'string'." }],
            details: { action: "diagnostics", serverName: "typescript", success: true },
          },
        },
        { hideSummaryArg: true },
      ),
    );
    assert.match(lsp, /Diagnostics: 1 error/, "the LSP diagnostic text renders");

    const edit = render(
      buildToolPresentation(
        {
          toolName: "edit",
          toolResult: {
            content: [{ type: "text", text: "Updated src/App.tsx" }],
            details: { path: "src/App.tsx", op: "update", diff: "-1|old\n+1|new", oldText: "old\n", newText: "new\n" },
          },
        },
        { hideSummaryArg: true },
      ),
    );
    assert.match(edit, /src\/App\.tsx/, "the edited path renders");
    assert.match(edit, /old/, "the removed line renders");
    assert.match(edit, /new/, "the added line renders");

    const debug = render(
      buildToolPresentation(
        {
          toolName: "debug",
          toolResult: {
            content: [{ type: "text", text: "Result: EVALUATED_VALUE_42" }],
            details: {
              action: "evaluate",
              success: true,
              snapshot: { adapter: "mock", status: "stopped", cwd: "/tmp/example", program: "example.js" },
              evaluation: { result: "EVALUATED_VALUE_42", type: "string", variablesReference: 0 },
            },
          },
        },
        { hideSummaryArg: true },
      ),
    );
    assert.match(debug, /EVALUATED_VALUE_42/, "the debug evaluation value renders");
    assert.match(debug, /example\.js/, "the debug snapshot renders");
  } finally {
    await server.close();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalFilter === undefined) delete globalThis.NodeFilter;
    else globalThis.NodeFilter = originalFilter;
  }
});
