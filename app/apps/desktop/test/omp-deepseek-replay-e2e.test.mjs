import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { convertMessages as piMessages } from "@earendil-works/pi-ai/api/openai-completions";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } =
  await import("../../../packages/omp-runtime/src/index.ts");
const { resolveProviderProjection, projectModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");

test("native DeepSeek tool replay preserves empty content like Pi without inventing a dot", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 60_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-deepseek-replay-")));
  let provider;
  let supervisor;
  t.after(async () => {
    const stopped = await supervisor?.stop({ abortBash: false });
    await provider?.close();
    rmSync(root, { recursive: true, force: true });
    if (stopped) {
      assert.equal(stopped.reaped, true);
      assert.equal(stopped.cleaned, true);
    }
  });
  provider = await FakeProvider.start({ model: "deepseek-flash" });
  const marker = join(root, "marker.txt");
  writeFileSync(marker, "unchanged\n");
  provider.script([
    { thinking: "Read the fixture first.", toolCalls: [{ id: "empty-text", name: "read", args: { path: marker } }] },
    { text: ".", thinking: "Read it a second time.", toolCalls: [{ id: "real-dot", name: "read", args: { path: marker } }] },
    { text: "Done.", finish: "stop" },
  ]);
  // OMP's own endpoint detector recognizes upstream URLs embedded in a proxy
  // path. Exercise the direct DeepSeek policy while every byte stays local.
  const baseUrl = `${provider.baseUrl}/api.deepseek.com`;
  const resolved = resolveProviderProjection({
    id: "fixture", apiStyle: "chat_completions", authKind: "none", baseUrl,
    models: [{ id: "deepseek-flash", providerCapabilities: { reasoning: true } }],
  }, "deepseek-flash", null);
  assert.equal(resolved.ok, true);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, cwd: root, launcherPath: resources.path, sessionDir: ensureSessionStateDir(root),
    desktopStateRequired: false,
    args: ["--model", "fixture/deepseek-flash", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: (paths) => writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(resolved.projection)),
  });
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  assert.ok(runtime);
  const messages = [];
  const ended = Promise.withResolvers();
  const detach = runtime.onFrame((frame) => {
    if (frame.type === "message_end" && frame.message.role === "assistant") messages.push(frame.message);
    if (frame.type === "agent_end" && frame.isTerminal !== false) ended.resolve();
  });
  t.after(detach);
  assert.equal((await runtime.request({ type: "prompt", message: "Read the fixture twice." })).success, true);
  await ended.promise;
  const requests = provider.requests.filter((request) => request.url.endsWith("/chat/completions"));
  assert.equal(requests.length, 3);
  assert.equal(messages[0].content.some((part) => part.type === "text" && part.text), false);
  const pi = piMessages({ ...resolved.projection, id: "deepseek-flash", provider: "fixture", input: ["text"] },
    { messages: [messages[0]] }, { supportsMidConvoSystemMessages: true, requiresReasoningContentOnAssistantMessages: true });
  const piAssistant = pi.find((message) => message.role === "assistant");
  assert.equal(piAssistant.content ?? "", "", "Pi does not fabricate content for a reasoning/tool-only reply");
  const empty = requests[1].body.messages.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "empty-text");
  assert.equal(empty.content ?? "", "", "OMP must not teach the model a synthetic dot as assistant prose");
  assert.equal(empty.reasoning_content, "Read the fixture first.");
  const genuine = requests[2].body.messages.find((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "real-dot");
  assert.equal(genuine.content, ".", "real provider text remains verbatim");
  assert.equal(genuine.reasoning_content, "Read it a second time.");
  assert.equal(readFileSync(marker, "utf8"), "unchanged\n");
});
