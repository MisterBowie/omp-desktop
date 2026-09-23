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
 * R2: the OMP child detail is read through the OMP-only bridge, not the live
 * transcript. Pi sessions keep their existing transcript detail untouched.
 *
 * SSR renders do not run effects, so the bridge read itself is not exercised
 * here (that is `omp-subagent-read.test.mjs`, which drives the real api.ts
 * methods). This test proves the *wiring*: an OMP session takes the bridge-read
 * delegate (empty during SSR) while a Pi session keeps the transcript delegate.
 */
test("OMP sessions route child detail through the bridge read, Pi keeps the transcript", async () => {
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
    const { SubagentPanel } = await server.ssrLoadModule(
      "/src/components/workpanel/SubagentPanel.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (selection) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(SubagentPanel, { selection })),
      );

    const parent = {
      id: "task-1",
      role: "tool",
      toolName: "task",
      toolCallId: "task-1",
      content: "",
      toolArgs: { task: "delegate" },
      toolResult: { details: { delegationId: "child-1", status: "completed" } },
      status: "complete",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    const child = {
      id: "child-row",
      role: "assistant",
      content: "child answer from transcript",
      parentToolCallId: "task-1",
      agentName: "task",
      status: "complete",
      createdAt: "2026-09-23T00:00:01.000Z",
    };

    // Pi session: the transcript-derived delegate must render.
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: "s",
      retainedSessionIds: ["s"],
      messages: [parent, child],
      retainedTranscripts: {},
      transcriptViews: {},
      sessions: [{ id: "s", title: "Pi session", mode: "agent", messageCount: 2 }],
    });
    const piPanel = render({ sessionId: "s", delegationId: "child-1" });
    assert.match(piPanel, /child answer from transcript/, "Pi renders the transcript child rows");

    // OMP session: the child rows come from the bridge read (empty during SSR),
    // so the transcript-derived child rows must NOT render.
    Object.assign(useAppStore.getInitialState(), {
      sessions: [{ id: "s", title: "OMP session", mode: "agent", messageCount: 2, engine: "omp" }],
    });
    const ompPanel = render({ sessionId: "s", delegationId: "child-1" });
    assert.doesNotMatch(ompPanel, /child answer from transcript/, "OMP must not reuse the transcript child rows");
    assert.match(ompPanel, /subagent-detail/, "OMP still renders the Task card header");
    // During SSR the bridge read has produced no rows yet, so the panel shows
    // its loading state rather than an empty body.
    assert.match(ompPanel, /Loading subagent details/, "OMP renders the loading state while the read is pending");
  } finally {
    globalThis.document = originalDocument;
    globalThis.NodeFilter = originalFilter;
    await server.close();
  }
});

test("SubagentDetail renders the OMP read states: loading, empty, error, retry", async () => {
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
    const { SubagentDetail } = await server.ssrLoadModule(
      "/src/features/chat/transcript/SubagentDetail.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const message = {
      id: "task-1",
      role: "tool",
      toolName: "task",
      toolCallId: "task-1",
      content: "",
      toolArgs: { task: "delegate" },
      toolResult: { details: { delegationId: "child-1", status: "running" } },
      status: "complete",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    const render = (readStatus) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(SubagentDetail, { message, readStatus })),
      );

    assert.match(render({ phase: "loading" }), /Loading subagent details/);
    assert.match(render({ phase: "empty" }), /Subagent details are no longer available/);
    const error = render({ phase: "error", detail: "boom", onRetry: () => {} });
    assert.match(error, /boom/);
    assert.match(error, /Try again/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.NodeFilter = originalFilter;
    await server.close();
  }
});
