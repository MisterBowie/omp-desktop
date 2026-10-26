import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } =
  await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { createOmpThinkingLevelResolver, projectSessionModels } =
  await import("../electron/main/runtime/omp-session-wiring.ts");

/**
 * The reported refusal on the real runtime: the binding's enabled ladder no
 * longer carries `off`, the session still stores it, and the composer shows
 * the clamped `low`. The production projection and resolver must run the
 * prompt at `low` rather than refusing it or leaving OMP on its own default.
 */
test("native OMP runs a stale stored thinking level at the composer's clamped level", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 60_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-thinking-level-")));
  let provider;
  let supervisor;
  let bridge;
  t.after(async () => {
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
  provider = await FakeProvider.start({ model: "local-model" });
  provider.script([{ text: "FIRST", finish: "stop" }, { text: "SECOND", finish: "stop" }]);
  const ladder = ["low", "medium", "high"];
  const row = {
    id: "fixture", enabled: true, apiStyle: "chat_completions", authKind: "none", baseUrl: provider.baseUrl,
    models: [{ id: "local-model", thinkingLevels: ladder, providerCapabilities: { reasoning: true, thinkingLevels: ladder } }],
  };
  const host = { call: async (method, params) => {
    assert.equal(method, "providers.get");
    return { provider: params.id === row.id ? row : null };
  } };
  const binding = { providerId: "fixture", modelId: "local-model", thinkingLevel: "off" };
  const sessionDir = ensureSessionStateDir(root);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, cwd: root, launcherPath: resources.path, sessionDir,
    desktopStateRequired: false,
    args: ["--model", "fixture/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: (paths) => projectSessionModels(() => host, { sessionId: "thinking", projectDirectory: root, ...binding }, paths),
  });
  let ended = Promise.withResolvers();
  bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor, launcher: resources.path, isPackaged: false, appPath: here,
    sessionDir, gateResolver: () => findGateExtension(here),
    resolveThinkingLevel: createOmpThinkingLevelResolver(() => host),
    persistConfig: async () => undefined,
    emitAgentEvent: ({ event }) => { if (event.type === "agent_end") ended.resolve(); },
  });

  const first = await bridge.prompt({ sessionId: "thinking", projectPath: root, content: "hello", ...binding });
  assert.equal(first.accepted, true, "a stale stored level must not refuse the send");
  await ended.promise;
  const runtime = supervisor.currentRuntime();
  assert.equal((await runtime.request({ type: "get_state" })).data.thinkingLevel, "low",
    "the fresh runtime runs at the clamped level, not its own default");
  const completions = () => provider.requests.filter((request) => request.url.endsWith("/chat/completions"));
  assert.equal(completions().at(-1).body.reasoning_effort, "low");

  // A change on the live runtime reaches the next request.
  assert.equal((await bridge.configure("thinking", { thinkingLevel: "medium" })).ok, true);
  ended = Promise.withResolvers();
  assert.equal((await bridge.prompt({ sessionId: "thinking", projectPath: root, content: "again", ...binding, thinkingLevel: "medium" })).accepted, true);
  await ended.promise;
  assert.equal(completions().at(-1).body.reasoning_effort, "medium");
});
