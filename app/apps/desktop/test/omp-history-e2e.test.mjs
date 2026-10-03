import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * M5/T20-R2 acceptance: the read-only native history path over the *real*
 * pinned runtime, with a local fake provider.
 *
 * Proves the four properties an OMP session's history read must have:
 *
 *   1. a transcript written by one runtime process is readable by a *cold*
 *      reader — a fresh process that never prompted — so an application restart
 *      shows history before the user sends anything;
 *   2. the read requires no provider credential and issues no provider request
 *      (the reader boots from the session's model *identity* with the secret
 *      deliberately omitted);
 *   3. the read does not write: the transcript bytes and the session directory
 *      are identical afterwards, including after the reader is reclaimed (the
 *      reader leaves the session before disposal, so its own `session_exit`
 *      diagnostic cannot land in the transcript);
 *   4. a reference this build cannot read fails closed instead of rendering a
 *      different session or an empty page.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { projectReadOnlyModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");

const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);
const SESSION = "history-session";

const scratch = [];
function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
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

/** sha256 of a file plus the session directory's exact file set. */
function transcriptFacts(path, sessionDir) {
  return {
    sizeBytes: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    directory: readdirSync(sessionDir).sort(),
  };
}

test(
  "M5/R2 end-to-end: a cold read-only runtime shows the native transcript without writing it",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const dataRoot = makeScratch("omp-history-data-");
    const sessionDir = ensureSessionStateDir(dataRoot);
    const project = makeScratch("omp-history-project-");
    const markerPath = join(project, "marker.txt");
    writeFileSync(markerPath, "before\n");

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      // One turn that reads the marker through a real tool call, so the
      // transcript carries a user row, an assistant row and a tool row.
      { text: "checking the marker", finish: "tool_calls", toolCalls: [{ id: "history-call-1", name: "read", args: { path: markerPath } }] },
      { text: "marker looks fine", finish: "stop" },
    ]);

    const writerSupervisor = () =>
      new OmpRuntimeSupervisor({
        dataRoot,
        launcherPath: LAUNCHER,
        expectedRuntimeVersion: "18.3.0",
        sessionDir,
        args: ["--trusted-extension", GATE],
        desktopStateRequired: false,
        extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
        prepareRun: (paths) => {
          writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
          writeFileSync(join(paths.agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
        },
        readyTimeoutMs: 60_000,
      });

    const bound = new Map();
    const envelopes = [];
    const writer = createOmpSessionBridge({
      createSupervisor: () => writerSupervisor(),
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      gateResolver: () => GATE,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      persistNativeSession: (info) => bound.set(info.sessionId, info),
    });

    let nativeSessionPath = null;
    let nativeSessionId = null;
    let factsBefore = null;
    const cleanupErrors = [];
    try {
      // --- 1. one real turn through the product bridge ------------------------
      await writer.prompt({ sessionId: SESSION, content: "HISTORY-USER-ONE", projectPath: project });
      assert.ok(
        await waitFor(() => envelopes.some((entry) => entry.event.type === "agent_end")),
        "the turn must finish",
      );
      assert.equal(readFileSync(markerPath, "utf8"), "before\n", "the read tool must not write");
      const binding = bound.get(SESSION);
      assert.ok(binding?.nativeSessionPath, "the native session reference must be persisted");
      nativeSessionPath = binding.nativeSessionPath;
      nativeSessionId = binding.nativeSessionId;
      assert.ok(nativeSessionPath.startsWith(sessionDir), "the transcript must live in the persistent session dir");

      const requestsAfterTurn = provider.requests.length;
      assert.ok(requestsAfterTurn >= 2, `the turn must have reached the provider (${requestsAfterTurn})`);

      // --- 2. stop the writer; the transcript survives ------------------------
      const disposed = await writer.disposeSession(SESSION, "cold-read test");
      assert.equal(disposed.ok, true, `the writer must be reclaimed: ${JSON.stringify(disposed.failures)}`);
      assert.ok(existsSync(nativeSessionPath), "the transcript must survive the writer");
      factsBefore = transcriptFacts(nativeSessionPath, sessionDir);

      // --- 3. a cold reader: read profile, no prompt, no secret ---------------
      const providerProjection = (hasSecret) => ({
        id: "m1fake",
        enabled: true,
        baseUrl: provider.baseUrl,
        apiStyle: "chat_completions",
        authKind: "api_key_and_base_url",
        hasSecret,
        models: [{ id: "local-model", contextWindow: 200_000 }],
      });
      const readSupervisor = (hasSecret = true) =>
        new OmpRuntimeSupervisor({
          dataRoot,
          launcherPath: LAUNCHER,
          expectedRuntimeVersion: "18.3.0",
          // The read profile owns no persistent session directory: the reader's
          // own startup session never materializes in the product's.
          args: ["--trusted-extension", GATE],
          desktopStateRequired: false,
          extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "deny" },
          prepareRun: (paths) => {
            // Exactly what the production wiring writes: the session's model
            // identity without its credential (auth: none), or a loopback
            // placeholder when the provider row cannot be projected. The secret
            // is never read on this path, and no `--model` selector is passed.
            writeFileSync(
              join(paths.agentDir, "models.yml"),
              projectReadOnlyModelsYaml(providerProjection(hasSecret), "local-model"),
              "utf8",
            );
          },
          readyTimeoutMs: 60_000,
        });

      // What the production wiring's read profile writes.
      const reader = createOmpSessionBridge({
        createSupervisor: readSupervisor,
        createReadSupervisor: readSupervisor,
        launcher: LAUNCHER,
        isPackaged: false,
        appPath: here,
        sessionDir,
        gateResolver: () => GATE,
        emitAgentEvent: () => undefined,
        logger: { app: () => undefined },
      });

      const requestsBeforeRead = provider.requests.length;
      const read = await reader.readHistory({
        sessionId: SESSION,
        projectPath: project,
        providerId: "m1fake",
        modelId: "local-model",
        nativeSessionId,
        nativeSessionPath,
        adapterVersion: 1,
        runtimeVersion: "18.3.0",
      });

      // Rows: the user's input, the assistant's reply, and the tool call keyed
      // by its own toolCallId (the identity the live renderer uses).
      const user = read.messages.find((message) => message.role === "user");
      const assistant = read.messages.find((message) => message.role === "assistant");
      const tool = read.messages.find((message) => message.role === "tool");
      assert.ok(user, `the transcript must contain the user row (${JSON.stringify(read.messages.map((m) => m.role))})`);
      assert.match(user.id, /^omp:history-session:entry:/);
      assert.match(user.content, /HISTORY-USER-ONE/);
      assert.ok(assistant, "the transcript must contain the assistant row");
      assert.ok(
        read.messages.some((message) => message.role === "assistant" && /marker looks fine/.test(message.content)),
        `the transcript must contain the final assistant reply (${JSON.stringify(read.messages.map((m) => [m.role, m.content.slice(0, 40)]))})`,
      );
      assert.ok(tool, "the transcript must contain the tool row");
      assert.equal(tool.id, "history-call-1");
      assert.equal(tool.toolCallId, "history-call-1");
      assert.equal(tool.toolStatus, "success");
      assert.equal(read.messageCount, read.messages.length);
      assert.deepEqual(read.replacedLiveMessageIds, [], "a cold read has no live rows to replace");

      // The read issued no provider request, and no turn ran.
      assert.equal(provider.requests.length, requestsBeforeRead, "a history read must not contact the provider");
      assert.equal(readFileSync(markerPath, "utf8"), "before\n", "a history read must not execute tools");

      // A second read of the same transcript returns the same ids.
      const again = await reader.readHistory({
        sessionId: SESSION,
        projectPath: project,
        providerId: "m1fake",
        modelId: "local-model",
        nativeSessionId,
        nativeSessionPath,
        adapterVersion: 1,
        runtimeVersion: "18.3.0",
      });
      assert.deepEqual(
        again.messages.map((message) => message.id),
        read.messages.map((message) => message.id),
        "repeated reads must return stable ids",
      );

      // Bounded window: the newest page reports how much history precedes it.
      const tail = await reader.readHistory({
        sessionId: SESSION,
        projectPath: project,
        providerId: "m1fake",
        modelId: "local-model",
        nativeSessionId,
        nativeSessionPath,
        adapterVersion: 1,
        runtimeVersion: "18.3.0",
        messageLimit: 2,
      });
      assert.equal(tail.messages.length, 2);
      assert.equal(tail.hasMoreBefore, true);
      assert.equal(tail.messageStart, read.messageCount - 2);
      assert.deepEqual(
        tail.messages.map((message) => message.id),
        read.messages.slice(-2).map((message) => message.id),
      );

      // A session whose provider no longer has a usable credential still
      // reads: the read profile projects the identity without the secret, and
      // the reader never contacts the provider.
      const secretless = createOmpSessionBridge({
        createSupervisor: () => readSupervisor(false),
        createReadSupervisor: () => readSupervisor(false),
        launcher: LAUNCHER,
        isPackaged: false,
        appPath: here,
        sessionDir,
        gateResolver: () => GATE,
        emitAgentEvent: () => undefined,
        logger: { app: () => undefined },
      });
      const secretlessRead = await secretless.readHistory({
        sessionId: SESSION,
        projectPath: project,
        providerId: "m1fake",
        modelId: "local-model",
        nativeSessionId,
        nativeSessionPath,
        adapterVersion: 1,
        runtimeVersion: "18.3.0",
      });
      assert.deepEqual(
        secretlessRead.messages.map((message) => message.id),
        read.messages.map((message) => message.id),
        "history must be readable without a usable provider credential",
      );
      assert.equal(provider.requests.length, requestsBeforeRead, "a credential-free read must not contact the provider");
      const secretlessDisposal = await secretless.dispose("test cleanup");
      assert.equal(secretlessDisposal.ok, true, JSON.stringify(secretlessDisposal.failures));

      // --- 4. byte purity, including after the reader was reclaimed ----------
      const factsAfter = transcriptFacts(nativeSessionPath, sessionDir);
      assert.equal(factsAfter.sha256, factsBefore.sha256, "the transcript bytes changed during a history read");
      assert.deepEqual(factsAfter.directory, factsBefore.directory, "the session directory gained or lost a file");
      assert.equal(provider.requests.length, requestsBeforeRead);

      // --- 5. an unreadable reference fails closed ---------------------------
      await assert.rejects(
        () =>
          reader.readHistory({
            sessionId: SESSION,
            projectPath: project,
            providerId: "m1fake",
            modelId: "local-model",
            nativeSessionId: "not-this-session",
            nativeSessionPath,
            adapterVersion: 1,
            runtimeVersion: "18.3.0",
          }),
        (error) => error.errorCode === "OMP_RESTORE_FAILED",
        "a transcript whose header names another session must be refused",
      );
      await assert.rejects(
        () =>
          reader.readHistory({
            sessionId: SESSION,
            projectPath: project,
            nativeSessionId,
            nativeSessionPath: join(sessionDir, "missing.jsonl"),
            adapterVersion: 1,
            runtimeVersion: "18.3.0",
          }),
        (error) => error.errorCode === "OMP_RESTORE_FAILED",
        "a missing transcript must be refused, never rendered as empty",
      );
      const factsAfterRefusals = transcriptFacts(nativeSessionPath, sessionDir);
      assert.equal(factsAfterRefusals.sha256, factsBefore.sha256, "a refused read must not touch the transcript");
      assert.equal(provider.requests.length, requestsBeforeRead);

      const readerDisposal = await reader.dispose("test cleanup");
      assert.equal(readerDisposal.ok, true, `the reader must hold nothing: ${JSON.stringify(readerDisposal.failures)}`);

      // One last purity check with every reader/writer process gone.
      const finalFacts = transcriptFacts(nativeSessionPath, sessionDir);
      assert.equal(finalFacts.sha256, factsBefore.sha256, "the transcript changed after the readers were reclaimed");
      assert.equal(finalFacts.sizeBytes, factsBefore.sizeBytes);
      assert.deepEqual(finalFacts.directory, factsBefore.directory);
    } finally {
      try {
        await writer.dispose("test cleanup");
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "E2E cleanup failed");
    }
  },
);
