/**
 * The direct, read-only native session reader (M5/T20-D repair3).
 *
 * These cases pin the on-disk format contract the reader shares with the
 * pinned runtime's loader — title slot folding, header/version/identity
 * refusal, complete-JSON tails, the leaf the loader reconstructs — and the
 * deliberate divergence for damaged journals: a record that is not valid JSON
 * refuses the read instead of being skipped, because the desktop contract
 * refuses a damaged transcript rather than presenting it as complete. The real
 * runtime remains the equivalence authority for a real transcript (see
 * `apps/desktop/test/omp-history-e2e.test.mjs`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The parsed entry ids, for assertions over the reader's `unknown` output. */
function entryIds(entries: readonly unknown[]): unknown[] {
  return entries.map((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) && "id" in entry ? entry.id : undefined,
  );
}

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

  it("refuses a malformed record instead of silently dropping it", async () => {
    const file = writeJournal([
      JSON.stringify(header),
      "{\"type\":\"message\",\"id\":\"torn\"",
      JSON.stringify(user("m1", null)),
      "not json at all",
      JSON.stringify(user("m2", "m1")),
    ]);
    const before = readFileSync(file, "utf8");
    await expect(readNativeSessionEntries(file, "session-1")).rejects.toMatchObject({
      errorCode: "OMP_HISTORY_INVALID",
      message: /record that is not valid JSON/,
    });
    expect(readFileSync(file, "utf8")).toBe(before);

    // A malformed record before the header is the same refusal: the reader
    // must never skip its way to a later, apparently valid transcript.
    const beforeHeader = writeJournal(["not json at all", JSON.stringify(header)]);
    await expect(readNativeSessionEntries(beforeHeader, "session-1")).rejects.toMatchObject({
      errorCode: "OMP_HISTORY_INVALID",
    });
  });

  it("reads a complete JSON tail record even without its terminating newline", async () => {
    const file = writeJournal([
      JSON.stringify(titleSlot),
      JSON.stringify(header),
      JSON.stringify(user("m1", null)),
      JSON.stringify(user("m2", "m1")),
    ]);
    // Exactly the writer's bytes with the final newline withheld: the pinned
    // loader reads this tail (`malformedRecords` 0), so the desktop read must
    // show the last message rather than truncating the transcript.
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, ""), "utf8");
    const before = readFileSync(file, "utf8");
    const read = await readNativeSessionEntries(file, "session-1");
    expect(entryIds(read.entries)).toEqual(["m1", "m2"]);
    expect(read.leafId).toBe("m2");
    expect(readFileSync(file, "utf8")).toBe(before, "the reader must not add the missing newline");
  });

  it("validates a tail record exactly like a newline-terminated one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
    scratch.push(dir);
    const headerOnly = join(dir, "header-only.jsonl");
    writeFileSync(headerOnly, JSON.stringify(header), "utf8");
    expect(await readNativeSessionEntries(headerOnly, "session-1")).toEqual({ entries: [], leafId: null });

    const foreign = join(dir, "foreign.jsonl");
    writeFileSync(foreign, JSON.stringify({ ...header, id: "other-session" }), "utf8");
    await expect(readNativeSessionEntries(foreign, "session-1")).rejects.toMatchObject({
      errorCode: "OMP_RESTORE_FAILED",
    });

    const future = join(dir, "future.jsonl");
    writeFileSync(future, JSON.stringify({ ...header, version: 4 }), "utf8");
    await expect(readNativeSessionEntries(future, "session-1")).rejects.toThrow(/version 4/);
  });

  it("refuses an unterminated tail that is not valid JSON instead of dropping it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
    scratch.push(dir);
    const file = join(dir, "torn.jsonl");
    const m2 = JSON.stringify(user("m2", "m1"));
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(user("m1", null))}\n${m2.slice(0, 20)}`, "utf8");
    const before = readFileSync(file, "utf8");
    await expect(readNativeSessionEntries(file, "session-1")).rejects.toMatchObject({
      errorCode: "OMP_HISTORY_INVALID",
      message: /unterminated record/,
    });
    expect(readFileSync(file, "utf8")).toBe(before);

    // Committing the write (the rest of the record plus its newline) makes the
    // same snapshot readable: the refusal was a retryable mid-write view.
    writeFileSync(file, `${m2.slice(20)}\n`, { flag: "a" });
    const read = await readNativeSessionEntries(file, "session-1");
    expect(entryIds(read.entries)).toEqual(["m1", "m2"]);
    expect(read.leafId).toBe("m2");
  });

  it("ignores blank space after the last committed record", async () => {
    const file = writeJournal([JSON.stringify(header), JSON.stringify(user("m1", null))]);
    writeFileSync(file, `${readFileSync(file, "utf8")}   \n\n`, "utf8");
    expect((await readNativeSessionEntries(file, "session-1")).leafId).toBe("m1");
    // A whitespace-only fragment after the last newline is not a record.
    writeFileSync(file, `${readFileSync(file, "utf8")} \t`, "utf8");
    expect((await readNativeSessionEntries(file, "session-1")).leafId).toBe("m1");
  });

  it("keeps a multibyte tail character whole when the read chunk splits it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-native-session-"));
    scratch.push(dir);
    const file = join(dir, "utf8-tail.jsonl");
    const makeEntry = (text: string) =>
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
      });
    const probe = Buffer.from(makeEntry("中"), "utf8");
    const charOffset = probe.indexOf(Buffer.from("中", "utf8"));
    const headerLine = `${JSON.stringify(header)}\n`;
    // Straddle the stream's 64 KiB chunk boundary: the character's first byte
    // is the last byte of the first chunk, so the entry is only readable if
    // the decoder carries both the pending bytes and the unterminated tail.
    const padding = 64 * 1024 - 1 - Buffer.byteLength(headerLine, "utf8") - charOffset;
    const entry = makeEntry(`${"a".repeat(padding)}中尾`);
    writeFileSync(file, `${headerLine}${entry}`, "utf8");
    const read = await readNativeSessionEntries(file, "session-1");
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toEqual(JSON.parse(entry));
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
    // The per-record bound covers an unterminated tail too, before it is parsed.
    const headerBytes = Buffer.byteLength(JSON.stringify(header), "utf8");
    const tail = join(dir, "tail-bound.jsonl");
    writeFileSync(tail, `${JSON.stringify(header)}\n${"x".repeat(headerBytes + 8)}`, "utf8");
    await expect(
      readNativeSessionEntries(tail, "session-1", { maxRecordBytes: headerBytes + 1 }),
    ).rejects.toThrow(/record larger than/);
  });
});
