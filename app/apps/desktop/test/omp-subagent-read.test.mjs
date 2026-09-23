import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("../../../packages/shared/src/protocol.ts");
const { resolveChildId, buildSubagentRun, fetchOmpSubagentDetail, mergeSubagentMessages } = await import(
  "../src/lib/omp-subagent-read.ts"
);

test("resolveChildId matches an opaque id or a parent task call", () => {
  const list = [
    { id: "child-1", parentToolCallId: "task-1" },
    { id: "child-2", parentToolCallId: "task-1" },
  ];
  assert.equal(resolveChildId(list, "child-1"), "child-1");
  assert.equal(resolveChildId(list, "task-1"), "child-1");
  assert.equal(resolveChildId(list, "child-9"), null);
});

test("buildSubagentRun groups tool, thinking, and answer rows", () => {
  const run = buildSubagentRun([
    { id: "t", role: "tool", content: "result", toolName: "read", toolCallId: "c" },
    { id: "a", role: "assistant", content: "answer", thinking: "reason" },
  ]);
  assert.deepEqual(
    run.items.map((item) => item.kind),
    ["tool", "thinking", "answer"],
  );
});

test("mergeSubagentMessages dedups by stable id and preserves order", () => {
  const merged = mergeSubagentMessages(
    [
      { id: "a", role: "assistant", content: "first" },
      { id: "b", role: "assistant", content: "second" },
    ],
    [
      { id: "b", role: "assistant", content: "second-dup" },
      { id: "c", role: "assistant", content: "third" },
    ],
  );
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "b", "c"],
  );
  // The first occurrence wins; the duplicate row does not replace it.
  assert.equal(merged[1].content, "second");
});

test("fetchOmpSubagentDetail resolves and reads through the real api surface", async () => {
  const { api } = await import("../src/lib/api.ts");
  const previous = globalThis.window;
  const calls = [];
  try {
    globalThis.window = {
      piDesktop: {
        invoke: async (channel, ...args) => {
          calls.push({ channel, args });
          if (channel === IPC.invoke.ompSubagentList) {
            return {
              ok: true,
              data: [
                { id: "child-1", agent: "task", agentSource: "bundled", status: "running", parentToolCallId: "task-1", lastUpdate: 1 },
              ],
            };
          }
          if (channel === IPC.invoke.ompSubagentRead) {
            assert.deepEqual(args[0], { sessionId: "s1", subagentId: "child-1" });
            return {
              ok: true,
              data: {
                cursor: { fromByte: 0, nextByte: 12, reset: false },
                messages: [{ id: "entry-1", role: "assistant", content: "report ALPHA", status: "complete" }],
              },
            };
          }
          throw new Error(`unexpected channel ${channel}`);
        },
        on: () => () => {},
        platform: "linux",
      },
    };

    const result = await fetchOmpSubagentDetail(
      { list: api.listOmpSubagents, read: api.readOmpSubagent },
      "s1",
      "task-1",
    );
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, "report ALPHA");
    assert.equal(result.cursor.nextByte, 12);
    assert.deepEqual(
      calls.map((call) => call.channel),
      [IPC.invoke.ompSubagentList, IPC.invoke.ompSubagentRead],
    );
  } finally {
    globalThis.window = previous;
  }
});

test("fetchOmpSubagentDetail returns empty messages and the cursor when the child has no rows", async () => {
  const result = await fetchOmpSubagentDetail(
    {
      list: async () => [{ id: "child-1" }],
      read: async () => ({ cursor: { fromByte: 0, nextByte: 40, reset: false }, messages: [] }),
    },
    "s1",
    "child-1",
  );
  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor.nextByte, 40);
});
