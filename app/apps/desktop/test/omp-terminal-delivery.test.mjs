import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * M5/T20-D: terminal agent events from an engine whose runtime owns its own
 * turn generations (OMP) must reach the renderer.
 *
 * The fan-out's default guard drops a terminal event whose turn does not own
 * the session according to the *Pi* turn map. An OMP session never has a Pi
 * entry, so the guard dropped every OMP `agent_end`/`error`: the renderer kept
 * a finished turn "running", and a rejected plan could not be resubmitted from
 * the composer (the send was queued behind a turn that no longer existed).
 * The OMP wiring passes `guardPiTurnOwnership: false`; the Pi guard itself
 * must stay intact.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { createAgentEventFanout } = await import("../electron/main/runtime/agent-event-fanout.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");

function fanoutHarness({ activeTurns = new Map() } = {}) {
  const delivered = [];
  const ingested = [];
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  const emit = createAgentEventFanout({
    isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    ingest: (envelope) => ingested.push(envelope),
    send: (envelope) => delivered.push(envelope),
  });
  return { emit, delivered, ingested };
}

const envelope = (overrides = {}) => ({
  sessionId: "session-1",
  turnId: "durable-turn-1",
  ts: 1,
  event: { type: "agent_end", messageIds: [] },
  ...overrides,
});

test("an OMP terminal event is delivered even though the Pi turn map has no entry", () => {
  const { emit, delivered, ingested } = fanoutHarness({ activeTurns: new Map() });
  const terminal = envelope({ sessionId: "omp-session", turnId: "omp-turn:omp-session:gen:1" });

  // The default would classify this as stale: the session has no Pi turn, and
  // the OMP live-turn id can never equal a durable Pi turn id.
  emit(terminal);
  assert.deepEqual(delivered, [], "the Pi guard still drops it (the defect this seam exists for)");

  emit(terminal, { guardPiTurnOwnership: false });
  assert.equal(delivered.length, 1, "the OMP wiring's unguarded emit delivers the terminal");
  assert.equal(delivered[0], terminal);
  assert.deepEqual(ingested, [terminal], "the Agent Host bridge still ingests it");
});

test("the Pi ownership guard still drops stale terminals and keeps live ones", () => {
  const activeTurns = new Map([["pi-session", "durable-turn-live"]]);
  const { emit, delivered } = fanoutHarness({ activeTurns });

  emit(envelope({ sessionId: "pi-session", turnId: "durable-turn-live" }));
  assert.equal(delivered.length, 1, "the live Pi turn's terminal is delivered");

  emit(envelope({ sessionId: "pi-session", turnId: "durable-turn-old" }));
  assert.equal(delivered.length, 1, "an older Pi turn's terminal stays dropped");

  emit(
    envelope({
      sessionId: "pi-session",
      turnId: "durable-turn-live",
      parentToolCallId: "delegate-call",
    }),
  );
  assert.equal(delivered.length, 1, "a delegate's terminal never ends its parent's turn");

  // Non-terminal events are never filtered.
  emit({
    sessionId: "pi-session",
    turnId: "durable-turn-old",
    ts: 2,
    event: { type: "message_end", message: { id: "m1", role: "assistant", content: "x" } },
  });
  assert.equal(delivered.length, 2, "a non-terminal event from an old turn still reaches the UI");
});
