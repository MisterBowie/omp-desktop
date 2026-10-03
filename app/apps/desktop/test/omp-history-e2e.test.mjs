import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * M5/T20-D repair3 acceptance: the read-only native history path over the
 * *real* pinned runtime, with a local fake provider. The read path itself was
 * reworked: a session without a live runtime is now read from its own file by
 * the in-process direct reader — no runtime is started, so there is no reader
 * process, run directory or cleanup to own.
 *
 * Proves the properties an OMP session's history read must have:
 *
 *   1. a transcript written by one runtime process is readable by a *cold*
 *      reader — a fresh bridge that never prompted — so an application restart
 *      shows history before the user sends anything;
 *   2. the cold read is equivalent to the live runtime's own `get_entries`
 *      projection (same row ids, same order, same count);
 *   3. the read requires no provider credential and issues no provider request;
 *   4. the read does not write: the transcript bytes and the session directory
 *      are identical afterwards — on success and after every failure class;
 *   5. no runtime is created for a read: the supervisor factory is never
 *      called, no run directory appears, and bridge disposal holds nothing;
 *   6. a reference this build cannot read (wrong identity, missing file,
 *      unsupported version, corrupt entries) fails closed instead of rendering
 *      a different session or an empty page;
 *   7. a concurrent native writer is observed at a line boundary: a trailing
 *      fragment is ignored until its newline commits it.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

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

/** The identity a read needs; provider/model are carried but never consulted. */
function readRequest(nativeSessionId, nativeSessionPath, extra = {}) {
  return {
    sessionId: SESSION,
    projectPath: null,
    providerId: "provider-that-does-not-exist",
    modelId: "model-that-does-not-exist",
    nativeSessionId,
    nativeSessionPath,
    adapterVersion: 1,
    runtimeVersion: "18.3.0",
    ...extra,
  };
}

test(
  "M5/repair3 end-to-end: a cold in-process read shows the native transcript without writing it or starting a runtime",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const dataRoot = makeScratch("omp-history-data-");
    const sessionDir = ensureSessionStateDir(dataRoot);
    const runtimeStateDir = join(dataRoot, "omp-runtime");
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
    const supervisorFactories = [];
    const writer = createOmpSessionBridge({
      createSupervisor: () => {
        supervisorFactories.push("writer");
        return writerSupervisor();
      },
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

      // --- 2. the live runtime's own projection (the equivalence authority) ---
      const live = await writer.readHistory(readRequest(nativeSessionId, nativeSessionPath, { projectPath: project }));
      assert.ok(live.messages.some((message) => message.role === "user"), "the live read must show the user row");
      assert.ok(live.messages.some((message) => message.role === "assistant"), "the live read must show the assistant row");
      assert.ok(
        live.messages.some((message) => message.role === "tool" && message.toolCallId === "history-call-1"),
        "the live read must show the tool row",
      );
      assert.equal(provider.requests.length, requestsAfterTurn, "a live history read must not contact the provider");

      // --- 3. stop the writer; the transcript survives ------------------------
      const disposed = await writer.disposeSession(SESSION, "cold-read test");
      assert.equal(disposed.ok, true, `the writer must be reclaimed: ${JSON.stringify(disposed.failures)}`);
      assert.ok(existsSync(nativeSessionPath), "the transcript must survive the writer");
      factsBefore = transcriptFacts(nativeSessionPath, sessionDir);
      const runRootsBefore = existsSync(runtimeStateDir) ? readdirSync(runtimeStateDir).sort() : [];

      // --- 4. a cold read: same bridge, no entry, no runtime ------------------
      const cold = await writer.readHistory(readRequest(nativeSessionId, nativeSessionPath, { projectPath: project }));
      assert.deepEqual(
        cold.messages.map((message) => [message.id, message.role, message.content]),
        live.messages.map((message) => [message.id, message.role, message.content]),
        "the direct read must be equivalent to the live runtime's projection",
      );
      assert.equal(cold.messageCount, live.messageCount);
      assert.equal(cold.replacedLiveMessageIds.length, 0, "a cold read has no live rows to replace");
      assert.equal(
        supervisorFactories.length,
        1,
        "no runtime may be created for a history read (only the writer's supervisor exists)",
      );
      assert.deepEqual(
        existsSync(runtimeStateDir) ? readdirSync(runtimeStateDir).sort() : [],
        runRootsBefore,
        "a history read must not create a run directory",
      );
      assert.equal(provider.requests.length, requestsAfterTurn, "a cold history read must not contact the provider");

      // A fresh bridge that never prompted, with a supervisor factory that
      // must never run at all: the cold read has no runtime construction path.
      let coldFactoryCalls = 0;
      const coldOnly = createOmpSessionBridge({
        createSupervisor: () => {
          coldFactoryCalls += 1;
          throw new Error("a history read must not construct a runtime");
        },
        launcher: LAUNCHER,
        isPackaged: false,
        appPath: here,
        sessionDir,
        gateResolver: () => GATE,
        emitAgentEvent: () => undefined,
        logger: { app: () => undefined },
      });
      const coldOnlyRead = await coldOnly.readHistory(readRequest(nativeSessionId, nativeSessionPath, { projectPath: project }));
      assert.deepEqual(
        coldOnlyRead.messages.map((message) => message.id),
        live.messages.map((message) => message.id),
        "a session with no runtime history must be readable from the file alone",
      );
      assert.equal(coldFactoryCalls, 0);
      // No credential was needed: the request above names a provider that does
      // not exist and no secret was ever read; the read still succeeded.
      const coldDisposal = await coldOnly.dispose("test cleanup");
      assert.equal(coldDisposal.ok, true, JSON.stringify(coldDisposal.failures));

      // A second cold read returns the same ids (stable identity across reads).
      const again = await writer.readHistory(readRequest(nativeSessionId, nativeSessionPath, { projectPath: project }));
      assert.deepEqual(
        again.messages.map((message) => message.id),
        cold.messages.map((message) => message.id),
        "repeated cold reads must return stable ids",
      );

      // Bounded window: the newest page reports how much history precedes it.
      const tail = await writer.readHistory(
        readRequest(nativeSessionId, nativeSessionPath, { projectPath: project, messageLimit: 2 }),
      );
      assert.equal(tail.messages.length, 2);
      assert.equal(tail.hasMoreBefore, true);
      assert.equal(tail.messageStart, cold.messageCount - 2);

      // --- 5. byte purity after the successful reads --------------------------
      const factsAfterReads = transcriptFacts(nativeSessionPath, sessionDir);
      assert.equal(factsAfterReads.sha256, factsBefore.sha256, "the transcript bytes changed during a history read");
      assert.deepEqual(factsAfterReads.directory, factsBefore.directory, "the session directory gained or lost a file");

      // --- 6. concurrent native writer: only committed lines are records ------
      const partialPath = join(sessionDir, "partial.jsonl");
      const committed = readFileSync(nativeSessionPath, "utf8").split("\n").filter((line) => line.length > 0);
      writeFileSync(partialPath, `${committed.join("\n")}\n`, "utf8");
      const lastEntryId = JSON.parse(committed.at(-1)).id;
      const appendedEntry = {
        id: "m-after",
        parentId: lastEntryId,
        type: "message",
        timestamp: "2026-01-01T00:00:09.000Z",
        message: { role: "user", content: [{ type: "text", text: "after the cold read" }], timestamp: 9 },
      };
      const serialized = JSON.stringify(appendedEntry);
      // The writer is mid-record: only the committed lines may be read.
      writeFileSync(partialPath, serialized.slice(0, 24), { flag: "a" });
      const partialRead = await writer.readHistory(readRequest(nativeSessionId, partialPath, { projectPath: project }));
      assert.equal(
        partialRead.messageCount,
        cold.messageCount,
        "an unterminated trailing write must not be read as a record",
      );
      // The newline commits the record: now it is visible, with its stable id.
      writeFileSync(partialPath, `${serialized.slice(24)}\n`, { flag: "a" });
      const completedRead = await writer.readHistory(readRequest(nativeSessionId, partialPath, { projectPath: project }));
      assert.equal(completedRead.messageCount, cold.messageCount + 1);
      assert.equal(completedRead.messages.at(-1).content, "after the cold read");

      // --- 7. failure classes: refused, never touching the truth --------------
      await assert.rejects(
        () =>
          writer.readHistory({
            ...readRequest("not-this-session", nativeSessionPath, { projectPath: project }),
          }),
        (error) => error.errorCode === "OMP_RESTORE_FAILED",
        "a transcript whose header names another session must be refused",
      );
      await assert.rejects(
        () =>
          writer.readHistory({
            ...readRequest(nativeSessionId, join(sessionDir, "missing.jsonl"), { projectPath: project }),
          }),
        (error) => error.errorCode === "OMP_RESTORE_FAILED",
        "a missing transcript must be refused, never rendered as empty",
      );
      await assert.rejects(
        () => writer.readHistory(readRequest(nativeSessionId, sessionDir, { projectPath: project })),
        (error) => error.errorCode === "OMP_RESTORE_FAILED",
        "a directory must never be read as a transcript",
      );
      // A version this build cannot read without rewriting it: refused.
      const v1Path = join(sessionDir, "v1.jsonl");
      writeFileSync(
        v1Path,
        `${JSON.stringify({ type: "session", id: nativeSessionId, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "legacy" }] } })}\n`,
        "utf8",
      );
      await assert.rejects(
        () => writer.readHistory(readRequest(nativeSessionId, v1Path, { projectPath: project })),
        (error) => error.errorCode === "OMP_HISTORY_INVALID" && /version 1/.test(error.message),
        "a version 1 journal must be refused explicitly",
      );
      assert.equal(
        supervisorFactories.length,
        1,
        "no failure may create a runtime",
      );
      assert.equal(provider.requests.length, requestsAfterTurn, "no failure may contact the provider");

      const factsAfterRefusals = transcriptFacts(nativeSessionPath, sessionDir);
      assert.equal(factsAfterRefusals.sha256, factsBefore.sha256, "a refused read must not touch the transcript");
      assert.deepEqual(
        factsAfterRefusals.directory.filter((name) => !factsBefore.directory.includes(name)),
        ["partial.jsonl", "v1.jsonl"],
        "no read may create a file in the session directory",
      );

      const readerDisposal = await writer.dispose("test cleanup");
      assert.equal(readerDisposal.ok, true, `the bridge must hold nothing: ${JSON.stringify(readerDisposal.failures)}`);

      // One last purity check with every runtime process gone: none of the
      // reads above left anything behind.
      const finalFacts = transcriptFacts(nativeSessionPath, sessionDir);
      assert.equal(finalFacts.sha256, factsBefore.sha256, "the transcript changed after the reads");
      assert.equal(finalFacts.sizeBytes, factsBefore.sizeBytes);
      assert.deepEqual(
        finalFacts.directory.filter((name) => !factsBefore.directory.includes(name)),
        ["partial.jsonl", "v1.jsonl"],
        "no read may leave a file behind",
      );
      assert.deepEqual(
        existsSync(runtimeStateDir) ? readdirSync(runtimeStateDir).sort() : [],
        [],
        "every run directory must be reclaimed",
      );

      // One structured line for the evidence log: the exact facts the
      // assertions above compare, so a reviewer can re-derive every claim.
      console.log(
        `OMP-HISTORY-E2E ${JSON.stringify({
          session: SESSION,
          nativeSessionId,
          sha256: {
            beforeReads: factsBefore.sha256,
            afterReads: factsAfterReads.sha256,
            afterRefusals: factsAfterRefusals.sha256,
            final: finalFacts.sha256,
          },
          sizeBytes: { before: factsBefore.sizeBytes, final: finalFacts.sizeBytes },
          directoryDelta: finalFacts.directory.filter((name) => !factsBefore.directory.includes(name)),
          providerRequests: provider.requests.length,
          supervisorFactories: supervisorFactories.length,
          coldOnlySupervisorFactories: coldFactoryCalls,
          liveMessageIds: live.messages.map((message) => message.id),
          coldMessageIds: cold.messages.map((message) => message.id),
          runRoots: existsSync(runtimeStateDir) ? readdirSync(runtimeStateDir).sort() : [],
        })}`,
      );
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
