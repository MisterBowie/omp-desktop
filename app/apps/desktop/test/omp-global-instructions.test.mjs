import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as protocol from "../../../packages/shared/src/protocol.ts";

/**
 * Global instructions are desktop data (R10): they are edited in the app's own
 * data directory and reach OMP as the run's user-level AGENTS.md, never
 * through the user's real `~/.pi` folder.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const instructions = await import("../electron/main/runtime/omp-global-instructions.ts");
const { MAX_GLOBAL_INSTRUCTIONS_BYTES, readGlobalInstructions, writeOmpGlobalInstructions } = instructions;

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-global-instructions-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("missing or blank instructions load as none; content loads trimmed", async (t) => {
  const dataDir = scratch(t);
  assert.equal(await readGlobalInstructions(dataDir), null);
  writeFileSync(join(dataDir, "AGENTS.md"), " \n\t\n");
  assert.equal(await readGlobalInstructions(dataDir), null);
  writeFileSync(join(dataDir, "AGENTS.md"), "\n  Prefer small diffs.\n\n");
  assert.equal(await readGlobalInstructions(dataDir), "Prefer small diffs.");
});

test("oversized instructions keep whole characters within the budget and say what was cut", async (t) => {
  const dataDir = scratch(t);
  const content = "规".repeat(MAX_GLOBAL_INSTRUCTIONS_BYTES); // 3 bytes per character
  writeFileSync(join(dataDir, "AGENTS.md"), content);
  const loaded = await readGlobalInstructions(dataDir);
  const keptChars = Math.floor(MAX_GLOBAL_INSTRUCTIONS_BYTES / 3);
  assert.ok(loaded.startsWith("规".repeat(keptChars)));
  assert.equal(loaded.includes("\uFFFD"), false, "no character is split");
  assert.match(loaded, new RegExp(`loaded the first ${keptChars * 3} of ${MAX_GLOBAL_INSTRUCTIONS_BYTES * 3} bytes`));
});

test("a run receives the instructions as its user-level AGENTS.md and loses a stale copy", async (t) => {
  const home = scratch(t);
  await writeOmpGlobalInstructions(home, "Prefer small diffs.");
  assert.equal(readFileSync(join(home, ".agents", "AGENTS.md"), "utf8"), "Prefer small diffs.\n");
  await writeOmpGlobalInstructions(home, null);
  assert.equal(fs.existsSync(join(home, ".agents", "AGENTS.md")), false);
});

test("an alias planted at the run's AGENTS.md is replaced, never followed", async (t) => {
  const home = scratch(t);
  const outside = join(home, "outside.txt");
  writeFileSync(outside, "untouched\n");
  mkdirSync(join(home, ".agents"), { recursive: true });
  symlinkSync(outside, join(home, ".agents", "AGENTS.md"));
  await writeOmpGlobalInstructions(home, "Prefer small diffs.");
  assert.equal(readFileSync(outside, "utf8"), "untouched\n");
  assert.equal(lstatSync(join(home, ".agents", "AGENTS.md")).isSymbolicLink(), false);
});

/** Load app-ipc with stubbed Electron-only imports; its handlers use the real filesystem. */
function loadAppIpc() {
  const file = new URL("../electron/main/ipc/app-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const imports = {
    electron: { BrowserWindow: { fromWebContents: () => null } },
    "node:path": path,
    "node:fs": fs,
    "node:fs/promises": fsPromises,
    "../system-fonts": { listInstalledFonts: async () => [] },
    "@pi-desktop/shared": { ...protocol, ErrorCodes, assertFeedbackIssueUrl() {}, buildBugReportUrl: () => "" },
    "../runtime/omp-global-instructions": instructions,
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected app-ipc dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

test("the settings editor reads and writes the global file in the app data directory", async (t) => {
  const dataDir = scratch(t);
  const handlers = new Map();
  loadAppIpc().registerAppIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler), handleWithEvent() {} },
    getHost: () => null,
    getPluginLauncherWindow: () => null,
    togglePluginLauncher: async () => {},
    safeOpenExternal: async () => {},
    updater: {},
    dataDir,
  });
  const { IPC } = protocol;
  const before = await handlers.get(IPC.invoke.agentInstructionsGet)({});
  assert.deepEqual(before.global, { scope: "global", path: join(dataDir, "AGENTS.md"), content: "", exists: false });
  await handlers.get(IPC.invoke.agentInstructionsSave)({ scope: "global", content: "Prefer small diffs." });
  assert.equal(readFileSync(join(dataDir, "AGENTS.md"), "utf8"), "Prefer small diffs.");
  assert.equal(await readGlobalInstructions(dataDir), "Prefer small diffs.", "the next OMP run loads what was saved");
});
