import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as shared from "@pi-desktop/shared";
import * as agentRuntime from "@pi-desktop/agent-runtime";
import * as discovery from "../electron/main/model-discovery.ts";
import * as catalogModule from "../electron/main/models-dev-catalog.ts";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");

const { outputText } = ts.transpileModule(readFileSync(new URL("../electron/main/ipc/provider-ipc.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const imports = {
  "@pi-desktop/shared": shared,
  "@pi-desktop/agent-runtime": agentRuntime,
  "../oauth": { OAUTH_AUTH_KIND: "oauth" },
  "../model-discovery": discovery,
  "../models-dev-catalog": catalogModule,
};
const ipcModule = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
  return imports[id];
}, ipcModule.exports, ipcModule);

// Exercise the real settings hook with React and the shared binding helpers.
// The pane's visual imports are unused by this hook-only render.
const selectionOutput = ts.transpileModule(readFileSync(new URL("../src/components/settings/ModelSelectionPanes.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const selectionModule = { exports: {} };
new Function("require", "exports", "module", selectionOutput)((id) => {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return jsxRuntime;
  if (id === "@pi-desktop/shared") return shared;
  return {};
}, selectionModule.exports, selectionModule);

function settingsSelection(models, bindings) {
  let selection;
  function Probe() {
    selection = selectionModule.exports.useModelSelection({ status: "ready", models, source: "remote" }, bindings, () => {});
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return selection;
}

async function harness(t, { binding, known = false, fields = {} } = {}) {
  const modelId = "factory/claude-fixture";
  const directory = mkdtempSync(join(tmpdir(), "omp-provider-limits-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ fixture: {
    name: "Fixture", api: "https://provider.invalid/v1", models: {
      [known ? modelId : "unrelated"]: {
        id: known ? modelId : "unrelated", modalities: { input: ["text"], output: ["text"] },
        limit: { context: 1_000_000, output: 64_000 },
      },
    },
  } }));
  const catalog = new catalogModule.ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.loadLocal(), true);
  const provider = {
    id: "provider-row", name: "Fixture", vendorKey: "fixture", baseUrl: "https://provider.invalid/v1",
    apiStyle: "chat_completions", models: binding ? [{ ...binding, id: modelId }] : [],
  };
  let cached = [];
  const host = { async call(method, input) {
    if (method === "providers.list") return { providers: [provider] };
    if (method === "providers.getSecret") return {};
    if (method === "providers.listModels") return { models: cached };
    if (method === "providers.cacheModels") {
      cached = input.models.map((model) => ({ ...structuredClone(model), source: "discovered" }));
      return { ok: true };
    }
    assert.fail(`unexpected host request: ${method}`);
  } };
  const runtime = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog: catalog });
  const handlers = new Map();
  ipcModule.exports.registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, modelsDevCatalog: catalog, vendorOAuth: {}, logger: { app() {} },
    ...runtime,
  });
  let requests = 0;
  let window = 872_000;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://provider.invalid/v1/models");
    requests++;
    return new Response(JSON.stringify({ data: [{ id: modelId, context_window: window, max_output_tokens: 128_000, ...fields }] }));
  });
  return {
    modelId, provider, runtime,
    requestCount: () => requests,
    setWindow: (value) => { window = value; },
    clearCache: () => { cached = []; },
    list: (source = "refresh") => handlers.get(shared.IPC.invoke.providersListModels)({ providerId: provider.id, source }),
  };
}

for (const known of [false, true]) {
  test(`provider limits survive discovery, selection, cache and runtime resolution (catalog match: ${known})`, async (t) => {
    const h = await harness(t, { known });
    const live = await h.list();
    assert.equal(live.source, "remote");
    assert.equal(live.models[0].contextWindow, 872_000);
    assert.equal(live.models[0].maxTokens, 128_000);
    assert.equal(live.models[0].limit.context, 872_000);
    h.provider.models = [JSON.parse(JSON.stringify(shared.bindingFromModelInfo(live.models[0])))];
    assert.equal(h.provider.models[0].contextWindowSource, "provider");
    const cached = await h.list("cache");
    assert.equal(h.requestCount(), 1, "cache hydration performs no provider request");
    assert.equal(cached.models[0].contextWindow, 872_000);
    assert.equal(cached.models[0].maxTokens, 128_000);
    const effective = h.runtime.effectiveSubagentModelConfig(h.provider, h.modelId, agentRuntime.genericModelConfig(h.modelId));
    assert.equal(effective.modelConfig.contextWindow, 872_000);
    assert.equal(effective.modelConfig.maxTokens, 128_000);
    assert.equal(h.runtime.enrichProvider(h.provider).models[0].contextWindow, 872_000);
    h.clearCache();
    const offline = (await h.list("cache")).models[0];
    assert.equal(shared.bindingFromModelInfo(offline).contextWindowSource, "provider");
    assert.equal(offline.contextWindow, 872_000);
    h.setWindow(931_000);
    const refreshed = (await h.list()).models[0];
    h.provider.models = [shared.bindingWithModelInfo(h.provider.models[0], refreshed)];
    assert.equal(h.provider.models[0].contextWindow, 931_000);
  });
}

test("refresh repairs the old inherited 128k seed and preserves a manual 128k override", async (t) => {
  const binding = { id: "fixture", contextWindow: 128_000, contextWindowSource: "catalog", maxTokens: 8_192, thinkingLevels: [], defaultThinkingLevel: null };
  const h = await harness(t, { binding });
  const refreshed = (await h.list()).models[0];
  const selection = settingsSelection([refreshed], h.provider.models);
  assert.equal(selection.models[0].contextWindow, 872_000, "the selected settings row shows the refreshed window");
  h.provider.models = selection.bindingsToPersist;
  assert.equal(h.provider.models[0].contextWindow, 872_000);
  assert.equal(h.provider.models[0].contextWindowSource, "provider");
  h.provider.models = [{ ...h.provider.models[0], contextWindow: 128_000, contextWindowSource: "user" }];
  const manual = (await h.list()).models[0];
  assert.equal(manual.contextWindow, 128_000);
  assert.equal(manual.contextWindowSource, "user");
  const manualSelection = settingsSelection([manual], h.provider.models);
  assert.equal(manualSelection.models[0].contextWindow, 128_000);
  assert.equal(manualSelection.bindingsToPersist[0].contextWindowSource, "user");
});

for (const known of [false, true]) {
  test(`thinking and attachments survive the settings/cache/runtime path (catalog match: ${known})`, async (t) => {
    const h = await harness(t, { known, fields: {
      reasoning: true, reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      modalities: { input: ["text", "image", "pdf"] }, supports_web_search: true,
    } });
    const live = (await h.list()).models[0];
    assert.deepEqual(live.supportedThinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(live.providerCapabilities.unsupportedThinkingLevels, ["ultra"]);
    assert.equal(shared.modelMatchesFilter(live, "vision"), true);
    assert.equal(shared.modelMatchesFilter(live, "pdf"), true);
    h.provider.models = [JSON.parse(JSON.stringify(shared.bindingFromModelInfo(live)))];
    const selected = settingsSelection([live], h.provider.models);
    h.provider.models = selected.bindingsToPersist;
    assert.deepEqual(h.provider.models[0].thinkingLevels, live.supportedThinkingLevels);
    assert.equal(h.provider.models[0].availableForSubagents, undefined);
    assert.equal(h.provider.models[0].nativeWebSearch, undefined, "published support does not opt into searches");
    const cached = (await h.list("cache")).models[0];
    assert.deepEqual(cached.supportedThinkingLevels, live.supportedThinkingLevels);
    assert.equal(h.requestCount(), 1);
    h.clearCache();
    const restored = (await h.list("cache")).models[0];
    assert.equal(shared.modelMatchesFilter(restored, "vision"), true);
    const effective = h.runtime.effectiveSubagentModelConfig(h.provider, h.modelId, agentRuntime.genericModelConfig(h.modelId));
    assert.equal(effective.modelConfig.reasoning, true);
    assert.ok(effective.modelConfig.input.includes("image"));
    assert.ok(effective.modelConfig.modalities.input.includes("pdf"));
    assert.equal(effective.modelConfig.thinkingLevelMap.max, "max");
    assert.equal(effective.modelConfig.webSearch, undefined);
    assert.equal(h.runtime.enrichProvider(h.provider).supportsVision, true);
    h.provider.models = [{ ...h.provider.models[0], thinkingLevels: [], thinkingLevelsSource: "user", supportsImages: false, supportsDocuments: false, availableForSubagents: true }];
    const manual = settingsSelection([(await h.list()).models[0]], h.provider.models).bindingsToPersist[0];
    assert.deepEqual(manual.thinkingLevels, []);
    assert.equal(manual.supportsImages, false);
    assert.equal(manual.supportsDocuments, false);
    assert.equal(manual.availableForSubagents, true);
    const userConfig = agentRuntime.modelConfigWithBinding(agentRuntime.genericModelConfig(h.modelId), manual);
    assert.equal(userConfig.reasoning, false);
    assert.equal(userConfig.input.includes("image"), false);
  });
}

test("refresh seeds an old empty reasoning default without changing local opt-ins", async (t) => {
  const h = await harness(t, { binding: {
    contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: [], defaultThinkingLevel: null,
    availableForSubagents: false, nativeWebSearch: true, supportsImages: null,
  }, fields: { reasoning: true, reasoning_levels: ["low", "high", "max"], modalities: { input: ["text", "image"] } } });
  const selected = settingsSelection((await h.list()).models, h.provider.models).bindingsToPersist[0];
  assert.deepEqual(selected.thinkingLevels, ["low", "high", "max"]);
  assert.equal(selected.thinkingLevelsSource, "provider");
  assert.equal(selected.availableForSubagents, false);
  assert.equal(selected.nativeWebSearch, true);
  assert.equal(selected.supportsImages, null);
});
