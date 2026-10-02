/**
 * T20-B1 semantics probe: what a `before_agent_start` handler can actually do
 * against the real pinned runtime.
 *
 * The gate's fail-closed path (a state file that claims the firing session but
 * fails validation) aborts the turn through `ctx.abort()`. That decision must
 * rest on measured behavior, not assumption:
 *
 *   - a handler that calls `ctx.abort()` must prevent the provider request —
 *     the prompt is refused before any model call;
 *   - a handler that throws must NOT be treated as protection: the pinned
 *     extension runner catches handler errors, logs them and continues, so the
 *     provider request is still delivered (negative control).
 *
 * Both probes load a fixture extension as the only `--trusted-extension`,
 * start the runtime through the product supervisor and drive one raw
 * `new_session` + `prompt` exchange against the local fake provider.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);

const LAUNCHER = findPinnedLauncher(here);
const ABORT_FIXTURE = join(here, "fixtures", "omp-start-abort.ts");
const THROW_FIXTURE = join(here, "fixtures", "omp-start-throw.ts");

const scratchDirs = [];
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup();
    } catch {
      // Best-effort: a failed cleanup must not mask the probe result.
    }
  }
  for (const entry of scratchDirs.splice(0)) rmSync(entry, { recursive: true, force: true });
});

function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 30_000, intervalMs = 50) {
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

async function runProbe({ extension, project }) {
  const dataRoot = makeScratch("omp-start-semantics-data-");
  const provider = await FakeProvider.start({ model: "local-model" });
  cleanups.push(() => provider.close?.());
  provider.script([{ text: "DELIVERED-TO-PROVIDER", finish: "stop" }]);
  const sessionDir = ensureSessionStateDir(dataRoot);
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot,
    launcherPath: LAUNCHER,
    expectedRuntimeVersion: "18.3.0",
    sessionDir,
    args: ["--trusted-extension", extension],
    prepareRun: (paths) => {
      writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
    },
    readyTimeoutMs: 60_000,
  });
  supervisor.setWorkingDirectory(project);
  cleanups.push(() => supervisor.stop());
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  assert.ok(runtime, "the runtime must be available after start");
  const frames = [];
  runtime.onFrame((frame) => frames.push(frame));
  const created = await runtime.request({ type: "new_session" }, { timeoutMs: 20_000 });
  assert.notEqual(created.success, false, "the probe session must be created");

  let outcome = "pending";
  const promptTask = runtime
    .request({ type: "prompt", message: "start the turn" }, { timeoutMs: 20_000 })
    .then((response) => {
      outcome = response;
      return response;
    })
    .catch((error) => {
      outcome = { error: String(error?.message ?? error) };
    });
  // Settle on the first evidence: a provider request (delivered) or the run
  // ending (refused). When neither appears, a short grace period gives a late
  // request a chance before the count is asserted.
  const sawEvidence = await waitFor(
    () => provider.requests.length > 0 || frames.some((frame) => frame?.type === "agent_end"),
    10_000,
  );
  if (!sawEvidence) await new Promise((resolve) => setTimeout(resolve, 2_000));
  const requests = provider.requests.length;
  const systemTexts = provider.requests.map((request) =>
    (request.body?.messages ?? []).filter((message) => message?.role === "system").map((message) => String(message.content)),
  );
  await supervisor.stop().catch(() => undefined);
  await promptTask.catch(() => undefined);
  return { outcome, requests, frames, systemTexts };
}

test(
  "before_agent_start: ctx.abort refuses the prompt and a throwing handler does not",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");

    const aborted = await runProbe({ extension: ABORT_FIXTURE, project: makeScratch("omp-start-abort-project-") });
    assert.equal(
      aborted.requests,
      0,
      `ctx.abort() must prevent any provider request; outcome=${JSON.stringify(aborted.outcome)}`,
    );

    const thrown = await runProbe({ extension: THROW_FIXTURE, project: makeScratch("omp-start-throw-project-") });
    assert.equal(
      thrown.requests,
      1,
      `a throwing handler must be logged and swallowed, not treated as a refusal; outcome=${JSON.stringify(thrown.outcome)}`,
    );
    assert.ok(
      thrown.frames.some((frame) => JSON.stringify(frame).includes("DELIVERED-TO-PROVIDER")),
      `the streamed answer must arrive after a throwing handler; frames=${JSON.stringify(thrown.frames).slice(0, 400)}`,
    );
  },
);
