/**
 * The direct, read-only native session reader (M5/T20-D repair3).
 *
 * These cases pin the on-disk format contract the reader shares with the
 * pinned runtime's loader — title slot folding, header/version/identity
 * refusal, lenient records, the leaf the loader reconstructs — and the bounds
 * that keep a huge journal from being buffered whole. The real runtime remains
 * the equivalence authority for a real transcript (see
 * `apps/desktop/test/omp-history-e2e.test.mjs`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readNativeSessionEntries } from "./native-session-file.js";

const scratch: string[] = [];

function writeJournal(lines: string[], name = "session.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
  scratch.push(dir);
  const file = join(dir, name);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""), "utf8");
  return file;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const header = { type: "session", id: "session-1", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" };
const titleSlot = { type: "title", v: 1, title: "hello", updatedAt: "2026-01-01T00:00:00.000Z", pad: " ".repeat(8) };
const user = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 },
});

describe("readNativeSessionEntries", () => {
  it("folds the title slot, excludes the header and reports the last entry as the leaf", async () => {
    const file = writeJournal([JSON.stringify(titleSlot), JSON.stringify(header), JSON.stringify(user("m1", null)), JSON.stringify(user("m2", "m1"))]);
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.entries.map((entry) => (entry as { id: string }).id)).toEqual(["m1", "m2"]);
    expect(read.leafId).toBe("m2");
  });

  it("reads a legacy file whose first line is the header (no title slot)", async () => {
    const file = writeJournal([JSON.stringify(header), JSON.stringify(user("m1", null))]);
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.entries).toHaveLength(1);
    expect(read.leafId).toBe("m1");
  });

  it("treats a header-only journal as empty, not as a failure", async () => {
    const file = writeJournal([JSON.stringify(header)]);
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read).toEqual({ entries: [], leafId: null });
  });

  it("skips malformed JSON records and keeps the rest, like the native lenient loader", async () => {
    const file = writeJournal([
      JSON.stringify(header),
      "{\"type\":\"message\",\"id\":\"torn\"",
      JSON.stringify(user("m1", null)),
      "not json at all",
      JSON.stringify(user("m2", "m1")),
    ]);
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.entries.map((entry) => (entry as { id: string }).id)).toEqual(["m1", "m2"]);
    expect(read.leafId).toBe("m2");
  });

  it("ignores a trailing record without its terminating newline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
    scratch.push(dir);
    const file = join(dir, "torn.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify(header)}\n${JSON.stringify(user("m1", null))}\n{"type":"message","id":"uncommitted"`,
      "utf8",
    );
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.entries.map((entry) => (entry as { id: string }).id)).toEqual(["m1"]);
    expect(read.leafId).toBe("m1");
  });

  it("carries the leaf from a non-message last entry, exactly like the loader", async () => {
    const file = writeJournal([
      JSON.stringify(header),
      JSON.stringify(user("m1", null)),
      JSON.stringify({ type: "label", id: "l1", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", targetId: "m1", label: "x" }),
    ]);
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.leafId).toBe("l1");
  });

  it("accepts CRLF line endings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
    scratch.push(dir);
    const file = join(dir, "crlf.jsonl");
    writeFileSync(file, `${JSON.stringify(header)}\r\n${JSON.stringify(user("m1", null))}\r\n`, "utf8");
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.leafId).toBe("m1");
  });

  it("applies the v2 -> v3 hookMessage role rename in memory", async () => {
    const v2Header = { ...header, version: 2 };
    const hook = {
      type: "message",
      id: "h1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "hookMessage", content: [{ type: "text", text: "hook" }] },
    };
    const file = writeJournal([JSON.stringify(v2Header), JSON.stringify(hook)]);
    const read = await readNativeSessionEntries(file, "session-1");
    expect((read.entries[0] as { message: { role: string } }).message.role).toBe("custom");
  });

  it("refuses a file that belongs to a different session", async () => {
    const file = writeJournal([JSON.stringify(header), JSON.stringify(user("m1", null))]);
    await expect(readNativeSessionEntries(file, "other-session")).rejects.toMatchObject({
      errorCode: "OMP_RESTORE_FAILED",
    });
  });

  it("refuses a file without a session header instead of reading it as empty", async () => {
    const noHeader = writeJournal([JSON.stringify(user("m1", null))]);
    await expect(readNativeSessionEntries(noHeader, "session-1")).rejects.toMatchObject({
      errorCode: "OMP_HISTORY_INVALID",
    });
    const empty = writeJournal([]);
    await expect(readNativeSessionEntries(empty, "session-1")).rejects.toMatchObject({
      errorCode: "OMP_HISTORY_INVALID",
    });
  });

  it("refuses version 1 (no stable ids) and unknown future versions explicitly", async () => {
    const v1 = writeJournal([JSON.stringify({ type: "session", id: "session-1", cwd: "/p" })]);
    await expect(readNativeSessionEntries(v1, "session-1")).rejects.toThrow(/version 1/);
    const v4 = writeJournal([JSON.stringify({ ...header, version: 4 })]);
    await expect(readNativeSessionEntries(v4, "session-1")).rejects.toThrow(/version 4/);
    const malformed = writeJournal([JSON.stringify({ ...header, version: "three" })]);
    await expect(readNativeSessionEntries(malformed, "session-1")).rejects.toThrow(/malformed version/);
  });

  it("refuses an unreadable file and a file beyond the read bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
    scratch.push(dir);
    await expect(readNativeSessionEntries(join(dir, "missing.jsonl"), "session-1")).rejects.toMatchObject({
      errorCode: "OMP_HISTORY_READ_FAILED",
    });
    const file = writeJournal([JSON.stringify(header), JSON.stringify(user("m1", null))]);
    await expect(
      readNativeSessionEntries(file, "session-1", { maxBytes: 8 }),
    ).rejects.toThrow(/larger than/);
    await expect(
      readNativeSessionEntries(file, "session-1", { maxRecordBytes: 8 }),
    ).rejects.toThrow(/record larger than/);
  });
});
