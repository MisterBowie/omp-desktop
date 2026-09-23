import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreSource, readStoreModule } from "./helpers/source-contracts.mjs";

/**
 * H2: the renderer archive path must be an awaited transaction, not
 * fire-and-forget. These source-contract assertions pin the order the archive
 * store action and the Sidebar caller must keep: the metadata commit happens
 * only after `api.archiveSession` resolves, and every Sidebar call site awaits
 * the action so a rejection reaches the existing `reportError` path.
 */
const storeSource = await readStoreSource();
const projectSliceSource = await readStoreModule("slices/project-slice.ts");
const sidebarSource = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");

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
