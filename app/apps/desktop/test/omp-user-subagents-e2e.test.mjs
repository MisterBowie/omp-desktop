import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { OmpRuntimeSupervisor, findGateExtension, verifyBundledRuntime } = await import("../../../packages/omp-runtime/src/index.ts");
const { wireOmpSessions } = await import("../electron/main/runtime/omp-session-wiring.ts");

async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "native fixture did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("settings user agent reaches native task with its own provider, prompt and tool grant", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 60_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-user-agents-")));
  const parent = await FakeProvider.start();
  const child = await FakeProvider.start({ model: "child-model" });
  const document = join(root, "code-implement.md");
  const marker = join(root, "child-marker.txt");
  const forbidden = join(root, "undeclared-shell-marker");
  writeFileSync(document, `---\nname: code-implement\ndescription: Implement the fixture\ntools: [Read, Write]\nmodel: fixture-child/child-model\n---\nUSER_AGENT_PROMPT_CANARY\n`);
  const nativeRef = {};
  const envelopes = [];
  const supervisors = [];
  const sources = [
    { id: "parent-id", name: "Parent", vendorKey: "fixture-parent", baseUrl: parent.baseUrl,
      enabled: true, apiStyle: "chat_completions", authKind: "none", models: [{ id: "local-model" }] },
    { id: "child-id", name: "Child", vendorKey: "fixture-child", baseUrl: child.baseUrl,
      enabled: true, apiStyle: "chat_completions", authKind: "none", models: [{ id: "child-model" }] },
  ];
  let enabled = true;
  const host = {
    isAvailable: () => true,
    async call(method, args) {
      if (method === "agents.active") return { subagents: enabled ? [{ id: "code-implement", path: document }] : [] };
      if (method === "providers.list") return { providers: sources };
      if (method === "providers.get") return { provider: sources.find(row => row.id === args.id) };
      if (method === "session.get") return { session: { mode: "agent", permissionMode: "auto" } };
      if (method === "session.executionRoot") return { path: root };
      if (method === "session.beginTurn") return { turnId: `host-${envelopes.length}` };
      if (method === "session.bindEngine") { Object.assign(nativeRef, args); return {}; }
      if (method === "session.endTurn") return {};
      if (method === "settings.get") return {};
      if (method === "memory.settings.get") return { autoSave: false, autoRead: false };
      throw new Error(`Unexpected host method: ${method}`);
    },
  };
  const gate = findGateExtension(here);
  const { bridge } = wireOmpSessions({
    dataRoot: root, host: () => host, isPackaged: false, appPath: here,
    emitAgentEvent: event => envelopes.push(event),
    engineRuntime: { gateExtension: gate, ompRuntime: {
      launcher: resources.path,
      createSupervisor(options) {
        const supervisor = new OmpRuntimeSupervisor({ ...options, dataRoot: root,
          launcherPath: resources.path, expectedRuntimeVersion: "18.3.0",
          args: ["--model", options.modelSelector, "--trusted-extension", gate],
          extraEnv: { PI_NO_TITLE: "1" },
        });
        supervisors.push(supervisor);
        return supervisor;
      },
    } },
  });
  t.after(async () => {
    const disposed = await bridge.dispose();
    await Promise.all([parent.close(), child.close()]);
    rmSync(root, { recursive: true, force: true });
    assert.equal(disposed.ok, true);
  });
  parent.script([
    { toolCalls: [{ id: "delegate-configured-agent", name: "task", args: {
      context: "Native settings integration", tasks: [{ agent: "code-implement", name: "ConfiguredWorker", task: "Write the fixture marker" }],
    } }] },
    { text: "The task was submitted.", finish: "stop" },
  ]);
  child.script([
    { toolCalls: [{ id: "child-undeclared-shell", name: "bash", args: { command: `touch '${forbidden}'` } }] },
    { toolCalls: [{ id: "child-write", name: "write", args: { path: marker, content: "configured child\n" } }] },
    { toolCalls: [{ id: "child-yield", name: "yield", args: { data: { report: "The marker is written." } } }] },
  ]);
  const spec = { sessionId: "configured-user-agent", projectPath: root,
    providerId: "parent-id", modelId: "local-model", content: "Use code-implement" };
  assert.equal((await bridge.prompt(spec)).accepted, true);
  await until(() => child.requests.length > 0 || parent.requests.some(request =>
    JSON.stringify(request.body).includes("Unknown agent")));
  assert.ok(child.requests.length > 0, "the configured native agent must call its pinned provider");
  const request = child.requests[0].body;
  assert.equal(request.model, "child-model");
  assert.match(JSON.stringify(request.messages), /USER_AGENT_PROMPT_CANARY/);
  const tools = request.tools.map(tool => tool.function.name);
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("write"));
  assert.ok(!tools.includes("bash"), "undeclared shell access must remain unavailable");
  assert.ok(!tools.includes("task"), "user agents must not gain nested delegation");
  await until(() => existsSync(marker));
  assert.equal(readFileSync(marker, "utf8"), "configured child\n");
  await until(() => !bridge.isBusy(spec.sessionId));
  assert.equal(existsSync(forbidden), false, "an undeclared tool cannot acquire a shell through native dispatch");
  assert.ok(child.requests.length >= 2);
  const nativeId = nativeRef.nativeSessionId;
  const firstRuntime = supervisors[0].currentRuntime();
  const firstRoot = supervisors[0].runRoot();
  writeFileSync(document, `---\nname: code-implement\ndescription: Implement the fixture\ntools: [inherit, Read, Write]\nmodel: fixture-child/child-model\n---\nUPDATED_AGENT_PROMPT_CANARY\n`);
  const childBefore = child.requests.length;
  child.script([{ toolCalls: [{ id: "edited-yield", name: "yield", args: { data: { report: "Updated agent ran." } } }] }]);
  parent.script([
    { toolCalls: [{ id: "delegate-edited-agent", name: "task", args: {
      context: "Updated settings", tasks: [{ agent: "code-implement", name: "UpdatedWorker", task: "Report updated settings" }],
    } }] },
    { text: "Updated task submitted.", finish: "stop" },
  ]);
  assert.equal((await bridge.prompt({ ...spec, content: "Use the edited code-implement" })).accepted, true);
  await until(() => child.requests.length > childBefore);
  const edited = child.requests[childBefore].body;
  assert.match(JSON.stringify(edited.messages), /UPDATED_AGENT_PROMPT_CANARY/);
  assert.ok(edited.tools.some(tool => tool.function.name === "bash"), "explicit inheritance exposes the native parent's shell");
  assert.ok(!edited.tools.some(tool => tool.function.name === "task"));
  await until(() => !bridge.isBusy(spec.sessionId));
  assert.equal(nativeRef.nativeSessionId, nativeId);
  assert.notEqual(supervisors[0].currentRuntime(), firstRuntime);
  assert.equal(existsSync(firstRoot), false);
  const editedRuntime = supervisors[0].currentRuntime();
  const editedRoot = supervisors[0].runRoot();
  enabled = false;
  const before = parent.requests.length;
  parent.script([{ text: "Configuration refreshed.", finish: "stop" }]);
  assert.equal((await bridge.prompt({ ...spec, content: "Read the refreshed catalog" })).accepted, true);
  await until(() => parent.requests.length > before);
  const task = parent.requests.at(-1).body.tools.find(tool => tool.function.name === "task");
  assert.doesNotMatch(task.function.description, /code-implement/, "disabled agents leave the next prompt's native catalog");
  assert.equal(nativeRef.nativeSessionId, nativeId, "configuration refresh retains native session identity");
  assert.notEqual(supervisors[0].currentRuntime(), editedRuntime, "a live idle runtime reloads its launch-owned catalog");
  assert.equal(existsSync(editedRoot), false, "the replaced runtime's configuration and secrets are reclaimed");
});
