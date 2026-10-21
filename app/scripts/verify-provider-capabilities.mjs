/** Read-only native configuration probe. Never sends a prompt or inference request. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { register } from "node:module";
import { createHash } from "node:crypto";
import { bindingFromModelInfo, OMP_RUNTIME_VERSION } from "../packages/shared/dist/index.js";
import { OmpRuntimeSupervisor } from "../packages/omp-runtime/dist/index.js";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { normalizeModelList } = await import("../apps/desktop/electron/main/model-discovery.ts");
const { resolveProviderProjection, projectModelsYaml } = await import("../apps/desktop/electron/main/runtime/omp-model-projection.ts");
const launcherPath = process.argv[2] ? resolve(process.argv[2]) : null;
assert.ok(launcherPath, "Pass the native OMP executable to inspect");
const provenance = JSON.parse(readFileSync(join(dirname(launcherPath), "provenance.json"), "utf8"));
const [discovered] = normalizeModelList("chat_completions", { data: [{
  id: "gateway/capability-fixture", context_window: 872_000, max_output_tokens: 128_000,
  reasoning: true, reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
  modalities: { input: ["text", "image"] },
}] });
const binding = bindingFromModelInfo({
  ...discovered, providerId: "capability-fixture", source: "discovered", capabilities: ["text", "vision", "reasoning"],
  reasoning: true, supportedThinkingLevels: discovered.providerCapabilities.thinkingLevels,
});
const resolved = resolveProviderProjection({
  id: "capability-fixture", authKind: "none", apiStyle: "chat_completions",
  baseUrl: "http://127.0.0.1:1/v1", models: [binding],
}, binding.id, "low");
assert.equal(resolved.ok, true);
const root = mkdtempSync(join(tmpdir(), "omp-provider-capabilities-"));
const supervisor = new OmpRuntimeSupervisor({
  dataRoot: root, launcherPath, expectedRuntimeVersion: OMP_RUNTIME_VERSION,
  desktopStateRequired: false, readyTimeoutMs: 30_000, requestTimeoutMs: 15_000,
  args: ["--provider", "capability-fixture", "--model", binding.id],
  prepareRun: (paths) => writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(resolved.projection)),
});
let result;
try {
  const status = await supervisor.start();
  assert.equal(status.phase, "idle");
  const runtime = supervisor.currentRuntime();
  assert.ok(runtime);
  const response = await runtime.request({ type: "get_available_models" });
  assert.equal(response.success, true);
  const model = response.data.models.find((model) => model.provider === "capability-fixture" && model.id === binding.id);
  assert.ok(model, "The native catalog must expose the projected fixture model");
  assert.equal(model.reasoning, true);
  assert.ok(model.input.includes("image"));
  assert.equal(model.contextWindow, 872_000);
  assert.equal(model.maxTokens, 128_000);
  assert.deepEqual(model.thinking.efforts, ["low", "medium", "high", "xhigh", "max"]);
  const changed = await runtime.request({ type: "set_thinking_level", level: "low" });
  assert.equal(changed.success, true);
  const state = await runtime.request({ type: "get_state" });
  assert.equal(state.success, true);
  assert.equal(state.data.thinkingLevel, "low");
  result = { runtimeVersion: status.runtimeVersion, patchLevel: provenance.patchLevel,
    runtimeSha256: createHash("sha256").update(readFileSync(launcherPath)).digest("hex"),
    model: { id: model.id, reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, thinking: model.thinking }, thinkingLevel: state.data.thinkingLevel,
    inferenceRequests: 0 };
} finally {
  const reclaimed = await supervisor.reclaimAll();
  assert.ok(reclaimed.every((item) => item.stopped && item.reaped && item.cleaned), `Fixture cleanup failed; retained ${root}`);
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...result, cleanup: "reaped-and-cleaned" }, null, 2));
