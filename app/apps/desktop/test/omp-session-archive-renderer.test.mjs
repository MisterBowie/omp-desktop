import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readStoreSource, readStoreModule } from "./helpers/source-contracts.mjs";

/**
 * H2/J3: the renderer archive path must be an awaited transaction, not
 * fire-and-forget. The source-contract assertions below pin the order the
 * archive store action and the Sidebar caller must keep; the executable test at
 * the bottom runs the real `createProjectSlice().archiveSession()` action
 * against a rejecting `api.archiveSession` and proves the session stays
 * unarchived, nothing is persisted, and the rejection reaches the caller (which
 * is what prevents the Sidebar's no-next fallback from creating a replacement).
 */
const storeSource = await readStoreSource();
const projectSliceSource = await readStoreModule("slices/project-slice.ts");
const sidebarSource = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const apiModule = await import("../src/lib/api.ts");
const { createProjectSlice } = await import("../src/stores/slices/project-slice.ts");

test("archiveSession awaits the main reclaim before committing archived metadata", () => {
  // The action must be async and await the IPC before the `set(... archived: true)`.
  const action = projectSliceSource.match(/archiveSession: async[\s\S]*?\n    },\n/)?.[0] ?? "";
  assert.match(action, /async/);
  assert.match(action, /await api\.archiveSession\(id\)/);
  // The `set` that flips the metadata must come after the await.
  const awaitIndex = action.indexOf("await api.archiveSession(id)");
  const setIndex = action.indexOf("archived: true");
  assert.ok(awaitIndex >= 0, "the archive action must await the IPC");
  assert.ok(setIndex > awaitIndex, "the archived metadata must be committed only after the IPC resolves");
});

test("toggleSessionArchived awaits the main reclaim when archiving", () => {
  const action = projectSliceSource.match(/toggleSessionArchived: async[\s\S]*?\n    },\n/)?.[0] ?? "";
  assert.match(action, /await api\.archiveSession\(id\)/);
  assert.match(action, /persistCurrentSidebar\(get\)/);
});

test("the AppState type declares archive actions as awaitable", () => {
  assert.match(storeSource, /archiveSession: \(id: string\) => Promise<void>/);
  assert.match(storeSource, /toggleSessionArchived: \(id: string\) => Promise<void>/);
  assert.match(storeSource, /restoreSession: \(id: string\) => void/);
});

test("every Sidebar archive call site awaits the action", () => {
  // Three archive paths (with-next, no-next active, plain) all await; the
  // unarchive path calls the synchronous restoreSession and never awaits a
  // runtime call.
  assert.match(sidebarSource, /await archiveSessionAction\(session\.id\)/);
  assert.match(sidebarSource, /restoreSession\(session\.id\)/);
  // The no-next active path must await the archive before creating the fallback
  // session, so a failed archive never creates a replacement session.
  assert.match(sidebarSource, /await archiveSessionAction\(session\.id\);\n\s*try \{\n\s*await newSession/);
});

test("the archive failure reaches the existing reportError path", () => {
  // The Sidebar archive closure already wraps everything in a try/catch that
  // calls reportError; the await makes the rejection reach it.
  const archive = sidebarSource.match(/const archiveSession = async[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(archive, /catch \(error\) \{\s*\n\s*reportError\(error\)/);
});

test("J3: archiveSession keeps the session unarchived and skips persistence when the reclaim rejects", async () => {
  // Executes the real store action. `api.archiveSession` rejects, so the
  // action must propagate that rejection and must not commit `archived: true`
  // to either `sessionMeta` or `sessions`, and must not call the sidebar
  // persistence sink. The rejection is what stops the Sidebar's no-next flow
  // from running `newSession` (asserted above as a source contract).
  const session = { id: "s1", title: "t", archived: false };
  let state = {
    sessions: [session],
    sessionMeta: { s1: { archived: false } },
  };
  let persistCalls = 0;
  const get = () => state;
  const set = (update) => {
    const patch = typeof update === "function" ? update(state) : update;
    Object.assign(state, patch);
  };
  const slice = createProjectSlice({
    get,
    set,
    runtime: {
      beginNavigationIntent: () => 1,
      isSessionSelectionForIntent: () => false,
      navigationIntentIsCurrent: () => true,
    },
    manualSessionTitles: new Set(),
    withoutRecordKey: (record, key) => {
      const { [key]: _omitted, ...rest } = record;
      return rest;
    },
    withProjectDisplayName: (workspace) => workspace,
    promoteProjectPath: (paths) => paths,
    removeProjectPath: (paths) => paths,
    upsertWorkspace: (projects) => projects,
    persistCurrentSidebar: () => {
      persistCalls += 1;
    },
  });

  const previous = apiModule.api.archiveSession;
  apiModule.api.archiveSession = async () => {
    throw new Error("the OMP runtime could not be reclaimed");
  };
  try {
    await assert.rejects(() => slice.archiveSession("s1"), /could not be reclaimed/);
    assert.equal(state.sessionMeta.s1.archived, false, "sessionMeta[id].archived must stay unmodified");
    assert.equal(state.sessions[0].archived, false, "the sessions[] entry must stay unarchived");
    assert.equal(persistCalls, 0, "sidebar/project persistence must not be called");
  } finally {
    apiModule.api.archiveSession = previous;
  }
});
