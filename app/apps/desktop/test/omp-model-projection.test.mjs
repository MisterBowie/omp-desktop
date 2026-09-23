import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { register } from "node:module";

/**
 * Model projection (M4/T15): the desktop's provider/model binding projects into
 * a minimal models.yml, and an incompatible API style or a missing field fails
 * closed before a prompt is sent. The synthetic key is a canary that must never
 * appear in any other surface; here it only ever lives inside the rendered YAML.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const {
  ompApiForStyle,
  projectionError,
  projectModelsYaml,
  resolveProviderProjection,
} = await import("../electron/main/runtime/omp-model-projection.ts");

const CANARY = "omp-m4-canary-not-a-real-key";

test("maps the supported PI api styles to OMP api values", () => {
  assert.equal(ompApiForStyle("chat_completions"), "openai-completions");
  assert.equal(ompApiForStyle("openai-chat"), "openai-completions");
  assert.equal(ompApiForStyle("responses"), "openai-responses");
  assert.equal(ompApiForStyle("anthropic_messages"), "anthropic-messages");
  assert.equal(ompApiForStyle("google_generative_ai"), "google-generative-ai");
});

test("refuses unsupported and absent api styles", () => {
  assert.equal(ompApiForStyle("opencode_go"), null);
  assert.equal(ompApiForStyle("opencode"), null);
  assert.equal(ompApiForStyle(undefined), null);
  assert.equal(ompApiForStyle(""), null);
});

test("projects exactly one provider and one model, auth: none carries no key", () => {
  const yaml = projectModelsYaml({
    providerId: "local",
    modelId: "local-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: null,
  });
  assert.match(yaml, /providers:/);
  assert.match(yaml, /"local":/);
  assert.match(yaml, /api: "openai-completions"/);
  assert.match(yaml, /auth: "none"/);
  assert.match(yaml, /id: "local-model"/);
  // A second provider/model must never be copied into the projection.
  assert.equal((yaml.match(/- id:/g) ?? []).length, 1);
  assert.doesNotMatch(yaml, /anthropic/);
});

test("projects an apiKey binding with the credential and never elsewhere", () => {
  const yaml = projectModelsYaml({
    providerId: "acme",
    modelId: "acme-x",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    apiKey: CANARY,
    contextWindow: 128000,
  });
  assert.match(yaml, /auth: "apiKey"/);
  assert.ok(yaml.includes(CANARY), "the credential lands in the projected models.yml");
  assert.match(yaml, /contextWindow: 128000/);
});

test("fails closed on an empty or incompatible projection", () => {
  assert.equal(
    projectionError({ providerId: "", modelId: "m", api: "openai-completions", baseUrl: "http://x" })?.errorCode,
    "OMP_PROJECTION_INVALID",
  );
  assert.equal(
    projectionError({ providerId: "p", modelId: "m", api: "", baseUrl: "http://x" })?.errorCode,
    "OMP_PROJECTION_UNSUPPORTED",
  );
  assert.throws(
    () => projectModelsYaml({ providerId: "p", modelId: "m", api: "", baseUrl: "http://x", apiKey: null }),
    (error) => error.errorCode === "OMP_PROJECTION_UNSUPPORTED",
  );
});

const source = (overrides = {}) => ({
  id: "acme",
  enabled: true,
  type: "openai_compatible",
  apiStyle: "chat_completions",
  authKind: "api_key",
  hasSecret: true,
  baseUrl: "https://api.example.com/v1",
  models: [{ id: "acme-x", contextWindow: 128000, maxTokens: 16384, thinkingLevels: ["off", "high"] }],
  ...overrides,
});

test("R4: resolves a valid provider/model binding", () => {
  const result = resolveProviderProjection(source(), "acme-x", "high");
  assert.equal(result.ok, true);
  assert.equal(result.projection.providerId, "acme");
  assert.equal(result.projection.api, "openai-completions");
});

test("R4: refuses a disabled provider", () => {
  const result = resolveProviderProjection(source({ enabled: false }), "acme-x", null);
  assert.equal(result.ok, false);
  assert.equal(result.error.errorCode, "OMP_PROJECTION_INVALID");
});

test("R4: refuses a model not in the provider's configured models", () => {
  const result = resolveProviderProjection(source(), "acme-y", null);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /not one of/);
});

test("R4: refuses a key-auth provider without a stored secret", () => {
  const result = resolveProviderProjection(source({ hasSecret: false }), "acme-x", null);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /requires an API key/);
});

test("R4: refuses OAuth and basic auth instead of downgrading to auth:none", () => {
  for (const authKind of ["oauth", "basic"]) {
    const result = resolveProviderProjection(source({ authKind }), "acme-x", null);
    assert.equal(result.ok, false);
    assert.equal(result.error.errorCode, "OMP_PROJECTION_UNSUPPORTED");
  }
});

test("R4: refuses an incompatible thinking level", () => {
  const result = resolveProviderProjection(source(), "acme-x", "max");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /not supported/);
});

test("R4: projects provider headers into the yaml", () => {
  const result = resolveProviderProjection(source({ headers: { "X-Custom": "v1" } }), "acme-x", null);
  assert.equal(result.ok, true);
  const yaml = projectModelsYaml({ ...result.projection, apiKey: "k" });
  assert.match(yaml, /X-Custom/);
});

test("F5: rejects unknown and empty authKind instead of downgrading to auth:none", () => {
  for (const authKind of ["", "sso", "bearer-token"]) {
    const result = resolveProviderProjection(source({ authKind }), "acme-x", null);
    assert.equal(result.ok, false);
    assert.equal(result.error.errorCode, "OMP_PROJECTION_UNSUPPORTED");
  }
});

test("F5: a key-auth provider with no key fails closed via needsKey", () => {
  const result = resolveProviderProjection(source({ hasSecret: false }), "acme-x", null);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /requires an API key/);
});

test("F5: quotes a provider id containing a colon", () => {
  const result = resolveProviderProjection(source({ id: "plugin:acme" }), "acme-x", null);
  assert.equal(result.ok, true);
  const yaml = projectModelsYaml({ ...result.projection, apiKey: "k" });
  assert.match(yaml, /"plugin:acme":/);
});
