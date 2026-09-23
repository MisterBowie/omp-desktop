import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");

/**
 * R3 regression: a terminal OMP lifecycle settlement refreshes the parent Task
 * row, and that refresh must persist as a *root* row (no `parentToolCallId`),
 * or reload would drop the Task card from the root transcript. Child rows still
 * carry `parentToolCallId` and stay attached to that card.
 *
 * The runner's `emitSynthesis` now separates "owning task call" (turn recovery)
 * from "child row" (envelope `parentToolCallId`): a settlement envelope has the
 * former, never the latter. This test drives the real `subagentTagged` (the
 * event-persistence stamping function) and the real transcript projection.
 */

function minimalPersistence() {
  return createEventPersistence({
    runtimeState: { host: null },
    steeringReplies: new Set(),
    activeTurns: new Map(),
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    approvedExecutionIdsBySession: new Map(),
    approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(),
    planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: () => "",
    inflightCheckpointer: { observe: () => {}, flush: async () => {}, settleIf: () => {} },
    persistenceOutbox: { enqueue: async () => {}, size: () => 0, flush: async () => {}, dropSession: async () => {} },
    addActiveTurnUsage: () => {},
    logger: { app: () => {} },
    finishTurn: async () => {},
    isStaleTerminalEvent: () => false,
    finishApprovedExecution: async () => {},
    emitAgentEvent: () => {},
  });
}

const taskRow = {
  id: "task-call",
  role: "tool",
  content: "Delegation child-1: completed.",
  createdAt: "2026-09-23T00:00:00.000Z",
  toolCallId: "task-call",
  toolName: "task",
  toolStatus: "success",
  toolResult: { content: [{ type: "text", text: "done" }], details: { delegationId: "child-1", status: "completed" } },
  status: "complete",
  isError: false,
};

const childRow = {
  id: "child-row",
  role: "assistant",
  content: "child answer",
  createdAt: "2026-09-23T00:00:01.000Z",
  status: "complete",
};

test("a settlement without parentToolCallId persists as a root Task row and stays visible on reload", () => {
  const { subagentTagged } = minimalPersistence();
  // The fixed settlement envelope carries only the owning task identity via
  // agentName/turnId; it has no parentToolCallId (that would mark it a child).
  const tagged = subagentTagged(taskRow, {
    sessionId: "session",
    turnId: "turn-1",
    ts: 1000,
    event: { type: "message_end", message: taskRow },
    agentName: "task",
  });
  assert.equal(tagged.parentToolCallId, undefined, "a settlement must not become a child row");
  assert.equal(tagged.id, "task-call", "the settlement keeps the Task row id");

  const { visible } = buildTranscriptEntries([tagged]);
  assert.ok(visible.some((m) => m.id === "task-call"), "the Task card must remain visible after reload");
});

test("child rows keep their parentToolCallId and stay attached to the Task card", () => {
  const { subagentTagged } = minimalPersistence();
  const taggedChild = subagentTagged(childRow, {
    sessionId: "session",
    turnId: "turn-1",
    ts: 1001,
    event: { type: "message_end", message: childRow },
    parentToolCallId: "task-call",
    agentName: "task",
  });
  assert.equal(taggedChild.parentToolCallId, "task-call");

  const { visible, entries } = buildTranscriptEntries([taskRow, taggedChild]);
  // The Task card is a root row; the child row is not.
  assert.ok(visible.some((m) => m.id === "task-call"), "the Task card is visible");
  assert.ok(!visible.some((m) => m.id === "child-row"), "the child row is not a root row");

  // The child row is attached to the Task card's delegate run.
  const delegateItems = entries.flatMap((entry) =>
    entry.kind === "assistant-turn"
      ? entry.parts.flatMap((part) =>
          part.kind === "activity"
            ? part.items.flatMap((item) => (item.kind === "tool" && item.delegate ? item.delegate.items.map((run) => run.message.id) : []))
            : [],
        )
      : [],
  );
  assert.ok(delegateItems.includes("child-row"), "the child row must be attached to the Task card's delegate run");
});
