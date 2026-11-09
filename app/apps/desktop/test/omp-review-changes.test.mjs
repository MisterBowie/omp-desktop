import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { OmpEventConverter } = await import(
  pathToFileURL(join(here, "../../../packages/omp-runtime/src/session/events.ts"))
);
const { ompReviewChangesFromMessage, OMP_REVIEW_MAX_DIFF_LINES } = await import(
  "../src/lib/omp-review-changes.ts"
);
const { reviewTabEntriesFromMessages, summarizeReviewTabEntries } = await import(
  "../src/lib/workspace-review.ts"
);

/**
 * Result shapes below are the ones the pinned OMP runtime returned in a real
 * scripted session (see omp-review-changes-e2e.test.mjs); only the temporary
 * project root is replaced with `/repo`.
 */
const converter = new OmpEventConverter({ sessionId: "s1", now: () => 1 });
function row(toolName, details, { id = "call-1", text = "ok", isError = false } = {}) {
  return converter.convertEntry({
    id: `entry-${id}`,
    parentId: null,
    timestamp: "2026-11-05T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: id,
      timestamp: 1,
      isError,
      content: [{ type: "text", text }],
      ...(details === undefined ? {} : { details }),
    },
  });
}

test("a multi-file OMP edit yields one exact row per file from OMP's own diff", () => {
  const message = row("edit", {
    diff: "-1|a1\n+1|A1\n 2|a2\n 1|b1\n-2|b2\n+2|B2\n+3|B2b\n 3|b3",
    firstChangedLine: 1,
    perFileResults: [
      { path: "/repo/a.txt", diff: "-1|a1\n+1|A1\n 2|a2", firstChangedLine: 1, op: "update", oldText: "a1\na2\n", newText: "A1\na2\n" },
      { path: "/repo/b.txt", diff: " 1|b1\n-2|b2\n+2|B2\n+3|B2b\n 3|b3", firstChangedLine: 2, op: "update", oldText: "b1\nb2\nb3\n", newText: "b1\nB2\nB2b\nb3\n" },
    ],
  });
  const changes = ompReviewChangesFromMessage(message);
  assert.deepEqual(
    changes.map(({ path, status, additions, deletions, truncated }) => ({ path, status, additions, deletions, truncated })),
    [
      { path: "/repo/a.txt", status: "modified", additions: 1, deletions: 1, truncated: false },
      { path: "/repo/b.txt", status: "modified", additions: 2, deletions: 1, truncated: false },
    ],
  );
  assert.deepEqual(changes[1].hunks, [{
    header: "@@ -1 +1 @@",
    lines: [
      { type: "context", text: "b1" },
      { type: "del", text: "b2" },
      { type: "add", text: "B2" },
      { type: "add", text: "B2b" },
      { type: "context", text: "b3" },
    ],
  }]);
  assert.notEqual(changes[0].key, changes[1].key);
});

test("separate regions become separate hunks with headers in old and new numbering", () => {
  const [change] = ompReviewChangesFromMessage(row("edit", {
    op: "update",
    path: "/repo/long.txt",
    diff: "-2|two\n+2|TWO\n+3|extra\n 3|three\n\n 9|nine\n-10|ten\n+11|TEN",
  }));
  assert.equal(change.additions, 3);
  assert.equal(change.deletions, 2);
  assert.deepEqual(change.hunks.map((hunk) => hunk.header), ["@@ -2 +2 @@", "@@ -9 +10 @@"]);
});

test("patch-mode unified diffs are read without counting file headers", () => {
  const [change] = ompReviewChangesFromMessage(row("edit", {
    op: "update",
    path: "/repo/app.py",
    diff: "--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def greet():\n-    print('Hi')\n+    print('Hello')\n\\ No newline at end of file",
  }));
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.equal(change.hunks[0].header, "@@ -1,2 +1,2 @@");
  assert.deepEqual(change.hunks[0].lines.map((line) => line.type), ["context", "del", "add"]);
});

test("delete, create and rename keep their own status and only real line evidence", () => {
  const [deleted] = ompReviewChangesFromMessage(row("edit", { diff: "", op: "delete", path: "/repo/c.txt", oldText: "delete me\n" }));
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.additions, 0);
  assert.equal(deleted.deletions, 1);
  assert.deepEqual(deleted.hunks[0].lines, [{ type: "del", text: "delete me" }]);

  const [created] = ompReviewChangesFromMessage(row("edit", { diff: "", op: "create", path: "/repo/new.txt", newText: "x\ny\n" }));
  assert.equal(created.status, "added");
  assert.equal(created.additions, 2);

  const [renamed] = ompReviewChangesFromMessage(row("edit", {
    diff: "", op: "update", move: "/repo/moved.txt", sourcePath: "/repo/d.txt", path: "/repo/moved.txt",
    oldText: "move me\n", newText: "move me\n",
  }));
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.path, "/repo/moved.txt");
  assert.equal(renamed.sourcePath, "/repo/d.txt");
  assert.equal(renamed.additions, 0);
  assert.equal(renamed.deletions, 0);

  // Snapshots pruned by OMP: a delete without oldText has no line evidence.
  const [pruned] = ompReviewChangesFromMessage(row("edit", { diff: "", op: "delete", path: "/repo/big.bin", snapshotsPruned: true }));
  assert.equal(pruned.status, "deleted");
  assert.equal(pruned.additions, null);
  assert.equal(pruned.deletions, null);
});

test("a write reports where it wrote, never a guessed status or diff", () => {
  const changes = ompReviewChangesFromMessage(row("write", { resolvedPath: "/repo/created.txt" }, {
    text: "[created.txt#0127]\nSuccessfully wrote 8 bytes to created.txt",
  }));
  assert.deepEqual(changes, [{
    key: `${changes[0].key}`,
    path: "/repo/created.txt",
    status: "written",
    additions: null,
    deletions: null,
    hunks: [],
    truncated: false,
  }]);
  assert.deepEqual(ompReviewChangesFromMessage(row("write", { xdev: { kind: "device" }, resolvedPath: "xd://lsp" })), []);
});

test("failures, no-ops, PI snapshots and look-alike plugins yield no OMP rows", () => {
  assert.deepEqual(ompReviewChangesFromMessage(row("edit", undefined, { isError: true, text: "Error: stale tag" })), []);
  // OMP's no-op: an update that changed nothing and moved nothing.
  assert.deepEqual(ompReviewChangesFromMessage(row("edit", { diff: "", op: "update", path: "/repo/same.txt", oldText: "a\n", newText: "a\n" })), []);
  // A failed file inside a multi-file result is skipped; its sibling stays.
  const partial = ompReviewChangesFromMessage(row("edit", {
    diff: "-1|x\n+1|X",
    perFileResults: [
      { path: "/repo/ok.txt", diff: "-1|x\n+1|X", op: "update" },
      { path: "/repo/bad.txt", isError: true, errorText: "stale" },
    ],
  }));
  assert.deepEqual(partial.map((change) => change.path), ["/repo/ok.txt"]);
  // PI's Edit/Write own a host snapshot and are read by the PI card only.
  const pi = {
    id: "pi-1", role: "tool", content: "", createdAt: "2026-11-05T00:00:00Z", toolName: "Edit", toolStatus: "success",
    toolResult: { details: { root: "workspace", review: { version: 1 }, diff: "-1|a\n+1|b" } },
  };
  assert.deepEqual(ompReviewChangesFromMessage(pi), []);
  // A plugin whose name only ends in `edit` is not the native tool.
  assert.deepEqual(ompReviewChangesFromMessage(row("plugin_publisher_edit", { diff: "-1|a\n+1|b", path: "/repo/x" })), []);
  assert.deepEqual(ompReviewChangesFromMessage(row("read", { path: "/repo/a.txt" })), []);
});

test("a cut-short result keeps the file but drops counts it cannot prove", () => {
  const [change] = ompReviewChangesFromMessage(row("edit", {
    op: "update", path: "/repo/huge.txt", diff: "-1|a\n+1|b…", truncated: true,
  }));
  assert.equal(change.truncated, true);
  assert.equal(change.additions, null);
  assert.equal(change.deletions, null);
  assert.deepEqual(change.hunks, []);
});

test("very long diffs are capped for display while the counts stay exact", () => {
  const rows = Array.from({ length: OMP_REVIEW_MAX_DIFF_LINES + 50 }, (_, index) => `+${index + 1}|line ${index}`);
  const [change] = ompReviewChangesFromMessage(row("edit", { op: "update", path: "/repo/gen.txt", diff: rows.join("\n") }));
  assert.equal(change.additions, OMP_REVIEW_MAX_DIFF_LINES + 50);
  assert.equal(change.truncated, true);
  assert.equal(change.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), OMP_REVIEW_MAX_DIFF_LINES);
});

test("the Review list merges PI snapshots and OMP rows in message order", () => {
  const piReview = {
    version: 1, snapshotId: "snap-1", messageId: "pi-1", path: "src/a.ts", operation: "edit",
    status: "modified", state: "rolledBack", additions: 4, deletions: 1, hunks: [], reversible: true,
  };
  const pi = {
    id: "pi-1", role: "tool", content: "", createdAt: "2026-11-05T00:00:00Z", toolName: "Edit", toolStatus: "success",
    toolResult: { details: { root: "workspace", review: piReview } },
  };
  const write = row("write", { resolvedPath: "/repo/w.txt" }, { id: "w-1" });
  const edit = row("edit", { op: "update", path: "/repo/e.txt", diff: "-1|a\n+1|b\n+2|c" }, { id: "e-1" });
  const entries = reviewTabEntriesFromMessages([write, pi, edit]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["omp", "snapshot", "omp"]);
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 3);
  assert.deepEqual(summarizeReviewTabEntries(entries), {
    changeCount: 3,
    activeCount: 2,
    rolledBackCount: 1,
    // The write has no line evidence, so it adds nothing to the totals.
    additions: 4 + 2,
    deletions: 1 + 1,
  });
});
