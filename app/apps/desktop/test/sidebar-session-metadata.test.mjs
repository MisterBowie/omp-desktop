import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

test("production Sidebar shows dates and project activity while its rows are folded", async () => {
  const previous = globalThis.document;
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { Sidebar } = await server.ssrLoadModule("/src/components/Sidebar.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    globalThis.document = { documentElement: { dataset: { theme: "light" } } };
    const stamp = "2026-01-03T12:00:00Z";
    const sessions = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, title: `Session ${i}`, updatedAt: new Date(Date.parse(stamp) - i * 60_000).toISOString(), createdAt: stamp, projectPath: "/project-a", engine: "omp" }));
    Object.assign(useAppStore.getInitialState(), { sessions, sessionMeta: {}, projectMeta: { "/project-a": { collapsed: true } },
      openProjectPaths: ["/project-a"], openProjects: [], workspace: null, activeProjectPath: null, activeSessionId: null,
      selectingSessionId: null, page: "chat", projectCollapsed: {}, sessionView: { sort: "recent", archived: false },
      runningSessions: { s12: true }, pendingPermissions: {}, sessionOutcomes: {} });
    const render = () => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Sidebar, {
      sidebarWidth: 275, onWidthChange() {}, onWidthCommit() {}, onToggleSidebar() {}, sidebarToggleShortcut: "Cmd+B",
    })));
    const collapsed = render();
    assert.match(collapsed, new RegExp(`sidebar-project-activity[\\s\\S]*?aria-label="${i18n.t("nav.sessionRunning")}"`));
    assert.match(collapsed, /sidebar-session-group-body project collapsed[^>]*aria-hidden="true"/);
    assert.doesNotMatch(collapsed, /data-sidebar-session-row="s12"/);
    useAppStore.getInitialState().projectMeta = {};
    const expanded = render();
    assert.match(expanded, /<time[^>]*datetime="2026-01-03T12:00:00.000Z"/i);
    assert.match(expanded, /aria-label="Last reply:/);
    useAppStore.getInitialState().pendingPermissions = { s11: [{}] };
    assert.match(render(), new RegExp(`sidebar-project-activity[\\s\\S]*?aria-label="${i18n.t("nav.sessionPermission")}"`));
  } finally { globalThis.document = previous; await server.close(); }
});
