/**
 * The Review tab's OMP rows over the *real* pinned runtime, with a local fake
 * provider scripting the model. No paid or remote model is called.
 *
 * Native `write` (new file and overwrite) and native hashline `edit`
 * (multi-file update, delete, rename, single update) run against a scratch
 * project. Their live `tool_end` results and the restored history rows must
 * yield the same read-only Review entries, with exact line counts taken from
 * OMP's own diff, and the PI snapshot reader must still find nothing in them.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { reviewChangesFromMessages, reviewTabEntriesFromMessages } = await import("../src/lib/workspace-review.ts");

const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);
const SESSION = "review-changes";

function waitFor(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** The renderer's live tool row, built the way `session-runtime.ts` builds it. */
function liveToolRows(envelopes) {
  const starts = new Map();
  const rows = [];
  for (const { event } of envelopes) {
    if (event.type === "tool_start") starts.set(event.toolCallId, event);
    if (event.type !== "tool_end") continue;
    const start = starts.get(event.toolCallId);
    rows.push({
      id: event.toolCallId,
      role: "tool",
      content: "",
      createdAt: "2026-11-05T00:00:00.000Z",
      toolCallId: event.toolCallId,
      ...(start ? { toolName: start.toolName, toolArgs: start.args } : {}),
      toolStatus: event.isError ? "error" : "success",
      toolResult: event.result,
      status: "complete",
      isError: event.isError,
    });
  }
  return rows;
}

/** macOS reports the scratch root both as `/private/var/…` and `/var/…`. */
const projectRelative = (path, project) =>
  path.replace(project, "<project>").replace(project.replace(/^\/private(?=\/)/, ""), "<project>");

const shape = (entries, project) =>
  entries.map(({ kind, change }) => ({
    kind,
    path: projectRelative(change.path, project),
    ...(change.sourcePath ? { sourcePath: projectRelative(change.sourcePath, project) } : {}),
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    lines: change.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.type}:${line.text}`)),
  }));

test(
  "OMP native edit/write results become exact read-only Review rows, live and restored",
  { timeout: 600_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const scratch = [];
    const makeScratch = (prefix) => {
      const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      scratch.push(path);
      return path;
    };
    const dataRoot = makeScratch("omp-review-data-");
    const project = makeScratch("omp-review-project-");
    const sessionDir = ensureSessionStateDir(dataRoot);
    for (const [name, text] of Object.entries({
      "existing.txt": "old line\nkeep\n",
      "a.txt": "a1\na2\n",
      "b.txt": "b1\nb2\nb3\n",
      "c.txt": "delete me\n",
      "d.txt": "move me\n",
      "f.txt": "f1\nf2\nf3\n",
    })) writeFileSync(join(project, name), text);

    const provider = await FakeProvider.start({ model: "local-model" });
    const bound = new Map();
    const envelopes = [];
    const bridge = createOmpSessionBridge({
      createSupervisor: () => new OmpRuntimeSupervisor({
        dataRoot,
        launcherPath: LAUNCHER,
        expectedRuntimeVersion: "18.3.0",
        sessionDir,
        args: ["--trusted-extension", GATE],
        desktopStateRequired: false,
        extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read,write,edit", OMP_DESKTOP_GATE_MODE: "allow" },
        prepareRun: (paths) => {
          writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
          writeFileSync(join(paths.agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
        },
        readyTimeoutMs: 60_000,
      }),
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      gateResolver: () => GATE,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      persistNativeSession: (info) => bound.set(info.sessionId, info),
    });

    let turnNo = 0;
    async function turn(toolCalls) {
      turnNo += 1;
      const ended = envelopes.filter((entry) => entry.event.type === "agent_end").length;
      provider.script([
        { text: `step ${turnNo}`, finish: "tool_calls", toolCalls: toolCalls.map((call, index) => ({ id: `t${turnNo}-${index}`, ...call })) },
        { text: `done ${turnNo}`, finish: "stop" },
      ]);
      await bridge.prompt({ sessionId: SESSION, content: `turn ${turnNo}`, projectPath: project });
      assert.ok(
        await waitFor(() => envelopes.filter((entry) => entry.event.type === "agent_end").length > ended),
        `turn ${turnNo} must finish`,
      );
    }
    /** The hashline snapshot tag OMP printed for a file it just read. */
    const tag = (name) => {
      const text = JSON.stringify(provider.requests.at(-1)?.body ?? null);
      const match = text.match(new RegExp(`\\[(${name.replace(".", "\\.")}#[0-9a-fA-F]{4})\\]`));
      assert.ok(match, `the read of ${name} must print its snapshot tag`);
      return match[1];
    };

    try {
      await turn([
        { name: "write", args: { path: "created.txt", content: "one\ntwo\n" } },
        { name: "write", args: { path: "existing.txt", content: "new line\nkeep\n" } },
      ]);
      await turn(["a.txt", "b.txt", "c.txt", "d.txt", "f.txt"].map((path) => ({ name: "read", args: { path } })));
      const [ta, tb, tc, td, tf] = ["a.txt", "b.txt", "c.txt", "d.txt", "f.txt"].map(tag);
      await turn([
        { name: "edit", args: { input: `*** Begin Patch\n[${ta}]\nPUT 1.=1:\n+A1\n[${tb}]\nPUT 2.=2:\n+B2\n+B2b\n*** End Patch` } },
        { name: "edit", args: { input: `*** Begin Patch\n[${tc}]\nREM\n*** End Patch` } },
        { name: "edit", args: { input: `*** Begin Patch\n[${td}]\nMV moved.txt\n*** End Patch` } },
        { name: "edit", args: { input: `*** Begin Patch\n[${tf}]\nPUT 2.=2:\n+F2\n*** End Patch` } },
      ]);

      // The runtime really changed the scratch project.
      assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "A1\na2\n");
      assert.equal(readFileSync(join(project, "b.txt"), "utf8"), "b1\nB2\nB2b\nb3\n");
      assert.equal(existsSync(join(project, "c.txt")), false);
      assert.equal(readFileSync(join(project, "moved.txt"), "utf8"), "move me\n");
      assert.equal(readFileSync(join(project, "f.txt"), "utf8"), "f1\nF2\nf3\n");

      const binding = bound.get(SESSION);
      assert.ok(binding?.nativeSessionPath, "the native session reference must be persisted");
      const history = await bridge.readHistory({
        sessionId: SESSION, projectPath: project, providerId: "x", modelId: "x",
        nativeSessionId: binding.nativeSessionId, nativeSessionPath: binding.nativeSessionPath,
        adapterVersion: 1, runtimeVersion: "18.3.0",
      });

      // Baseline: the PI snapshot reader alone leaves an OMP session's Review empty.
      assert.deepEqual(reviewChangesFromMessages(history.messages), []);

      const expected = [
        { kind: "omp", path: "<project>/created.txt", status: "written", additions: null, deletions: null, lines: [] },
        { kind: "omp", path: "<project>/existing.txt", status: "written", additions: null, deletions: null, lines: [] },
        { kind: "omp", path: "<project>/a.txt", status: "modified", additions: 1, deletions: 1, lines: ["del:a1", "add:A1", "context:a2"] },
        { kind: "omp", path: "<project>/b.txt", status: "modified", additions: 2, deletions: 1, lines: ["context:b1", "del:b2", "add:B2", "add:B2b", "context:b3"] },
        { kind: "omp", path: "<project>/c.txt", status: "deleted", additions: 0, deletions: 1, lines: ["del:delete me"] },
        { kind: "omp", path: "<project>/moved.txt", sourcePath: "<project>/d.txt", status: "renamed", additions: 0, deletions: 0, lines: [] },
        { kind: "omp", path: "<project>/f.txt", status: "modified", additions: 1, deletions: 1, lines: ["context:f1", "del:f2", "add:F2", "context:f3"] },
      ];
      const restored = reviewTabEntriesFromMessages(history.messages);
      assert.deepEqual(shape(restored, project), expected, "restored history rows");
      assert.equal(history.messages.find((m) => m.toolName === "write")?.toolArgs, undefined,
        "restored rows carry no tool args, so the entries cannot depend on them");

      const live = reviewTabEntriesFromMessages(liveToolRows(envelopes));
      assert.deepEqual(shape(live, project), expected, "live tool_end rows");
    } finally {
      await bridge.disposeSession(SESSION, "review e2e finished");
      await provider.close?.();
      for (const path of scratch) rmSync(path, { recursive: true, force: true });
    }
  },
);
