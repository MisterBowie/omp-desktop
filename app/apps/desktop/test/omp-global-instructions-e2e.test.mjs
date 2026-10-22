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
const { writeOmpGlobalInstructions } = await import("../electron/main/runtime/omp-global-instructions.ts");

/** One real run with optional desktop instructions; returns the model's system text. */
async function systemTextFor(t, resources, instructions) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-global-instructions-")));
  const provider = await FakeProvider.start();
  provider.script([{ text: "Done.", finish: "stop" }]);
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, cwd: root, launcherPath: resources.path, sessionDir: ensureSessionStateDir(root),
    desktopStateRequired: false,
    args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: async (paths) => {
      writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl });
      await writeOmpGlobalInstructions(paths.home, instructions);
    },
  });
  t.after(async () => {
    const stopped = await supervisor.stop({ abortBash: false });
    await provider.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(stopped.reaped, true);
    assert.equal(stopped.cleaned, true);
  });
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  const ended = Promise.withResolvers();
  t.after(runtime.onFrame((frame) => {
    if (frame.type === "agent_end" && frame.isTerminal !== false) ended.resolve();
  }));
  assert.equal((await runtime.request({ type: "prompt", message: "Say done." })).success, true);
  await ended.promise;
  const request = provider.requests.find((entry) => entry.url.endsWith("/chat/completions"));
  return (request.body.messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
}

test("native OMP loads the desktop's global instructions as its user-level AGENTS.md, and nothing without them", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 90_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const canary = `OMP-DESKTOP-GLOBAL-${process.pid}`;
  const withInstructions = await systemTextFor(t, resources, `Always mention ${canary}.`);
  assert.ok(withInstructions.includes(canary), "the instructions reach the model's system prompt");
  const without = await systemTextFor(t, resources, null);
  assert.equal(without.includes(canary), false, "a run without desktop instructions carries none");
});
