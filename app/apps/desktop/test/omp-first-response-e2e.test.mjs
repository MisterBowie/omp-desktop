import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } =
  await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { projectMessageEnd, upsertLiveSessionMessage } = await import("../src/lib/session-transcript.ts");

test("native first send shares the title runtime and preserves text between tools in live and restored rows", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 60_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-first-response-")));
  const renameReached = Promise.withResolvers();
  const finishRename = Promise.withResolvers();
  const catalogReached = Promise.withResolvers();
  const finishCatalog = Promise.withResolvers();
  const ended = Promise.withResolvers();
  let provider;
  let supervisor;
  let bridge;
  t.after(async () => {
    finishRename.resolve(); finishCatalog.resolve();
    const disposed = await bridge?.dispose();
    const stopped = await supervisor?.stop();
    await provider?.close();
    rmSync(root, { recursive: true, force: true });
    if (disposed) assert.equal(disposed.ok, true);
    if (stopped) {
      assert.equal(stopped.reaped, true);
      assert.equal(stopped.cleaned, true);
    }
  });
  provider = await FakeProvider.start();
  let nativeRef;
  let messages = [];
  const sessionDir = ensureSessionStateDir(root);
  const marker = join(root, "marker.txt");
  writeFileSync(marker, "fixture marker\n");
  provider.script([
    { text: "Checking the first item.", thinking: "Inspect the fixture.",
      toolCalls: [{ id: "first-read", name: "read", args: { path: marker } }] },
    { text: ".", thinking: "Check the next item.",
      toolCalls: [{ id: "second-read", name: "read", args: { path: marker } }] },
    { text: "The first question is answered.", finish: "stop" },
  ]);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, launcherPath: resources.path, sessionDir,
    desktopStateRequired: false,
    args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: (paths) => writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl }),
  });
  bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor, launcher: resources.path, isPackaged: false, appPath: here,
    sessionDir, gateResolver: () => findGateExtension(here),
    persistNativeSession: (value) => { nativeRef = value; },
    persistRename: async () => { renameReached.resolve(); await finishRename.promise; },
    hostTools: {
      catalog: async () => { catalogReached.resolve(); await finishCatalog.promise; return []; },
      executor: () => async () => { throw new Error("No host tools registered"); },
    },
    emitAgentEvent: ({ event }) => {
      if (event.type === "message_start") messages = upsertLiveSessionMessage(messages, event.message);
      if (event.type === "message_end") messages = projectMessageEnd(messages, event);
      if (event.type === "agent_end") ended.resolve();
    },
  });
  const sessionId = "first-response";
  const naming = bridge.rename(sessionId, "first question", { projectPath: root });
  await renameReached.promise;
  const titledNativeId = nativeRef.nativeSessionId;
  const prompting = bridge.prompt({ sessionId, projectPath: root, content: "Check the fixture" });
  prompting.catch(() => undefined);
  await catalogReached.promise;
  finishRename.resolve();
  assert.equal((await naming).ok, true);
  finishCatalog.resolve();
  assert.equal((await prompting).accepted, true);
  await ended.promise;
  assert.equal(nativeRef.nativeSessionId, titledNativeId, "first send must retain the titled native identity");
  assert.equal((await supervisor.currentRuntime().request({ type: "get_state" })).data.sessionName, "first question");
  const expected = ["Checking the first item.", ".", "The first question is answered."];
  assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) => message.content), expected);
  assert.equal(provider.requests.filter((request) => request.url.endsWith("/chat/completions")).length, 3);
  assert.equal(readFileSync(marker, "utf8"), "fixture marker\n");
  const history = await bridge.readHistory({ sessionId, projectPath: root, ...nativeRef, adapterVersion: 1 });
  assert.deepEqual(history.messages.filter((message) => message.role === "assistant").map((message) => message.content), expected);
  assert.equal((await bridge.disposeSession(sessionId)).ok, true);
  const restored = await bridge.readHistory({ sessionId, projectPath: root, ...nativeRef, adapterVersion: 1 });
  assert.deepEqual(restored.messages.filter((message) => message.role === "assistant").map((message) => message.content), expected);
});
