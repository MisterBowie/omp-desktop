/**
 * Strictness of the subagent frame and RPC-payload validation.
 *
 * The pinned runtime's subagent facts travel in three frame families plus two
 * read responses. Every one is validated before it is consumed: a malformed or
 * ownership-ambiguous frame must be rejected (returned as null) rather than
 * cast, so the caller can count it instead of attributing a child's work to
 * the parent session.
 */
import { describe, expect, it } from "vitest";

import {
  SUBAGENT_MAX_ENTRIES,
  normalizeFromByte,
  parseSubagentEventFrame,
  parseSubagentLifecycleFrame,
  parseSubagentMessages,
  parseSubagentProgressFrame,
  parseSubagentSnapshots,
  subagentFrameKind,
  validateSubagentMessages,
} from "./subagent-frames.js";

function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    type: "subagent_lifecycle",
    payload: {
      id: "child-1",
      agent: "scout",
      agentSource: "bundled",
      status: "started",
      index: 0,
      parentToolCallId: "call-task-1",
      ...overrides,
    },
  };
}

function progress(overrides: Record<string, unknown> = {}) {
  return {
    type: "subagent_progress",
    payload: {
      index: 0,
      agent: "scout",
      agentSource: "bundled",
      task: "report ALPHA",
      parentToolCallId: "call-task-1",
      progress: { index: 0, id: "child-1", agent: "scout", agentSource: "bundled", status: "running", task: "report ALPHA" },
      ...overrides,
    },
  };
}

describe("subagent frame classification", () => {
  it("recognises the three frame families and ignores others", () => {
    expect(subagentFrameKind(lifecycle())).toBe("subagent_lifecycle");
    expect(subagentFrameKind(progress())).toBe("subagent_progress");
    expect(subagentFrameKind({ type: "subagent_event", payload: { id: "c", event: { type: "agent_start" } } })).toBe("subagent_event");
    expect(subagentFrameKind({ type: "message_start" })).toBeNull();
    expect(subagentFrameKind(null)).toBeNull();
    expect(subagentFrameKind({ type: "subagent_lifecycle", payload: null })).toBe("subagent_lifecycle");
  });
});

describe("subagent_lifecycle validation", () => {
  it("parses a well-formed started frame", () => {
    const frame = parseSubagentLifecycleFrame(lifecycle());
    expect(frame?.payload.id).toBe("child-1");
    expect(frame?.payload.parentToolCallId).toBe("call-task-1");
    expect(frame?.payload.status).toBe("started");
  });

  it("rejects a missing child id", () => {
    expect(parseSubagentLifecycleFrame(lifecycle({ id: undefined }))).toBeNull();
  });

  it("rejects an empty child id", () => {
    expect(parseSubagentLifecycleFrame(lifecycle({ id: "" }))).toBeNull();
  });

  it("rejects an unknown lifecycle status", () => {
    expect(parseSubagentLifecycleFrame(lifecycle({ status: "timed_out" }))).toBeNull();
  });

  it("rejects a non-string parentToolCallId", () => {
    expect(parseSubagentLifecycleFrame(lifecycle({ parentToolCallId: 42 }))).toBeNull();
  });

  it("rejects a missing payload", () => {
    expect(parseSubagentLifecycleFrame({ type: "subagent_lifecycle" })).toBeNull();
  });
});

describe("subagent_progress validation", () => {
  it("parses a well-formed progress frame", () => {
    const frame = parseSubagentProgressFrame(progress());
    expect(frame?.payload.progress.id).toBe("child-1");
    expect(frame?.payload.progress.status).toBe("running");
  });

  it("rejects a progress payload without its progress object", () => {
    const raw = progress();
    delete (raw.payload as Record<string, unknown>).progress;
    expect(parseSubagentProgressFrame(raw)).toBeNull();
  });

  it("rejects an unknown progress status", () => {
    const raw = progress();
    (raw.payload.progress as Record<string, unknown>).status = "bogus";
    expect(parseSubagentProgressFrame(raw)).toBeNull();
  });
});

describe("subagent_event validation", () => {
  it("parses a well-formed event frame", () => {
    const frame = parseSubagentEventFrame({ type: "subagent_event", payload: { id: "child-1", event: { type: "message_start", message: {} } } });
    expect(frame?.payload.id).toBe("child-1");
    expect(frame?.payload.event.type).toBe("message_start");
  });

  it("rejects an event whose payload lacks an event", () => {
    expect(parseSubagentEventFrame({ type: "subagent_event", payload: { id: "child-1" } })).toBeNull();
  });

  it("rejects an event with a non-string child id", () => {
    expect(parseSubagentEventFrame({ type: "subagent_event", payload: { id: 7, event: { type: "agent_start" } } })).toBeNull();
  });
});

describe("get_subagents snapshot validation", () => {
  const snapshot = () => ({
    id: "child-1",
    index: 0,
    agent: "scout",
    agentSource: "bundled",
    status: "running",
    lastUpdate: 1,
    parentToolCallId: "call-task-1",
  });

  it("parses a well-formed snapshot list", () => {
    expect(parseSubagentSnapshots({ subagents: [snapshot()] })).toHaveLength(1);
  });

  it("rejects a snapshot list with a malformed row", () => {
    expect(parseSubagentSnapshots({ subagents: [snapshot(), { id: "child-2", index: 1, agent: "", agentSource: "bundled", status: "running", lastUpdate: 1 }] })).toBeNull();
  });

  it("rejects a non-array subagents field", () => {
    expect(parseSubagentSnapshots({ subagents: "nope" })).toBeNull();
    expect(parseSubagentSnapshots(null)).toBeNull();
  });
});

describe("get_subagent_messages validation", () => {
  const messages = () => ({ sessionFile: "/tmp/x.jsonl", fromByte: 0, nextByte: 10, reset: false, entries: [], messages: [] });

  it("parses a well-formed result", () => {
    expect(parseSubagentMessages(messages())?.nextByte).toBe(10);
  });

  it("rejects a result missing the session file", () => {
    const raw = messages();
    delete (raw as Record<string, unknown>).sessionFile;
    expect(parseSubagentMessages(raw)).toBeNull();
  });

  it("rejects a negative cursor", () => {
    expect(parseSubagentMessages({ ...messages(), fromByte: -1 })).toBeNull();
  });

  it("distinguishes over-limit and inconsistent-cursor results", () => {
    const overLimit = validateSubagentMessages({
      ...messages(),
      entries: new Array(SUBAGENT_MAX_ENTRIES + 1).fill({}),
    });
    expect(overLimit).toEqual({ ok: false, reason: "over-limit" });

    const badCursor = validateSubagentMessages({ ...messages(), fromByte: 10, nextByte: 3 });
    expect(badCursor).toEqual({ ok: false, reason: "invalid-cursor" });

    const ok = validateSubagentMessages(messages());
    expect(ok.ok).toBe(true);
  });
});

describe("normalizeFromByte", () => {
  it("accepts and truncates finite non-negative numbers", () => {
    expect(normalizeFromByte(3.9)).toBe(3);
    expect(normalizeFromByte(0)).toBe(0);
  });

  it("clamps negatives and non-numbers to zero", () => {
    expect(normalizeFromByte(-5)).toBe(0);
    expect(normalizeFromByte("10")).toBe(0);
    expect(normalizeFromByte(undefined)).toBe(0);
    expect(normalizeFromByte(Number.NaN)).toBe(0);
  });
});
