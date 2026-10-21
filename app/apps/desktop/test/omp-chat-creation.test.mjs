import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

test("New Task creates OMP chats and preserves existing Pi chats", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previous = installMinimalDom();
  try {
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    for (const [projectPath, messageCount] of [["/project", 2], [null, 2], ["/project", 0]]) {
      const legacy = { id: "legacy", engine: "pi", projectPath, messageCount,
        mode: "agent", permissionMode: "inherit", thinkingLevel: "off",
        createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
      const requests = [];
      window.piDesktop = { platform: "darwin", on: () => () => {}, invoke: async (channel, input) => {
        assert.equal(channel, IPC.invoke.sessionCreate);
        requests.push(input);
        // Match host-core's compatibility default when the caller omits an engine.
        return { ok: true, data: { session: { ...legacy, id: "new-chat",
          messageCount: 0, engine: input.engine ?? "pi" } } };
      } };
      useAppStore.setState({
        workspace: projectPath ? { path: projectPath, name: "Project" } : null,
        activeProjectPath: projectPath, activeSessionId: legacy.id, sessions: [legacy],
        messages: [], sessionPanes: {}, sessionMeta: {}, runningSessions: {},
        draftConfiguration: null, settings: null, providers: [], page: "chat",
      });
      await useAppStore.getState().newSession({ projectPath });
      assert.equal(requests.length, 1, "an empty Pi chat must not substitute for a new OMP chat");
      assert.equal(requests[0].engine, "omp", "normal project and temporary chats must explicitly choose OMP");
      const state = useAppStore.getState();
      assert.equal(state.sessions.find((session) => session.id === state.activeSessionId).engine, "omp");
      assert.equal(state.sessions.find((session) => session.id === legacy.id).engine, "pi");
    }
  } finally {
    restoreGlobals(previous);
    await server.close();
  }
});
