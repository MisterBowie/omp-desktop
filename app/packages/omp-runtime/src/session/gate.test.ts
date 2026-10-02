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
import ompDesktopGate from "../../extensions/omp-desktop-gate.ts";
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
    const dialog = buildApprovalDialog(EVENT, CONTEXT, 1_000, {
      risk: "high",
      reason: "approval required (high risk, ask mode)",
      mode: "agent",
      permissionMode: "ask",
    });
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
    const dialog = buildApprovalDialog(EVENT, CONTEXT, 1_000, { risk: "high", reason: "approval required" });
    const descriptor = JSON.parse(dialog.items[0]!.description!);
    expect(descriptor.argsPreview).toEqual(EVENT.input);
  });

  it("summarises the target for the user without using it for decisions", () => {
    expect(
      buildApprovalDialog(EVENT, CONTEXT, 1_000, { risk: "high", reason: "approval required" }).title,
    ).toBe("write: /tmp/project/guarded.txt");
    expect(
      buildApprovalDialog(
        { ...EVENT, toolName: "bash", input: { command: "rm -rf /tmp/x" } },
        CONTEXT,
        1_000,
        { risk: "high", reason: "approval required" },
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

  it("gates desktop host tools even when the name list does not mention them", async () => {
    // The name list only tunes native tools: a plugin_*/mcp_* tool must never
    // slip past on a name, so an empty list still gates them.
    const gated = policy({ gated: new Set() });
    const plugin = await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_echo", input: { text: "hi" } },
      { ...CONTEXT, ui: { select: async () => OMP_APPROVAL_OPTIONS[0] } },
      gated,
    );
    expect(plugin).toMatchObject({ block: false, route: "allow-once" });
    const mcp = await decideToolCall(
      { ...EVENT, toolName: "mcp_stub_ping", input: {} },
      { ...CONTEXT, ui: { select: async () => OMP_APPROVAL_OPTIONS[2] } },
      gated,
    );
    expect(mcp).toMatchObject({ block: true, route: "deny" });
  });

  it("asks for a host tool before execution and cards the decision's own risk", async () => {
    let asked: string | undefined;
    let descriptor: { risk?: string; mode?: string; permissionMode?: string } | undefined;
    const verdict = await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_echo", input: { text: "hi" } },
      {
        ...CONTEXT,
        ui: {
          select: async (title: string, items: Array<{ description?: string }>) => {
            asked = title;
            descriptor = JSON.parse(items[0]!.description!) as typeof descriptor;
            return OMP_APPROVAL_OPTIONS[0];
          },
        },
      },
      policy({
        snapshot: {
          mode: "agent",
          permissionMode: "ask",
          hostTools: [
            { name: "plugin_demo_echo", risk: "high", planSafeActions: [], origin: "plugin" },
          ],
        },
      }),
    );
    expect(verdict).toMatchObject({ block: false, route: "allow-once" });
    expect(asked).toMatch(/plugin_demo_echo/);
    expect(descriptor).toMatchObject({ risk: "high", mode: "agent", permissionMode: "ask" });
  });

  it("host tools honour deny mode and allow mode like native tools", async () => {
    const denied = await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_echo", input: {} },
      CONTEXT,
      policy({ mode: "deny" }),
    );
    expect(denied).toMatchObject({ block: true, route: "mode-deny" });

    const allowed = await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_echo", input: {} },
      CONTEXT,
      policy({ mode: "allow" }),
    );
    expect(allowed).toMatchObject({ block: false, route: "mode-allow" });
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
    expect([...parseGatedTools(undefined)]).toEqual([
      "write",
      "edit",
      "apply_patch",
      "bash",
      "eval",
      "browser",
      "computer",
      "browserpreview",
    ]);
    expect([...parseGatedTools(" write , bash ")]).toEqual(["write", "bash"]);
    expect([...parseGatedTools("")]).toEqual([]);
  });
});

describe("registration", () => {
  it("registers one tool_call handler that blocks through the decision table", async () => {
    const toolCallHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const registeredEvents: string[] = [];
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        registeredEvents.push(event);
        if (event === "tool_call") toolCallHandlers.push(handler);
      },
    };
    ompDesktopGate(pi);
    // The gate registers six policies: the tool_call approval gate, the
    // before_agent_start capability injection (M5/T19-C), the two agent
    // lifecycle notifications that arm and retire the admitted turn, the
    // session_start notification that binds a delegate session to its owning
    // admission (M5/T20-C review repairs), and the tool_result handler that
    // applies a host-confirmed mode transition (M5/T20-D).
    expect(registeredEvents.sort()).toEqual([
      "agent_end",
      "agent_start",
      "before_agent_start",
      "session_start",
      "tool_call",
      "tool_result",
    ]);
    expect(toolCallHandlers).toHaveLength(1);
    const blocked = await toolCallHandlers[0]!(EVENT, { ...CONTEXT, hasUI: false, ui: undefined });
    expect(blocked).toMatchObject({ block: true });
  });
});
