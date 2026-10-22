import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { loadOmpUserSubagents, ompSubagentModels, writeOmpUserSubagents } = await import("../electron/main/runtime/omp-user-subagents.ts");
const { projectModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");

async function fixture(t, front = "tools: [inherit, Read, Write]\nmodel: deepseek/deepseek-flash") {
  const root = await mkdtemp(join(tmpdir(), "omp-agent-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "code-implement.md");
  const document = `---\nname: code-implement\ndescription: Implement code\n${front}\n---\nThe definition body.\n`;
  await writeFile(path, document);
  const calls = [];
  const provider = { id: "uuid-provider", name: "DeepSeek", vendorKey: "deepseek", enabled: true,
    apiStyle: "chat_completions", authKind: "api_key", hasSecret: true,
    baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-flash", maxTokens: 16000 }] };
  let records = [{ id: "code-implement", path }];
  let providers = [provider];
  const host = { async call(method, args) {
    calls.push({ method, args });
    if (method === "agents.active") return { subagents: records };
    if (method === "providers.list") return { providers };
    if (method === "providers.getSecret") return { value: "SYNTHETIC_KEY_CANARY" };
    throw new Error(`unexpected host method: ${method}`);
  } };
  const spec = { sessionId: "owner", projectDirectory: root, providerId: provider.id, modelId: "deepseek-flash" };
  return { root, host, provider, spec, path, document, calls,
    setRecords: value => { records = value; }, setProviders: value => { providers = value; } };
}

test("active user definition maps names, model aliases and tools without reading secrets", async t => {
  const f = await fixture(t);
  const snapshot = await loadOmpUserSubagents(f.host, f.spec, ["mcp_fixture_read", "Task", "EnterPlanMode", "ask"]);
  assert.equal(snapshot.agents.length, 1);
  assert.deepEqual(snapshot.diagnostics, []);
  const agent = snapshot.agents[0];
  assert.equal(agent.bindings[0].sourceId, "uuid-provider");
  assert.equal(agent.bindings[0].projection.modelId, "deepseek-flash");
  assert.ok(agent.tools.includes("mcp_fixture_read"));
  assert.ok(agent.tools.includes("write"));
  assert.ok(!agent.tools.some(name => ["task", "enterplanmode", "ask"].includes(name.toLowerCase())));
  assert.deepEqual(f.calls[0], { method: "agents.active", args: { projectPath: f.root } });
  assert.ok(!f.calls.some(call => call.method === "providers.getSecret"));
  assert.doesNotMatch(JSON.stringify(snapshot), /SYNTHETIC_KEY_CANARY/);
  const models = await ompSubagentModels(f.host, snapshot);
  const yaml = parseYaml(projectModelsYaml({ ...models[0], providerId: "parent-id" }, models));
  assert.equal(yaml.providers[models[0].providerId].apiKey, "SYNTHETIC_KEY_CANARY");
  assert.equal(yaml.providers[models[0].providerId].models[0].id, "deepseek-flash");
  await writeOmpUserSubagents(join(f.root, "isolated-agent"), snapshot);
  const projected = await readFile(join(f.root, "isolated-agent/agents/code-implement.md"), "utf8");
  assert.match(projected, /The definition body\./);
  assert.doesNotMatch(projected, /SYNTHETIC_KEY_CANARY|spawns:/);
  assert.equal(await readFile(f.path, "utf8"), f.document);
});

test("omitted tool grant stays read-only and an unpinned model follows the bound parent", async t => {
  const f = await fixture(t, "");
  const snapshot = await loadOmpUserSubagents(f.host, f.spec, ["mcp_read"]);
  assert.deepEqual(snapshot.agents[0].tools, ["read", "glob", "grep"]);
  assert.equal(snapshot.agents[0].bindings[0].sourceId, f.spec.providerId);
});

test("activation and file edits refresh the fingerprint; disabled definitions are absent", async t => {
  const f = await fixture(t);
  const first = await loadOmpUserSubagents(f.host, f.spec);
  assert.equal((await loadOmpUserSubagents(f.host, f.spec)).fingerprint, first.fingerprint);
  f.setProviders([f.provider, { ...f.provider, id: "unrelated-id", name: "Other", vendorKey: "unrelated", baseUrl: "https://unrelated.invalid" }]);
  assert.equal((await loadOmpUserSubagents(f.host, f.spec)).fingerprint, first.fingerprint, "unrelated providers must not rebuild a session");
  await writeFile(f.path, f.document.replace("The definition body.", "Changed prompt."));
  assert.notEqual((await loadOmpUserSubagents(f.host, f.spec)).fingerprint, first.fingerprint);
  f.setRecords([]);
  const disabled = await loadOmpUserSubagents(f.host, f.spec);
  assert.deepEqual(disabled.agents, []);
  assert.notEqual(disabled.fingerprint, first.fingerprint);
});

test("invalid, missing and non-inherited policy definitions cannot acquire the parent model", async t => {
  const f = await fixture(t);
  f.setProviders([]);
  const missing = await loadOmpUserSubagents(f.host, f.spec);
  assert.deepEqual(missing.agents, []);
  assert.match(missing.diagnostics[0], /missing or ambiguous/);
  f.setProviders([f.provider]);
  f.provider.enabled = false;
  assert.deepEqual((await loadOmpUserSubagents(f.host, f.spec)).agents, []);
  f.provider.enabled = true;
  await writeFile(f.path, f.document.replace("tools: [inherit, Read, Write]", "permission: auto\ntools: [Read]"));
  const unsupported = await loadOmpUserSubagents(f.host, f.spec);
  assert.deepEqual(unsupported.agents, []);
  assert.match(unsupported.diagnostics[0], /inherited permissions/);
  await writeFile(f.path, "invalid document");
  assert.deepEqual((await loadOmpUserSubagents(f.host, f.spec)).agents, []);
  assert.ok(!f.calls.some(call => call.method === "providers.getSecret"));
});

test("definition-scoped fallback models and token caps produce distinct model aliases", async t => {
  const f = await fixture(t, "model: deepseek/deepseek-flash\nfallbackModels: [deepseek/backup]\nmaxTokens: 1000");
  f.provider.models.push({ id: "backup", maxTokens: 500 });
  const snapshot = await loadOmpUserSubagents(f.host, f.spec);
  const models = await ompSubagentModels(f.host, snapshot);
  assert.deepEqual(models.map(model => model.modelId), ["deepseek-flash", "backup"]);
  assert.deepEqual(models.map(model => model.maxTokens), [1000, 500]);
  assert.notEqual(models[0].providerId, models[1].providerId);
  assert.equal(f.calls.filter(call => call.method === "providers.getSecret").length, 1);
  assert.throws(() => projectModelsYaml(models[0], [models[0]]), /duplicate/);
});

test("an empty stored key refuses projection instead of downgrading authentication", async t => {
  const f = await fixture(t);
  const snapshot = await loadOmpUserSubagents(f.host, f.spec);
  const host = { call: async () => ({ value: "" }) };
  await assert.rejects(ompSubagentModels(host, snapshot), error => error.errorCode === "OMP_PROJECTION_INVALID");
});

test("a native project name collision cannot silently replace the settings model, prompt or tools", async t => {
  const f = await fixture(t);
  const projectAgents = join(f.root, ".omp/agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "shadow.md"), "---\nname: code-implement\ndescription: Project override\ntools: [bash]\n---\nDifferent instructions\n");
  await assert.rejects(loadOmpUserSubagents(f.host, f.spec), error => error.errorCode === "OMP_SUBAGENT_CONFLICT");
  assert.equal(await readFile(f.path, "utf8"), f.document);
  assert.ok(!f.calls.some(call => call.method === "providers.getSecret"));
});
