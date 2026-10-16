/**
 * Real coding path: Desktop runner -> shipped OMP -> real TypeScript LSP.
 * Only the external model is scripted. No remote model or user profile is used.
 * Set OMP_BUNDLED_RESOURCES and OMP_LSP_TYPESCRIPT_SERVER to run this lane.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { OmpRuntimeSupervisor, verifyBundledRuntime } = await import("../../../packages/omp-runtime/src/index.ts");
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
const { DESKTOP_STATE_FILE, serializeDesktopCapabilityState, writeDesktopCapabilityState } = await import("../../../packages/omp-runtime/src/desktop-state.ts");
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { composeModeSystemPrompt } = await import("../../../packages/agent-runtime/src/mode-prompts.ts");

const resources = process.env.OMP_BUNDLED_RESOURCES;
const server = process.env.OMP_LSP_TYPESCRIPT_SERVER;
const enabled = Boolean(resources && server);

test("native coding returns real LSP diagnostics after write and default hashline edit, then navigates", {
  skip: !enabled && "requires a verified packaged runtime and real typescript-language-server",
  timeout: 180_000,
}, async (t) => {
  assert.ok(existsSync(server), "the real TypeScript language server must exist");
  const verified = verifyBundledRuntime({ resourcesPath: resources });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-lsp-coding 中文 '-")));
  const project = join(root, "project");
  const dataRoot = join(root, "data");
  mkdirSync(join(project, ".omp"), { recursive: true });
  writeFileSync(join(project, "package.json"), '{"private":true}\n');
  writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true}}\n');
  writeFileSync(join(project, "existing.ts"), "export const editedValue: number = 42;\n");
  writeFileSync(join(project, "usage.ts"), 'import { editedValue } from "./existing";\nconsole.log(editedValue);\n');
  // Explicit interpreter: the product intentionally does not inherit shell PATH.
  // This exercises the supported native project configuration without changing it.
  writeFileSync(join(project, ".omp/lsp.json"), JSON.stringify({ servers: {
    "typescript-language-server": {
      command: process.execPath,
      args: [server, "--stdio"],
      rootMarkers: ["tsconfig.json"],
    },
  } }));
  const provider = await FakeProvider.start();
  const frames = [];
  const envelopes = [];
  const approvals = [];
  let runRoot;
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot,
    launcherPath: verified.path,
    expectedRuntimeVersion: "18.3.0",
    args: ["--model", "m1fake/local-model", "--trusted-extension", join(here, "../../../packages/omp-runtime/extensions/omp-desktop-gate.ts")],
    prepareRun: (paths) => {
      runRoot = paths.runRoot;
      writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl });
    },
    readyTimeoutMs: 60_000,
  });
  supervisor.setWorkingDirectory(project);
  let runner;
  const evidence = { runtime: verified.path, project, checks: [] };
  t.after(async () => {
    runner?.dispose("LSP coding test finished");
    const cleanup = await supervisor.stop();
    await provider.close();
    evidence.cleanup = cleanup;
    if (process.env.OMP_LSP_EVIDENCE) {
      writeFileSync(process.env.OMP_LSP_EVIDENCE, JSON.stringify({ ...evidence, approvals, frames, envelopes, modelRequests: provider.requests }, null, 2));
    }
    rmSync(root, { recursive: true, force: true });
    assert.equal(cleanup.reaped, true, "all runtime-owned language-server descendants must stop");
    assert.equal(cleanup.cleaned, true, "the isolated HOME/config root must be removed");
  });
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  assert.ok(runtime, "the shipped native runtime must start");
  runtime.onFrame((frame) => frames.push(frame));
  const state = await runtime.request({ type: "get_state" });
  assert.equal(state.success, true);
  const nativeSessionId = state.data.sessionId;
  assert.equal(typeof nativeSessionId, "string");
  let terminal;
  runner = new OmpSessionRunner({
    sessionId: "lsp-coding",
    runtime,
    nativeSessionIdentity: () => nativeSessionId,
    emit: (envelope) => envelopes.push(envelope),
    onUiRequest: (request) => {
      assert.equal(request.kind, "approval", "the test answers only classified tool approvals");
      approvals.push({ source: request.source, toolName: request.descriptor?.toolName });
      runner.resolveUiRequest(request.frameId, "allow-once");
    },
    onTurnEnd: (info) => terminal?.(info),
  });
  async function turn(message, toolCalls) {
    writeDesktopCapabilityState(join(runRoot, DESKTOP_STATE_FILE), serializeDesktopCapabilityState({
      sessionId: nativeSessionId, mode: "agent", modeBlock: composeModeSystemPrompt("agent", ""), permissionMode: "ask", skills: [], hostTools: [],
    }, Date.now()));
    provider.script([{ toolCalls, finish: "tool_calls" }, { text: "LSP coding step complete.", finish: "stop" }]);
    const start = frames.length;
    const end = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`native turn timed out: ${message}`)), 60_000);
      terminal = (info) => { clearTimeout(timeout); resolve(info); };
    });
    await runner.prompt(message, { admission: {
      v: 1, nativeSessionId, mode: "agent", permissionMode: "ask", hostTools: [], grants: [],
    } });
    assert.equal((await end).reason, "completed");
    const results = frames.slice(start).filter((frame) => frame.type === "tool_execution_end");
    assert.equal(results.length, toolCalls.length);
    for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result));
    return results;
  }
  const textOf = (result) => (result?.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const diagnostic = (result) => JSON.stringify(result?.result);

  const [written] = await turn("Write a TypeScript file and check it", [{ name: "write", args: {
    path: "written.ts", content: 'export const writtenValue: number = "wrong";\n',
  } }]);
  assert.match(diagnostic(written), /2322/);
  assert.match(diagnostic(written), /not assignable to type/);
  evidence.checks.push("write returns real TypeScript 2322");

  const [read] = await turn("Read the existing code before editing", [{ name: "read", args: { path: "existing.ts" } }]);
  const header = textOf(read).match(/\[([^\]\n]*existing\.ts#[0-9a-fA-F]{4})\]/);
  assert.ok(header, `the default hashline read must supply a snapshot: ${textOf(read)}`);
  const [edited] = await turn("Edit the existing code and check it", [{ name: "edit", args: {
    input: `*** Begin Patch\n[${header[1]}]\nPUT 1.=1:\n+export const editedValue: number = "wrong";\n*** End Patch`,
  } }]);
  assert.match(readFileSync(join(project, "existing.ts"), "utf8"), /"wrong"/);
  assert.match(diagnostic(edited), /2322/, "editing existing code must return the real compiler diagnostic automatically");
  evidence.checks.push("default hashline edit returns real TypeScript 2322");

  const [descriptor] = await turn("Discover semantic navigation", [{ name: "read", args: { path: "xd://lsp" } }]);
  assert.match(textOf(descriptor), /definition/);
  const [definition] = await turn("Resolve the imported symbol using LSP", [{ name: "lsp", args: {
    action: "definition", file: "usage.ts", line: 2, symbol: "editedValue",
  } }]);
  assert.match(textOf(definition), /existing\.ts/);
  evidence.checks.push("deferred lsp discovery and cross-file definition execute against the real server");
  const modelTools = provider.requests.flatMap((request) => request.body?.messages ?? []).filter((message) => message.role === "tool");
  assert.match(JSON.stringify(modelTools), /2322/, "compiler findings must reach the model for its next decision");
  assert.ok(envelopes.some((envelope) => JSON.stringify(envelope).includes("2322")), "compiler findings must also reach the desktop event projection");
  evidence.checks.push("diagnostics reach both model continuation and desktop projection");
});
