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
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime, projectOmpHistory } =
  await import("../../../packages/omp-runtime/src/index.ts");
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
const { resolveProviderProjection, projectModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");

/**
 * The real runtime's provider retry reaches the desktop as status, not cards.
 *
 * OMP absorbs a short outage inside its transport; only when that gives up
 * does it fail the attempt and announce a session-level `auto_retry_start`.
 * The provider therefore refuses every request until the runner reports the
 * retry, then answers, so the test does not depend on the inner retry count.
 */
test("native OMP provider retry shows a retrying status and withdraws the superseded attempt", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 180_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-provider-retry-")));
  let provider;
  let supervisor;
  let runner;
  t.after(async () => {
    runner?.dispose("provider retry test finished");
    const stopped = await supervisor?.stop({ abortBash: false });
    await provider?.close();
    rmSync(root, { recursive: true, force: true });
    if (stopped) {
      assert.equal(stopped.reaped, true);
      assert.equal(stopped.cleaned, true);
    }
  });
  provider = await FakeProvider.start({ model: "local-model" });
  provider.script([{ httpStatus: 503, errorMessage: "No available accounts: no available accounts" }]);
  const resolved = resolveProviderProjection({
    id: "fixture", apiStyle: "chat_completions", authKind: "none", baseUrl: provider.baseUrl,
    models: [{ id: "local-model" }],
  }, "local-model", null);
  assert.equal(resolved.ok, true);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, cwd: root, launcherPath: resources.path, sessionDir: ensureSessionStateDir(root),
    desktopStateRequired: false,
    args: ["--model", "fixture/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: (paths) => writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(resolved.projection)),
  });
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  assert.ok(runtime);
  const state = await runtime.request({ type: "get_state" });
  assert.equal(state.success, true);
  const nativeSessionId = state.data.sessionId;

  const envelopes = [];
  const ended = Promise.withResolvers();
  runner = new OmpSessionRunner({
    sessionId: "provider-retry",
    runtime,
    nativeSessionIdentity: () => nativeSessionId,
    emit: (envelope) => {
      envelopes.push(envelope);
      const { event } = envelope;
      if (event.type === "status" && event.status.activity?.phase === "retrying") {
        provider.script([{ text: "RECOVERED", finish: "stop" }]);
      }
    },
    onUiRequest: () => assert.fail("no dialog is expected"),
    onTurnEnd: (info) => ended.resolve(info),
  });
  await runner.prompt("hello");
  const end = await ended.promise;
  assert.equal(end.reason, "completed");

  const events = envelopes.map(({ event }) => event);
  const retrying = events.find((event) => event.type === "status" && event.status.activity?.phase === "retrying");
  assert.ok(retrying, "the retry must reach the desktop as a retrying status");
  assert.equal(retrying.status.isRunning, true);
  assert.equal(retrying.status.activity.attempt, 1);
  assert.equal(typeof retrying.status.activity.retryDelayMs, "number");
  assert.deepEqual(
    { code: retrying.status.activity.error.code, providerStatus: retrying.status.activity.error.providerStatus },
    { code: "PROVIDER_ERROR", providerStatus: 503 },
  );

  const ends = events.filter((event) => event.type === "message_end" && event.message.role === "assistant");
  const failed = ends.find((event) => event.message.error);
  assert.ok(failed, "the failed attempt is reported before the runtime decides to retry");
  const withdrawn = ends.find((event) => event.message.id === failed.message.id && !event.message.error);
  assert.ok(withdrawn, "the superseded attempt is withdrawn");
  assert.equal(withdrawn.message.content, "");
  assert.equal(withdrawn.message.status, "error");
  assert.equal(ends.at(-1).message.content, "RECOVERED");
  assert.equal(ends.filter((event) => event.message.error && event.message.id !== failed.message.id).length, 0);

  const lastStatus = events.filter((event) => event.type === "status").at(-1);
  assert.equal(lastStatus.status.activity, undefined, "the retry status clears once the reply streams");
  assert.equal(runner.status().activity, undefined);

  const entries = await runtime.request({ type: "get_entries" });
  assert.equal(entries.success, true);
  const history = projectOmpHistory(entries.data.entries, entries.data.leafId ?? null, { sessionId: "provider-retry" });
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.content, Boolean(message.error)]),
    [["user", "hello", false], ["assistant", "RECOVERED", false]],
    "a reopened session shows the reply, not the attempt it superseded",
  );
});
