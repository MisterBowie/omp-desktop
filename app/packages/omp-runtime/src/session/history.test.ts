/**
 * The read-only history projection: branch walk, identity, windowing and the
 * fail-closed rules a transcript read must never bend (M5/T20-R2).
 *
 * Every case exercises the projection the bridge uses for `get_entries`
 * responses: an entry list plus the runtime's `leafId` in, desktop rows and a
 * window out. Malformed input must throw — an empty page is reserved for a
 * session that truly has no transcript.
 */
import { describe, expect, it } from "vitest";

import { OmpHistoryError, projectOmpHistory } from "./history.js";

const t = "2026-01-01T00:00:00.000Z";

function textMessage(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, content: [{ type: "text", text }], timestamp: 1, ...extra };
}

function entry(id: string, parentId: string | null, message: unknown, extra: Record<string, unknown> = {}) {
  return { id, parentId, type: "message", timestamp: t, message, ...extra };
}

const leafId = "m3";

describe("projectOmpHistory", () => {
  it("projects the active branch in root-to-leaf order with entry ids", () => {
    const offBranch = entry("fork", "m1", textMessage("assistant", "abandoned"));
    const entries = [
      { id: "h", parentId: null, type: "session", timestamp: t },
      entry("m1", "h", textMessage("user", "hello")),
      offBranch,
      entry("m2", "m1", textMessage("assistant", "hi")),
      entry("m3", "m2", textMessage("user", "again")),
    ];
    const projection = projectOmpHistory(entries, leafId, { sessionId: "s" });
    expect(projection.messages.map((message) => message.content)).toEqual(["hello", "hi", "again"]);
    expect(projection.messages.map((message) => message.id)).toEqual([
      "omp:s:entry:m1",
      "omp:s:entry:m2",
      "omp:s:entry:m3",
    ]);
    expect(projection.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(projection.messageCount).toBe(3);
    expect(projection.messageStart).toBe(0);
    expect(projection.hasMoreBefore).toBe(false);
    expect(projection.hasMoreAfter).toBe(false);
  });

  it("is stable across reads: the same transcript returns the same ids", () => {
    const entries = [
      entry("m1", null, textMessage("user", "hello")),
      entry("m2", "m1", textMessage("assistant", "hi")),
    ];
    const first = projectOmpHistory(entries, "m2", { sessionId: "s" });
    const second = projectOmpHistory(structuredClone(entries), "m2", { sessionId: "s" });
    expect(second.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id));
  });

  it("keys tool rows by their unique toolCallId and falls back to the entry id when ambiguous", () => {
    const unique = [
      entry("m1", null, textMessage("user", "run")),
      entry("m2", "m1", textMessage("assistant", "running")),
      entry("m3", "m2", { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "body" }] }),
    ];
    const uniqueProjection = projectOmpHistory(unique, "m3", { sessionId: "s" });
    expect(uniqueProjection.messages[2]).toMatchObject({ id: "call-1", role: "tool", toolName: "read", toolCallId: "call-1" });

    const duplicate = [
      entry("m1", null, textMessage("user", "run")),
      entry("m2", "m1", { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "one" }] }),
      entry("m3", "m2", { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "two" }] }),
    ];
    const duplicateProjection = projectOmpHistory(duplicate, "m3", { sessionId: "s" });
    expect(duplicateProjection.messages.map((message) => message.id)).toEqual([
      "omp:s:entry:m1",
      "omp:s:entry:m2",
      "omp:s:entry:m3",
    ]);
  });

  it("returns the newest window and reports whether older rows exist", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry(`m${index}`, index === 0 ? null : `m${index - 1}`, textMessage("user", `row ${index}`)),
    );
    const tail = projectOmpHistory(entries, "m9", { sessionId: "s", messageLimit: 3 });
    expect(tail.messages.map((message) => message.content)).toEqual(["row 7", "row 8", "row 9"]);
    expect(tail.messageStart).toBe(7);
    expect(tail.messageEnd).toBe(10);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);

    const older = projectOmpHistory(entries, "m9", { sessionId: "s", messageLimit: 3, messageBefore: 7 });
    expect(older.messages.map((message) => message.content)).toEqual(["row 4", "row 5", "row 6"]);
    expect(older.messageStart).toBe(4);
    expect(older.hasMoreBefore).toBe(true);
  });

  it("centers a messageAround window and reports both directions", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry(`m${index}`, index === 0 ? null : `m${index - 1}`, textMessage("user", `row ${index}`)),
    );
    const centered = projectOmpHistory(entries, "m9", {
      sessionId: "s",
      messageLimit: 4,
      messageAround: "omp:s:entry:m5",
    });
    expect(centered.messages.map((message) => message.content)).toEqual(["row 3", "row 4", "row 5", "row 6"]);
    expect(centered.messageStart).toBe(3);
    expect(centered.messageEnd).toBe(7);
    expect(centered.hasMoreBefore).toBe(true);
    expect(centered.hasMoreAfter).toBe(true);
  });

  it("bounds content only when asked, and never the centered row", () => {
    const long = "x".repeat(50);
    const entries = [
      entry("m1", null, textMessage("user", long)),
      entry("m2", "m1", textMessage("assistant", long)),
    ];
    const bounded = projectOmpHistory(entries, "m2", { sessionId: "s", contentLimit: 10 });
    expect(bounded.messages.map((message) => message.content)).toEqual(["x".repeat(10), "x".repeat(10)]);

    const centered = projectOmpHistory(entries, "m2", {
      sessionId: "s",
      contentLimit: 10,
      messageAround: "omp:s:entry:m2",
    });
    expect(centered.messages[1]?.content).toBe(long);
  });

  it("treats a session with no entries as empty, and nothing else", () => {
    expect(projectOmpHistory([], null, { sessionId: "s" })).toMatchObject({
      messages: [],
      messageCount: 0,
      messageStart: 0,
      messageEnd: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it("fails closed on a malformed transcript instead of returning a partial page", () => {
    const message = textMessage("user", "hello");
    expect(() => projectOmpHistory("nope", null, { sessionId: "s" })).toThrow(OmpHistoryError);
    expect(() => projectOmpHistory([null], null, { sessionId: "s" })).toThrow(OmpHistoryError);
    expect(() => projectOmpHistory([{ parentId: null, type: "message" }], null, { sessionId: "s" })).toThrow(OmpHistoryError);
    expect(() => projectOmpHistory([{ id: "a", parentId: 7, type: "message" }], null, { sessionId: "s" })).toThrow(OmpHistoryError);
    expect(() =>
      projectOmpHistory(
        [entry("a", null, message), entry("a", "a", message)],
        "a",
        { sessionId: "s" },
      ),
    ).toThrow(/two entries with the id a/);
    expect(() => projectOmpHistory([entry("a", "missing", message)], "a", { sessionId: "s" })).toThrow(/parent missing is missing/);
    expect(() =>
      projectOmpHistory([entry("a", "b", message), entry("b", "a", message)], "a", { sessionId: "s" }),
    ).toThrow(/loops/);
    expect(() => projectOmpHistory([entry("a", null, message)], "other", { sessionId: "s" })).toThrow(/leaf other/);
    expect(() => projectOmpHistory([], "leaf", { sessionId: "s" })).toThrow(OmpHistoryError);
  });

  it("honours an explicit null leaf as an empty active branch", () => {
    const entries = [
      entry("m1", null, textMessage("user", "hello")),
      entry("m2", "m1", textMessage("assistant", "hi")),
    ];
    // `leafId: null` is the runtime reporting no active branch (its
    // `resetLeaf`): the pinned context builder renders exactly that as no
    // messages, and the last stored entry must never be resurrected as the tip.
    expect(projectOmpHistory(entries, null, { sessionId: "s" })).toMatchObject({
      messages: [],
      entryIds: [],
      messageCount: 0,
      messageStart: 0,
      messageEnd: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it("refuses a missing or malformed leaf instead of guessing the last entry", () => {
    const entries = [
      entry("m1", null, textMessage("user", "hello")),
      entry("m2", "m1", textMessage("assistant", "hi")),
    ];
    for (const leaf of [undefined, "", 7, { id: "m2" }, ["m2"]]) {
      expect(() => projectOmpHistory(entries, leaf, { sessionId: "s" })).toThrow(/leaf is missing or malformed/);
    }
  });

  it("skips non-message entries and unrecognised roles without dropping the branch", () => {
    const entries = [
      { id: "meta", parentId: null, type: "thinking_level_change", timestamp: t },
      entry("m1", "meta", textMessage("user", "hello")),
      entry("m2", "m1", textMessage("custom", "not a desktop row")),
      entry("m3", "m2", textMessage("assistant", "hi")),
    ];
    const projection = projectOmpHistory(entries, "m3", { sessionId: "s" });
    expect(projection.messages.map((message) => message.content)).toEqual(["hello", "hi"]);
    // Off-role entries are not rows, but they stay part of the branch walk.
    expect(projection.messageCount).toBe(2);
  });
});
