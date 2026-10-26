import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const { latestTurnContextInspector } = await import("../src/lib/latest-turn-context.ts");
const { calculateContextUsage } = await import("../src/lib/context-usage.ts");

// E2E-OMP-context-ring-keeps-last-usage: every model request starts with the
// provider's all-zero usage placeholder. The composer ring must keep the last
// reported reading while the next request streams, not read 0% used.
test("native context ring keeps the last reported usage while the next request streams", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 60_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-context-usage-")));
  const secondStreaming = Promise.withResolvers();
  const finishSecond = Promise.withResolvers();
  const ended = Promise.withResolvers();
  let provider;
  let supervisor;
  let bridge;
  t.after(async () => {
    finishSecond.resolve();
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
  const sessionDir = ensureSessionStateDir(root);
  const marker = join(root, "marker.txt");
  writeFileSync(marker, "fixture marker\n");
  provider.script([
    { thinking: "Read the fixture first.", toolCalls: [{ id: "read-1", name: "read", args: { path: marker } }],
      usage: { prompt_tokens: 12_000, completion_tokens: 400 } },
    { thinking: "Summarise what was read.", text: "The fixture is in place.", finish: "stop",
      waitFor: finishSecond.promise, usage: { prompt_tokens: 12_600, completion_tokens: 200 } },
  ]);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, launcherPath: resources.path, sessionDir,
    desktopStateRequired: false,
    args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: (paths) => writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl }),
  });
  let messages = [];
  const assistantStarts = [];
  const assistantEnds = [];
  bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor, launcher: resources.path, isPackaged: false, appPath: here,
    sessionDir, gateResolver: () => findGateExtension(here),
    persistNativeSession: () => {},
    hostTools: { catalog: async () => [], executor: () => async () => { throw new Error("No host tools registered"); } },
    emitAgentEvent: ({ event }) => {
      if (event.type === "message_start") {
        messages = upsertLiveSessionMessage(messages, event.message);
        if (event.message.role === "assistant") {
          assistantStarts.push(event.message);
          if (assistantStarts.length === 2) secondStreaming.resolve();
        }
      }
      if (event.type === "message_end") {
        messages = projectMessageEnd(messages, event);
        if (event.message.role === "assistant") assistantEnds.push(event.message);
      }
      if (event.type === "agent_end") ended.resolve();
    },
  });

  const prompting = bridge.prompt({ sessionId: "context-usage", projectPath: root, content: "Check the fixture" });
  assert.equal((await prompting).accepted, true);
  await secondStreaming.promise;

  // The second request is mid-stream: its row exists but has no usage yet.
  assert.equal(assistantEnds.length, 1);
  const firstUsage = assistantEnds[0].usage;
  assert.ok(firstUsage && firstUsage.inputTokens > 0, "the first request reports real usage");
  const during = latestTurnContextInspector(messages, {}, []);
  assert.deepEqual(during?.usage, firstUsage, "the ring keeps the last reported request");
  assert.ok(calculateContextUsage(during.usage, during.contextWindow).usedTokens > 0);
  for (const started of assistantStarts) {
    assert.equal("usage" in started, false, "a streaming row must not carry the zero placeholder");
  }

  finishSecond.resolve();
  await ended.promise;
  assert.equal(assistantEnds.length, 2);
  const after = latestTurnContextInspector(messages, {}, []);
  assert.deepEqual(after?.usage, assistantEnds[1].usage);
  assert.ok(after.usage.inputTokens > firstUsage.inputTokens, "the ring moves to the newest request once it reports");
});
