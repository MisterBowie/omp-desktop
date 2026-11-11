/**
 * A typed answer to the OMP `ask` tool reaches the model on the real patched
 * runtime, driven through the production session bridge and a local fake
 * provider. No paid or remote model is called.
 *
 * Over RPC the tool asks with a `select` whose last option is its own
 * free-text entry; only after that option is picked does it raise an `editor`
 * dialog for the text. The card offers its own typed-answer row, so the
 * bridge must carry the text through that two-step exchange. Before the fix
 * the bridge answered the `select` with `cancelled`, which the tool treats
 * as the user aborting: the turn ended "Interrupted by user" and the model
 * never saw the answer.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { preparePatchedTree } = await import("../../../scripts/omp-patch.mjs");
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

const GATE = findGateExtension(here);
const SESSION = "ask-custom-answer-e2e";
const TYPED = "over Wi-Fi to a Windows PC";

const scratch = [];
function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 60_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** The tool result the provider received for the `ask` call, as text. */
function askToolResult(request) {
  const messages = request?.body?.messages ?? [];
  const result = messages.find((message) => message?.role === "tool" && message.tool_call_id === "call_ask");
  if (!result) return null;
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

const SCENARIOS = [
  { name: "typed answer", answer: TYPED, expectInResult: TYPED },
  { name: "listed option", answer: "Mac to Windows (Recommended)", expectInResult: "Mac to Windows" },
];

test("the OMP ask tool receives the user's typed or listed answer and the turn continues", { timeout: 300_000 }, async (t) => {
  assert.ok(GATE, "the shipped tool gate must be present");
  const prepared = await preparePatchedTree({ prepareBuild: true, keep: true });
  t.after(() => {
    prepared.cleanup();
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const LAUNCHER = join(prepared.tree, "packages", "coding-agent", "scripts", "omp");

  for (const scenario of SCENARIOS) {
    const root = makeScratch("omp-ask-custom-");
    const project = join(root, "project");
    const dataRoot = join(root, "data");
    mkdirSync(project);
    const sessionDir = ensureSessionStateDir(dataRoot);
    const provider = await FakeProvider.start({ model: "local-model" });
    provider.script([
      {
        finish: "tool_calls",
        toolCalls: [{
          id: "call_ask",
          name: "ask",
          args: {
            questions: [{
              id: "scenario",
              question: "Which scenario?",
              options: [{ label: "Mac to Windows", description: "LAN share" }, { label: "Inside one app" }],
              recommended: 0,
            }],
          },
        }],
      },
      { text: "Got it.", finish: "stop" },
    ]);

    const envelopes = [];
    const ends = [];
    let supervisor;
    let bridge;
    try {
      bridge = createOmpSessionBridge({
        createSupervisor: () => {
          supervisor = new OmpRuntimeSupervisor({
            dataRoot,
            launcherPath: LAUNCHER,
            expectedRuntimeVersion: "18.3.0",
            sessionDir,
            args: ["--model", "m1fake/local-model", "--trusted-extension", GATE],
            prepareRun: (paths) => writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" }),
            readyTimeoutMs: 60_000,
          });
          supervisor.setWorkingDirectory(project);
          return supervisor;
        },
        launcher: LAUNCHER,
        isPackaged: false,
        appPath: here,
        sessionDir,
        gateResolver: () => GATE,
        sessionPolicy: { policy: async () => ({ mode: "agent", permissionMode: "ask" }) },
        emitAgentEvent: (envelope) => envelopes.push(envelope),
        onTurnEnd: (info) => ends.push(info),
      });

      const accepted = await bridge.prompt({ sessionId: SESSION, content: "How do I move files to Windows?", projectPath: project });
      assert.equal(accepted.accepted, true, `${scenario.name}: prompt accepted`);
      const asked = () => envelopes.find((entry) => entry.event.type === "asktool_request");
      assert.ok(await waitFor(() => Boolean(asked())), `${scenario.name}: the ask card was raised`);
      const request = asked().event.request;
      assert.deepEqual(request.questions, [{
        question: "Which scenario?",
        options: ["Mac to Windows (Recommended)", "Inside one app"],
        multiSelect: false,
        allowCustom: true,
      }], `${scenario.name}: the card lists the model's options and offers a typed answer`);

      const resolution = bridge.resolveAsk({ requestId: request.requestId, sessionId: SESSION, answers: [[scenario.answer]] });
      assert.deepEqual(resolution, { ok: true, outcome: "answered" }, `${scenario.name}: the answer was delivered`);
      assert.ok(await waitFor(() => ends.length > 0), `${scenario.name}: the turn ended`);
      await waitFor(() => bridge.status(SESSION).state === "idle");

      assert.deepEqual(ends.map((entry) => entry.reason), ["completed"], `${scenario.name}: the turn completed, not aborted`);
      assert.equal(envelopes.filter((entry) => entry.event.type === "asktool_request").length, 1, `${scenario.name}: one card only`);
      assert.equal(envelopes.some((entry) => entry.event.type === "tool_permission_request"), false);
      const posts = provider.requests.filter((entry) => entry.method === "POST");
      assert.equal(posts.length, 2, `${scenario.name}: the model was called again with the answer`);
      const result = askToolResult(posts[1]);
      assert.ok(result, `${scenario.name}: the second request carries the ask tool result`);
      assert.match(result, new RegExp(scenario.expectInResult), `${scenario.name}: the model sees the answer`);
      assert.doesNotMatch(result, /cancelled/i, `${scenario.name}: the answer is not a cancellation`);
      assert.equal(bridge.hasPendingRequest(request.requestId), false);
    } finally {
      const disposed = bridge ? await bridge.dispose("ask e2e cleanup").catch((error) => ({ error: String(error) })) : null;
      const finalStop = supervisor ? await supervisor.stop().catch((error) => ({ error: String(error) })) : null;
      await provider.close();
      if (disposed) assert.deepEqual(disposed, { ok: true, failures: [] }, `${scenario.name}: dispose reclaimed the session`);
      if (finalStop) assert.equal(finalStop.reaped && finalStop.cleaned, true, `${scenario.name}: the runtime process and run root were reclaimed`);
    }
  }
});
