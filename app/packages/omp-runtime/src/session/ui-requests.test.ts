/**
 * Classification and decision rules for the runtime's dialog channel.
 *
 * These are the tests that stand behind "a decision authorises at most one
 * execution": every case here is a way for a second, stale or malformed answer
 * to reach a tool call that must not run.
 */
import { describe, expect, it } from "vitest";

import { encodeApprovalDescriptor, OMP_APPROVAL_OPTIONS } from "./approval-protocol.js";
import {
  OmpUiRequests,
  classifyUiRequest,
  responseFor,
  type OmpUiRequest,
  type OmpUiResponseFrame,
} from "./ui-requests.js";

const DESCRIPTOR = {
  v: 1,
  kind: "omp-desktop-approval" as const,
  sessionId: "omp-1",
  toolCallId: "call_fake_1_0",
  toolName: "write",
  risk: "high" as const,
  reason: "write: /tmp/guarded.txt",
  argsPreview: { path: "/tmp/guarded.txt", content: "x" },
  cwd: "/tmp/project",
};

function gateApprovalFrame(id = "ui-1") {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: "write: /tmp/guarded.txt",
    options: [...OMP_APPROVAL_OPTIONS],
    optionDetails: [{ description: encodeApprovalDescriptor(DESCRIPTOR) }, {}, {}],
  };
}

function harness() {
  const written: OmpUiResponseFrame[] = [];
  const requests = new OmpUiRequests({
    sessionId: "omp-1",
    write: (frame) => {
      written.push(frame);
      return true;
    },
    now: () => 1_000,
  });
  return { requests, written };
}

describe("classification", () => {
  it("recognises our gate's approval by its descriptor, not by its wording", () => {
    const classified = classifyUiRequest(gateApprovalFrame());
    expect(classified).toMatchObject({
      kind: "approval",
      source: "gate",
      frameId: "ui-1",
      descriptor: { toolCallId: "call_fake_1_0", toolName: "write", risk: "high" },
    });
  });

  it("recognises the runtime's own approval prompt by its exact option tuple", () => {
    const classified = classifyUiRequest({
      type: "extension_ui_request",
      id: "ui-2",
      method: "select",
      title: "Approve write to /etc/hosts?",
      options: ["Approve", "Deny"],
    });
    expect(classified).toMatchObject({ kind: "approval", source: "runtime", descriptor: null });
  });

  it("treats a title that merely mentions approval as a question", () => {
    // The wording is not the discriminator: only the descriptor or the exact
    // native tuple decides.
    const classified = classifyUiRequest({
      type: "extension_ui_request",
      id: "ui-3",
      method: "select",
      title: "Approve this plan?",
      options: ["Yes", "No"],
    });
    expect(classified).toMatchObject({ kind: "question", method: "select" });
  });

  it("accepts a descriptor that arrives on a confirm dialog", () => {
    const classified = classifyUiRequest({
      type: "extension_ui_request",
      id: "ui-4",
      method: "confirm",
      title: "write: /tmp/guarded.txt",
      message: encodeApprovalDescriptor(DESCRIPTOR),
    });
    expect(classified).toMatchObject({ kind: "approval", source: "gate" });
  });

  it("rejects a descriptor from another product or version", () => {
    const foreign = JSON.stringify({ ...DESCRIPTOR, kind: "someone-else" });
    expect(
      classifyUiRequest({
        type: "extension_ui_request",
        id: "ui-5",
        method: "confirm",
        title: "t",
        message: foreign,
      }),
    ).toMatchObject({ kind: "question" });
    const future = JSON.stringify({ ...DESCRIPTOR, v: 99 });
    expect(
      classifyUiRequest({
        type: "extension_ui_request",
        id: "ui-6",
        method: "confirm",
        title: "t",
        message: future,
      }),
    ).toMatchObject({ kind: "question" });
  });

  it("keeps questions, retractions, notices and unknown kinds apart", () => {
    expect(
      classifyUiRequest({ type: "extension_ui_request", id: "a", method: "select", title: "pick", options: ["A"] }),
    ).toMatchObject({ kind: "question", method: "select" });
    expect(
      classifyUiRequest({ type: "extension_ui_request", id: "b", method: "confirm", title: "sure?", message: "m" }),
    ).toMatchObject({ kind: "question", method: "confirm" });
    expect(
      classifyUiRequest({ type: "extension_ui_request", id: "c", method: "input", title: "name" }),
    ).toMatchObject({ kind: "question", method: "input" });
    expect(
      classifyUiRequest({ type: "extension_ui_request", id: "d", method: "cancel", targetId: "a" }),
    ).toMatchObject({ kind: "cancel", targetId: "a" });
    expect(
      classifyUiRequest({ type: "extension_ui_request", id: "e", method: "notify", message: "hi" }),
    ).toMatchObject({ kind: "notice" });
    expect(
      classifyUiRequest({ type: "extension_ui_request", id: "f", method: "customThing" }),
    ).toMatchObject({ kind: "unsupported", method: "customThing" });
  });
});

describe("approval decisions", () => {
  it("answers an allow with the label the gate expects", () => {
    const { requests, written } = harness();
    const request = requests.observe(gateApprovalFrame())!;
    const result = requests.resolve("ui-1", "allow-once");
    expect(result.ok).toBe(true);
    expect(written).toEqual([
      { type: "extension_ui_response", id: "ui-1", value: OMP_APPROVAL_OPTIONS[0] },
    ]);
    expect(request.kind).toBe("approval");
  });

  it("answers a deny with the deny label", () => {
    const { requests, written } = harness();
    requests.observe(gateApprovalFrame());
    requests.resolve("ui-1", "deny");
    expect(written[0]).toMatchObject({ value: OMP_APPROVAL_OPTIONS[2] });
  });

  it("answers the runtime's own prompt with the runtime's own labels", () => {
    const { requests, written } = harness();
    requests.observe({
      type: "extension_ui_request",
      id: "ui-2",
      method: "select",
      title: "Approve?",
      options: ["Approve", "Deny"],
    });
    requests.resolve("ui-2", "deny");
    expect(written[0]).toMatchObject({ value: "Deny" });
  });

  it("refuses a second decision for the same request", () => {
    const { requests, written } = harness();
    requests.observe(gateApprovalFrame());
    expect(requests.resolve("ui-1", "allow-once").ok).toBe(true);
    const second = requests.resolve("ui-1", "allow-once");
    expect(second).toMatchObject({ ok: false, reason: "duplicate" });
    expect(written).toHaveLength(1);
    expect(requests.records().at(-1)).toMatchObject({ outcome: "refused-duplicate" });
  });

  it("refuses a decision for a request nobody raised", () => {
    const { requests, written } = harness();
    const result = requests.resolve("nope", "allow-once");
    expect(result).toMatchObject({ ok: false, reason: "unknown" });
    expect(written).toEqual([]);
    expect(requests.records().at(-1)).toMatchObject({ outcome: "refused-unknown" });
  });

  it("refuses a decision that belongs to a superseded run", () => {
    const { requests, written } = harness();
    const generation = requests.beginRun();
    requests.observe(gateApprovalFrame());
    const result = requests.resolve("ui-1", "allow-once", { generation: generation + 1 });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
    expect(written).toEqual([]);
    // The request is still open: the user can still answer it correctly.
    expect(requests.open()).toHaveLength(1);
  });

  it("cancels every pending request when the run stops", () => {
    const { requests, written } = harness();
    requests.observe(gateApprovalFrame("ui-1"));
    requests.observe(gateApprovalFrame("ui-2"));
    expect(requests.cancelPending("the run was stopped", { timedOut: false })).toEqual([
      "ui-1",
      "ui-2",
    ]);
    expect(written).toEqual([
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
      { type: "extension_ui_response", id: "ui-2", cancelled: true },
    ]);
    // Nothing is left waiting, and a late decision cannot revive it.
    expect(requests.open()).toEqual([]);
    expect(requests.resolve("ui-1", "allow-once")).toMatchObject({ ok: false, reason: "duplicate" });
    expect(written).toHaveLength(2);
  });

  it("answers an unknown dialog method with the fail-closed value", () => {
    const { requests, written } = harness();
    requests.observe({ type: "extension_ui_request", id: "ui-9", method: "brandNewThing" });
    expect(written).toEqual([{ type: "extension_ui_response", id: "ui-9", cancelled: true }]);
    expect(requests.open()).toEqual([]);
  });

  it("drops a retracted request without answering it", () => {
    const { requests, written } = harness();
    requests.observe(gateApprovalFrame("ui-1"));
    requests.observe({ type: "extension_ui_request", id: "ui-2", method: "cancel", targetId: "ui-1" });
    expect(requests.open()).toEqual([]);
    expect(written).toEqual([]);
    expect(requests.resolve("ui-1", "allow-once")).toMatchObject({ ok: false });
  });

  it("does not report success when the runtime is already gone", () => {
    const written: OmpUiResponseFrame[] = [];
    const requests = new OmpUiRequests({
      sessionId: "omp-1",
      write: (frame) => {
        written.push(frame);
        return false;
      },
    });
    requests.observe(gateApprovalFrame());
    expect(requests.resolve("ui-1", "allow-once")).toMatchObject({ ok: false, reason: "stale" });
    expect(requests.open()).toEqual([]);
  });
});

describe("question answers", () => {
  it("answers a select with the chosen option", () => {
    const { requests, written } = harness();
    const request = requests.observe({
      type: "extension_ui_request",
      id: "q-1",
      method: "select",
      title: "Which file?",
      options: ["a.ts", "b.ts"],
    }) as OmpUiRequest;
    expect(request.kind).toBe("question");
    requests.resolve("q-1", "allow-once");
    expect(written[0]).toMatchObject({ value: "a.ts" });
  });

  it("answers a confirm as a boolean", () => {
    const { requests, written } = harness();
    requests.observe({ type: "extension_ui_request", id: "q-2", method: "confirm", title: "sure?", message: "really" });
    requests.resolve("q-2", "deny");
    expect(written[0]).toMatchObject({ confirmed: false });
  });

  it("cancels a free-text dialog it cannot present", () => {
    const { requests, written } = harness();
    requests.observe({ type: "extension_ui_request", id: "q-3", method: "input", title: "name" });
    expect(responseFor(requests.open()[0].request, "allow-once")).toMatchObject({ cancelled: true });
    expect(written).toEqual([]);
  });
});

describe("run generation lifecycle", () => {
  it("refuses a decision whose dialog belongs to an earlier run", () => {
    const { requests, written } = harness();
    requests.beginRun();
    requests.observe(gateApprovalFrame("ui-old"));
    // The run ends and a new one starts.
    requests.beginRun();
    const late = requests.resolve("ui-old", "allow-once");
    expect(late).toMatchObject({ ok: false, reason: "stale" });
    expect(written).toEqual([]);
    expect(requests.records().at(-1)).toMatchObject({ outcome: "refused-stale" });
  });

  it("cancels one dialog by id, and reports the ids it cancelled", () => {
    const { requests, written } = harness();
    requests.observe(gateApprovalFrame("ui-1"));
    requests.observe(gateApprovalFrame("ui-2"));
    expect(requests.cancel("ui-1", "the user skipped the question")).toBe(true);
    expect(written).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
    expect(requests.open().map((entry) => entry.requestId)).toEqual(["ui-2"]);
    expect(requests.cancel("ui-1", "again")).toBe(false);
    expect(written).toHaveLength(1);
    expect(requests.cancelPending("stopped")).toEqual(["ui-2"]);
  });
});
