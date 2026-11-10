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
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } =
  await import("../../../packages/omp-runtime/src/index.ts");
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
const { resolveProviderProjection, projectModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");

const PREAMBLE = "I'll create the v2.0.0 tag and push it.";

/** The live assistant row as the renderer builds it: the start body plus every delta. */
function liveRows(events) {
  const rows = new Map();
  for (const event of events) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      rows.set(event.message.id, { content: event.message.content, thinking: event.message.thinking ?? "" });
    } else if (event.type === "message_update" && rows.has(event.message.id)) {
      const row = rows.get(event.message.id);
      row.content += event.deltaText ?? "";
      row.thinking += event.deltaThinking ?? "";
    }
  }
  return [...rows.values()];
}

/**
 * Reply text before a gated tool call shows once while the approval waits.
 *
 * The runtime serializes `message_start` after its stream already holds the
 * first chunk, which also arrives as a delta; the assistant row stays live
 * until the tool settles, so a restated start body stayed doubled on screen.
 */
test("native OMP reply text before a gated tool shows once while approval waits", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 180_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-stream-start-")));
  let provider;
  let supervisor;
  let runner;
  t.after(async () => {
    runner?.dispose("stream start test finished");
    const stopped = await supervisor?.stop({ abortBash: false });
    await provider?.close();
    rmSync(root, { recursive: true, force: true });
    if (stopped) {
      assert.equal(stopped.reaped, true);
      assert.equal(stopped.cleaned, true);
    }
  });
  provider = await FakeProvider.start({ model: "local-model" });
  provider.script([
    {
      text: PREAMBLE, thinking: "Tag first, then push.", finish: "tool_calls",
      toolCalls: [{ id: "call_push", name: "bash", args: { command: "git tag v2.0.0 && git push origin v2.0.0" } }],
    },
    { text: "Nothing was pushed.", finish: "stop" },
  ]);
  const resolved = resolveProviderProjection({
    id: "fixture", apiStyle: "chat_completions", authKind: "none", baseUrl: provider.baseUrl,
    models: [{ id: "local-model" }],
  }, "local-model", null);
  assert.equal(resolved.ok, true);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, cwd: root, launcherPath: resources.path, sessionDir: ensureSessionStateDir(root),
    desktopStateRequired: false,
    args: ["--model", "fixture/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "bash", OMP_DESKTOP_GATE_MODE: "ask" },
    prepareRun: (paths) => writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(resolved.projection)),
  });
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  assert.ok(runtime);
  const state = await runtime.request({ type: "get_state" });
  assert.equal(state.success, true);
  const nativeSessionId = state.data.sessionId;

  const envelopes = [];
  const ended = Promise.withResolvers();
  let whileWaiting;
  runner = new OmpSessionRunner({
    sessionId: "stream-start",
    runtime,
    nativeSessionIdentity: () => nativeSessionId,
    emit: (envelope) => envelopes.push(envelope),
    onUiRequest: (request) => {
      assert.equal(request.kind, "approval", "only the gated bash call asks");
      whileWaiting = liveRows(envelopes.map(({ event }) => event));
      runner.resolveUiRequest(request.frameId, "deny");
    },
    onTurnEnd: (info) => ended.resolve(info),
  });
  await runner.prompt("Tag the 2.0.0 release and push it.");
  const end = await ended.promise;
  assert.equal(end.reason, "completed");

  assert.ok(whileWaiting, "the bash call must wait for approval");
  assert.deepEqual(
    whileWaiting.map((row) => ({ content: row.content, thinking: row.thinking })),
    [{ content: PREAMBLE, thinking: "Tag first, then push." }],
    "the live row holds the reply text and thinking once while the approval waits",
  );
  const ends = envelopes
    .map(({ event }) => event)
    .filter((event) => event.type === "message_end" && event.message.role === "assistant");
  assert.equal(ends[0].message.content, PREAMBLE);
  assert.equal(ends.at(-1).message.content, "Nothing was pushed.");
});
