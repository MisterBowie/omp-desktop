/**
 * The gate's decision table, and the one thing that must never drift: what the
 * gate sends is what the desktop classifies as an approval.
 *
 * The dialog the gate builds is fed straight into the desktop's classifier, so
 * a change to either side that breaks the contract fails here (the same tests
 * that M1's experiments justified with a real runtime — E04/E10).
 */
import { describe, expect, it } from "vitest";

import {
  buildApprovalDialog,
  decideToolCall,
  parseGatedTools,
  type ExtensionAPI,
} from "../../extensions/omp-desktop-gate.ts";
import { classifyUiRequest } from "./ui-requests.js";
import { OMP_APPROVAL_OPTIONS } from "./approval-protocol.js";

const EVENT = {
  type: "tool_call" as const,
  toolCallId: "call_fake_1_0",
  toolName: "write",
  input: { path: "/tmp/project/guarded.txt", content: "x" },
};

const CONTEXT = {
  cwd: "/tmp/project",
  sessionManager: { getSessionId: () => "omp-session-1", getCwd: () => "/tmp/project" },
  hasUI: true,
};

function policy(overrides: Partial<Parameters<typeof decideToolCall>[2]> = {}) {
  return {
    gated: new Set(["write", "bash"]),
    mode: "ask" as const,
    timeoutMs: 1_000,
    sessionAllowed: new Set<string>(),
    ...overrides,
  };
}

describe("what the gate sends", () => {
  it("carries a descriptor the desktop reads as an approval", () => {
    const dialog = buildApprovalDialog(EVENT, CONTEXT, 1_000);
    expect(dialog.options).toEqual([...OMP_APPROVAL_OPTIONS]);
    // Mirror `requestRpcSelect` exactly: labels come from the items, and a
    // non-empty description becomes `optionDetails[index]`.
    const optionDetails = dialog.items.map((item) => ({
      ...(item.description ? { description: item.description } : {}),
    }));
    const classified = classifyUiRequest({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: dialog.title,
      options: dialog.options,
      optionDetails,
    });
    expect(classified).toMatchObject({
      kind: "approval",
      source: "gate",
      descriptor: {
        toolCallId: EVENT.toolCallId,
        toolName: "write",
        risk: "high",
        cwd: "/tmp/project",
        sessionId: "omp-session-1",
      },
    });
  });

  it("preserves the arguments exactly as the hook received them", () => {
    const dialog = buildApprovalDialog(EVENT, CONTEXT, 1_000);
    const descriptor = JSON.parse(dialog.items[0]!.description!);
    expect(descriptor.argsPreview).toEqual(EVENT.input);
  });

  it("summarises the target for the user without using it for decisions", () => {
    expect(buildApprovalDialog(EVENT, CONTEXT, 1_000).title).toBe("write: /tmp/project/guarded.txt");
    expect(
      buildApprovalDialog(
        { ...EVENT, toolName: "bash", input: { command: "rm -rf /tmp/x" } },
        CONTEXT,
        1_000,
      ).title,
    ).toBe("bash: rm -rf /tmp/x");
  });
});

describe("decisions", () => {
  it("allows exactly the option the user chose", async () => {
    const allowed = await decideToolCall(EVENT, { ...CONTEXT, ui: { select: async () => OMP_APPROVAL_OPTIONS[0] } }, policy());
    expect(allowed).toMatchObject({ block: false, route: "allow-once" });
  });

  it("denies when the user picked deny", async () => {
    const denied = await decideToolCall(EVENT, { ...CONTEXT, ui: { select: async () => OMP_APPROVAL_OPTIONS[2] } }, policy());
    expect(denied).toMatchObject({ block: true, route: "deny" });
    expect(denied.reason).toMatch(/denied by user/);
  });

  it("denies when the dialog is cancelled or times out", async () => {
    const cancelled = await decideToolCall(EVENT, { ...CONTEXT, ui: { select: async () => undefined } }, policy());
    expect(cancelled).toMatchObject({ block: true, route: "deny" });
    expect(cancelled.reason).toMatch(/no answer/);
  });

  it("denies when the dialog itself fails", async () => {
    const failed = await decideToolCall(
      EVENT,
      {
        ...CONTEXT,
        ui: {
          select: async () => {
            throw new Error("channel closed");
          },
        },
      },
      policy(),
    );
    expect(failed).toMatchObject({ block: true, route: "dialog-error" });
    expect(failed.reason).toMatch(/channel closed/);
  });

  it("denies when the session has no UI at all", async () => {
    const headless = await decideToolCall(EVENT, { ...CONTEXT, hasUI: false, ui: undefined }, policy());
    expect(headless).toMatchObject({ block: true, route: "no-ui" });
  });

  it("remembers a session-scoped allow for that tool only", async () => {
    let prompts = 0;
    const context = {
      ...CONTEXT,
      ui: {
        select: async (title: string) => {
          prompts += 1;
          // The write call is granted for the session; the bash call is denied,
          // which is what proves the grant did not leak to another tool.
          return title.startsWith("write") ? OMP_APPROVAL_OPTIONS[1] : OMP_APPROVAL_OPTIONS[2];
        },
      },
    };
    const policyState = policy();
    const first = await decideToolCall(EVENT, context, policyState);
    const second = await decideToolCall({ ...EVENT, toolCallId: "call_fake_1_1" }, context, policyState);
    const other = await decideToolCall({ ...EVENT, toolName: "bash", input: { command: "ls" } }, context, policyState);
    expect(first).toMatchObject({ block: false, route: "allow-session" });
    expect(second).toMatchObject({ block: false, route: "session-allow" });
    expect(prompts).toBe(2);
    expect(other).toMatchObject({ block: true, route: "deny" });
  });

  it("does not gate what the policy does not name", async () => {
    const read = await decideToolCall(
      { ...EVENT, toolName: "read", input: { path: "/etc/hosts" } },
      CONTEXT,
      policy(),
    );
    expect(read).toMatchObject({ block: false, route: "not-gated" });
  });

  it("blocks everything gated in deny mode, without asking", async () => {
    let asked = false;
    const denied = await decideToolCall(
      EVENT,
      {
        ...CONTEXT,
        ui: {
          select: async () => {
            asked = true;
            return OMP_APPROVAL_OPTIONS[0];
          },
        },
      },
      policy({ mode: "deny" }),
    );
    expect(denied).toMatchObject({ block: true, route: "mode-deny" });
    expect(asked).toBe(false);
  });
});

describe("policy parsing", () => {
  it("defaults to the dangerous tools and honours an explicit list", () => {
    expect([...parseGatedTools(undefined)]).toEqual(["write", "edit", "apply_patch", "bash", "eval"]);
    expect([...parseGatedTools(" write , bash ")]).toEqual(["write", "bash"]);
    expect([...parseGatedTools("")]).toEqual([]);
  });
});

describe("registration", () => {
  it("registers one tool_call handler that blocks through the decision table", async () => {
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const pi = {
      on: (_event: "tool_call", handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.push(handler);
      },
    } satisfies ExtensionAPI;
    const module = await import("../../extensions/omp-desktop-gate.ts");
    module.default(pi);
    expect(handlers).toHaveLength(1);
    const blocked = await handlers[0]!(EVENT, { ...CONTEXT, hasUI: false, ui: undefined });
    expect(blocked).toMatchObject({ block: true });
  });
});
