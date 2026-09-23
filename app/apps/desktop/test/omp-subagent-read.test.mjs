import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("../../../packages/shared/src/protocol.ts");
const { resolveChildId, buildSubagentRun, fetchOmpSubagentDetail } = await import(
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
    assert.equal(result.kind, "ready");
    assert.equal(result.run.items.length, 1);
    assert.equal(result.cursor.nextByte, 12);
    assert.deepEqual(
      calls.map((call) => call.channel),
      [IPC.invoke.ompSubagentList, IPC.invoke.ompSubagentRead],
    );
  } finally {
    globalThis.window = previous;
  }
});

test("fetchOmpSubagentDetail reports empty when the child has no readable rows", async () => {
  const result = await fetchOmpSubagentDetail(
    {
      list: async () => [{ id: "child-1" }],
      read: async () => ({ cursor: { fromByte: 0, nextByte: 0, reset: false }, messages: [] }),
    },
    "s1",
    "child-1",
  );
  assert.equal(result.kind, "empty");
});
