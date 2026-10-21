import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";
const nodes = (n) => [n, ...(n.childNodes ?? []).flatMap(nodes)];
test("mounted isolated creation uses the normal Store workflow and never reuses an empty session", async () => {
    const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const { WorktreeProjectAction, WorktreeSessionActions, WorktreeDialogs } = await server.ssrLoadModule("/src/features/worktree/WorktreeControls.tsx");
    const { useWorktreeUi } = await server.ssrLoadModule("/src/features/worktree/worktree-ui-store.ts");
    const previous = installMinimalDom();
    const previousAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => window.requestAnimationFrame(callback);
    const make = document.createElement.bind(document);
    document.createElement = (tag) => { const n = make(tag); n.namespaceURI = "http://www.w3.org/1999/xhtml"; return n; };
    document.createElementNS = (_ns, tag) => document.createElement(tag);
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const stamp = new Date().toISOString(), old = { id: "empty-old", projectPath: "/project", title: "New task", messageCount: 0, mode: "agent", thinkingLevel: "off", permissionMode: "inherit", createdAt: stamp, updatedAt: stamp, engine: "omp" };
    const created = { ...old, id: "isolated-new", worktree: { branch: "omp-desktop/fixture", status: "active" } };
    const calls = [];
    let createDone;
    const completed = new Promise((r) => createDone = r);
    window.piDesktop = { on: () => () => { }, platform: "darwin", invoke: async (channel, input) => {
            calls.push({ channel, input });
            let data;
            if (channel === IPC.invoke.worktreeProbe)
                data = { available: true, uncommittedChanges: false };
            else if (channel === IPC.invoke.sessionCreate) {
                data = { session: created };
                createDone();
            }
            else if (channel === IPC.invoke.worktreePreview)
                data = {branch: "omp-desktop/fixture", ownerBranch: "main", commits: [], files: [{path: "result.txt", status: "?", uncommitted: true}], conflict: false, previewToken: "reviewed"};
            else if (channel === IPC.invoke.worktreeMerge) data = {result: "merged", files: 1, commits: 1};
            else if (channel === IPC.invoke.sessionList) data = {sessions: [created]};
            else throw new Error(`unexpected IPC ${channel}`);
            return { ok: true, data };
        } };
    useAppStore.setState({ workspace: { path: "/project", name: "Project" }, activeProjectPath: "/project", activeSessionId: old.id, sessions: [old], messages: [], runningSessions: {}, settings: null, providers: [], sessionMeta: {}, page: "chat" });
    const container = document.createElement("div"), root = createRoot(container);
    const click = async (node) => act(async () => { assert.ok(node); for (const listener of container._listeners.click ?? [])
        listener({ type: "click", target: node, bubbles: true, button: 0, preventDefault() { }, stopPropagation() { } }); });
    try {
        await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(WorktreeProjectAction, { projectPath: "/project", onDone() { } }))));
        await click(nodes(container).find((n) => n.attributes?.["data-action"] === "new-isolated-session"));
        await act(async () => completed);
        const request = calls.find((call) => call.channel === IPC.invoke.sessionCreate);
        assert.equal(request.input.isolated, true);
        assert.equal(request.input.engine, "omp");
        assert.equal(request.input.projectPath, "/project");
        assert.equal(useAppStore.getState().activeSessionId, created.id);
        assert.equal(useAppStore.getState().sessions.some((s) => s.id === old.id), true);
        await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(WorktreeSessionActions, { session: created, running: false, onDone() { } }))));
        await click(nodes(container).find((n) => n.attributes?.["data-action"] === "worktree-merge"));
        assert.equal(useWorktreeUi.getState().dialog.sessionId, created.id);
        await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(WorktreeDialogs))));
        const confirm = nodes(document.body).find((node) => node.attributes?.["data-action"] === "worktree-merge-confirm");
        assert.ok(confirm, "reviewed merge has an explicit confirmation action");
        assert.equal(calls.filter((call) => call.channel === IPC.invoke.worktreeMerge).length, 0, "preview does not submit a merge");
        await act(async () => {
            for (const listener of document.body._listeners.click ?? []) listener({type: "click", target: confirm, bubbles: true, button: 0, preventDefault() {}, stopPropagation() {}});
        });
        assert.deepEqual(calls.filter((call) => call.channel === IPC.invoke.worktreeMerge).map((call) => call.input), [{sessionId: created.id, previewToken: "reviewed"}]);
        assert.equal(useWorktreeUi.getState().dialog, null);

    }
    finally {
        await act(async () => root.unmount());
        globalThis.requestAnimationFrame = previousAnimationFrame;
        restoreGlobals(previous);
        await server.close();
    }
});

test("file browser drops an old result after switching away and back to an isolated session", async () => {
    const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
        server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" }, appType: "custom",
        optimizeDeps: { noDiscovery: true, include: [] } });
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const { FilesTab } = await server.ssrLoadModule("/src/components/workpanel/FilesTab.tsx");
    const previous = installMinimalDom();
    const make = document.createElement.bind(document);
    document.createElement = (tag) => { const node = make(tag); node.namespaceURI = "http://www.w3.org/1999/xhtml"; return node; };
    document.createElementNS = (_ns, tag) => document.createElement(tag);
    const i18n = createInstance(); await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    let resolveOld; const oldRead = new Promise((resolve) => { resolveOld = resolve; });
    let first = true;
    const entry = (name) => ({ entries: [{ name, kind: "file", size: 1 }] });
    window.piDesktop = { platform: "darwin", on: () => () => {}, invoke: async (channel, input) => {
        assert.equal(channel, IPC.invoke.fsList);
        if (input.sessionId === "a" && first) { first = false; return { ok: true, data: await oldRead }; }
        return { ok: true, data: entry(input.sessionId === "a" ? "current-a.txt" : "current-b.txt") };
    } };
    useAppStore.setState({ workspace: { path: "/project", name: "Project" }, activeSessionId: "a", workPanelFileRequest: undefined,
        sessions: ["a", "b"].map((id) => ({ id, worktree: { branch: id, status: "active" } })) });
    const container = document.createElement("div"); const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(FilesTab))));
        assert.equal(first, false);
        await act(async () => useAppStore.setState({ activeSessionId: "b" }));
        assert.match(nodes(container).map((node) => node._text ?? "").join(""), /current-b.txt/);
        await act(async () => useAppStore.setState({ activeSessionId: "a" }));
        assert.match(nodes(container).map((node) => node._text ?? "").join(""), /current-a.txt/);
        await act(async () => resolveOld(entry("stale-a.txt")));
        assert.match(nodes(container).map((node) => node._text ?? "").join(""), /current-a.txt/);
        assert.doesNotMatch(nodes(container).map((node) => node._text ?? "").join(""), /stale-a.txt/);
    } finally { await act(async () => root.unmount()); restoreGlobals(previous); await server.close(); }
});
