import assert from "node:assert/strict";
import test from "node:test";
import {
  modelListRequest,
  normalizeModelList,
} from "../electron/main/model-discovery.ts";

test("openai-style lists normalize, dedupe, and sort", () => {
  const models = normalizeModelList("chat_completions", {
    object: "list",
    data: [
      { id: "gpt-4.1", object: "model" },
      { id: "deepseek-chat" },
      { id: "gpt-4.1" },
      { object: "model" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "deepseek-chat", displayName: "deepseek-chat" },
    { modelId: "gpt-4.1", displayName: "gpt-4.1" },
  ]);
  // Bare-array gateways parse the same way.
  assert.equal(normalizeModelList("responses", [{ id: "o4-mini" }]).length, 1);
});

test("anthropic lists keep display names", () => {
  const models = normalizeModelList("anthropic_messages", {
    data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
  });
  assert.deepEqual(models, [
    { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  ]);
});

test("discovery retains published thinking levels and attachment modalities", () => {
  const [model] = normalizeModelList("responses", { data: [{
    id: "gateway/claude", reasoning: true,
    reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  }] });
  assert.equal(model.providerCapabilities.reasoning, true);
  assert.deepEqual(model.providerCapabilities.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(model.providerCapabilities.inputModalities, ["text", "image", "pdf"]);
});

test("explicit false and unknown thinking levels never become invented capabilities", () => {
  const models = normalizeModelList("responses", [{
    id: "future", reasoning_levels: ["none", "low", "ultra"], supports_pdf: true, supports_web_search: true,
    available_for_subagents: true,
  }, { id: "disabled", reasoning: false, reasoning_levels: ["high"], supports_images: false, supports_web_search: false }]);
  const future = models.find((model) => model.modelId === "future").providerCapabilities;
  assert.deepEqual(future.thinkingLevels, ["off", "low"]);
  assert.equal(future.thinkingLevelMap.off, "none");
  assert.deepEqual(future.unsupportedThinkingLevels, ["ultra"]);
  assert.equal(future.supportsDocuments, true);
  assert.equal(future.webSearch, true);
  assert.equal(future.availableForSubagents, undefined, "delegation is a local user choice");
  const disabled = models.find((model) => model.modelId === "disabled").providerCapabilities;
  assert.equal(disabled.reasoning, false);
  assert.deepEqual(disabled.thinkingLevels, []);
  assert.equal(disabled.supportsImages, false);
  assert.equal(disabled.webSearch, false);
});

for (const apiStyle of ["chat_completions", "responses", "anthropic_messages"]) {
  test(`${apiStyle} preserves provider context and output limits separately`, () => {
    const [model] = normalizeModelList(apiStyle, {
      data: [{
        id: "factory/claude-opus-5-5",
        context_window: 872_000,
        context_length: 872_000,
        max_input_tokens: 872_000,
        max_output_tokens: 128_000,
      }],
    });
    assert.equal(model.contextWindow, 872_000);
    assert.equal(model.maxTokens, 128_000);
  });
}

test("discovery accepts supported limit aliases and rejects invalid counts", () => {
  const models = normalizeModelList("responses", [{
    id: "context-length", context_length: 931_000, max_output_tokens: 64_000,
  }, {
    id: "input-only", max_input_tokens: 200_000,
  }, {
    id: "invalid", context_window: -1, context_length: "1000000",
    max_input_tokens: Number.POSITIVE_INFINITY, max_output_tokens: 1.5,
  }]);
  assert.equal(models.find((model) => model.modelId === "context-length").contextWindow, 931_000);
  assert.equal(models.find((model) => model.modelId === "input-only").contextWindow, 200_000);
  assert.deepEqual(models.find((model) => model.modelId === "invalid"), {
    modelId: "invalid", displayName: "invalid",
  });
});

test("Google discovery preserves input and output token limits", () => {
  const [model] = normalizeModelList("google_generative_ai", {
    models: [{ name: "models/gemini-fixture", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }],
  });
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.maxTokens, 65_536);
});

test("explicit context wins and output-only or overflowing limits cannot supply a window", () => {
  const models = normalizeModelList("responses", [{
    id: "precedence", context_window: 872_000, context_length: 931_000, max_input_tokens: 1_000_000,
  }, { id: "output-only", max_output_tokens: 128_000 }, {
    id: "overflow", context_window: 0x1_0000_0000, max_output_tokens: 0x1_0000_0000,
  }]);
  assert.equal(models.find((model) => model.modelId === "precedence").contextWindow, 872_000);
  assert.equal(models.find((model) => model.modelId === "output-only").contextWindow, undefined);
  assert.deepEqual(models.find((model) => model.modelId === "overflow"), { modelId: "overflow", displayName: "overflow" });
});

test("google lists strip the models/ prefix", () => {
  const models = normalizeModelList("google_generative_ai", {
    models: [
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { name: "models/gemini-2.5-flash" },
    ],
  });
  assert.deepEqual(models, [
    { modelId: "gemini-2.5-flash", displayName: "gemini-2.5-flash" },
    { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
  ]);
});

test("requests use per-style endpoints and auth headers", () => {
  const openai = modelListRequest({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
  });
  assert.equal(openai.url, "https://api.example.com/v1/models");
  assert.equal(openai.headers.Authorization, "Bearer sk-x");

  const anthropic = modelListRequest({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-a",
    apiStyle: "anthropic_messages",
  });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(anthropic.headers["x-api-key"], "sk-a");
  assert.ok(anthropic.headers["anthropic-version"]);
  // A base already ending in /v1 is not doubled.
  assert.match(
    modelListRequest({ baseUrl: "https://gw.example/v1", apiStyle: "anthropic_messages" }).url,
    /^https:\/\/gw\.example\/v1\/models/,
  );

  const google = modelListRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "g-key",
    apiStyle: "google_generative_ai",
  });
  assert.match(google.url, /\/v1beta\/models\?/);
  assert.match(google.url, /key=g-key/);
  assert.deepEqual(google.headers, {});
});

test("OpenCode Go uses its fixed OpenAI-compatible model endpoint", () => {
  const request = modelListRequest({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "go-key",
    apiStyle: "opencode_go",
  });
  assert.equal(request.url, "https://opencode.ai/zen/go/v1/models");
  assert.equal(request.headers.Authorization, "Bearer go-key");
});

test("optional custom headers are attached to discovery requests", () => {
  const request = modelListRequest({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
    headers: { "User-Agent": "Custom/1.0", "X-Gateway": "1" },
  });
  assert.equal(request.headers.Authorization, "Bearer sk-x");
  assert.equal(request.headers["User-Agent"], "Custom/1.0");
  assert.equal(request.headers["X-Gateway"], "1");
  const smashed = modelListRequest({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x",
    apiStyle: "chat_completions",
    headers: { Authorization: "Bearer other" },
  });
  assert.equal(smashed.headers.Authorization, "Bearer sk-x");
  const google = modelListRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiStyle: "google_generative_ai",
  });
  assert.equal(google.headers["User-Agent"], undefined);
});
