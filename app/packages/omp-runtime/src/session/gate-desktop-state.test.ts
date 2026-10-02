/**
 * Probes for the gate's `before_agent_start` half of the run-scoped desktop
 * runtime state (M5/T19-C skills/memory; M5/T20-B1 mode/policy/clamp).
 *
 * The trusted gate is the single place desktop skill metadata, project
 * memory, the mode block and the contract tool catalog may enter the runtime.
 * Its behavior must be:
 *
 *   - append the capability block (skills then memory) and then the
 *     production mode block to the runtime's existing system prompt parts,
 *     never replace or drop them, with the mode block last (PI's
 *     `composeModeSystemPrompt` position) and exactly once;
 *   - inject and clamp only for the owning session (a subagent session with a
 *     different id gets nothing and keeps its tool set);
 *   - refuse the turn (`ctx.abort()`, the runtime's formal stop path) when a
 *     file claims this session but fails validation — never silently run an
 *     Agent turn;
 *   - in Plan/Goal clamp the active set to the PI contract catalog
 *     (read/grep/glob/bash/ask/new_context ∩ live, plus declared plan-safe
 *     plugin host tools) and restore the pre-clamp selection on return to
 *     Agent;
 *   - carry the effective permission mode into the approval descriptor, so
 *     the resolved policy is observably consumed by the gate.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DESKTOP_STATE_FILE,
  MAX_DESKTOP_STATE_AGE_MS,
  serializeDesktopCapabilityState,
} from "../desktop-state.js";
import ompDesktopGate, {
  applyContractToolClamp,
  beforeAgentStartPolicy,
  contractActiveToolNames,
  contractAllowsTool,
  type ExtensionAPI,
} from "../../extensions/omp-desktop-gate.ts";
import { parseApprovalDescriptor } from "../session/approval-protocol.js";
import { parseStartRefusalNotice } from "../session/start-refusal.js";
import { OMP_TURN_COMMAND, parseTurnAckNotice } from "../session/turn-fence.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OMP_DESKTOP_STATE;
  delete process.env.OMP_DESKTOP_STATE_REQUIRED;
});

function stateDir(): string {
  const dir = join("/tmp", `omp-gate-state-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

const NOW = 1_700_000_000_000;
const BASE_PROMPT = ["native part one", "native part two"];
const OWNING_SESSION = "native-session-1";
const PLAN_BLOCK = "You are operating in Plan mode as the same PI-Desktop agent.";
const AGENT_BLOCK = "You are operating in Agent mode. After the user approves a plan.";

function writeState(
  overrides: Record<string, unknown> = {},
  now = NOW,
): string {
  const dir = stateDir();
  const path = join(dir, DESKTOP_STATE_FILE);
  writeFileSync(
    path,
    serializeDesktopCapabilityState(
      {
        sessionId: OWNING_SESSION,
        mode: "plan",
        modeBlock: PLAN_BLOCK,
        permissionMode: "ask",
        skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }],
        memory: "Use the staging database.",
        hostTools: [],
        ...overrides,
      },
      now,
    ),
  );
  return path;
}

function context(sessionId: string = OWNING_SESSION) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

describe("before_agent_start policy decision", () => {
  it("appends capability first and the mode block last, byte-exact and without replacing native parts", () => {
    const path = writeState();
    const decision = beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject") return;
    expect(decision.systemPrompt.slice(0, 2)).toEqual(BASE_PROMPT);
    expect(decision.systemPrompt).toHaveLength(4);
    const capability = decision.systemPrompt[2]!;
    expect(capability).toContain("# Skills");
    expect(capability).toContain("- `demo.hello/release-notes` — Release notes: Draft release notes.");
    expect(capability).toContain("# Project memory");
    expect(capability).toContain("Use the staging database.");
    expect(decision.systemPrompt[3]).toBe(PLAN_BLOCK);
    expect(decision.state.mode).toBe("plan");
    expect(decision.state.permissionMode).toBe("ask");
  });

  it("appends only the mode block when the capability half is empty", () => {
    const path = writeState({ skills: [], memory: null });
    const decision = beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject") return;
    expect(decision.systemPrompt).toEqual([...BASE_PROMPT, PLAN_BLOCK]);
  });

  it("appends the Agent block for an Agent-mode state (the block is always the production composer output)", () => {
    const path = writeState({ mode: "agent", modeBlock: AGENT_BLOCK });
    const decision = beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    if (decision.kind !== "inject") throw new Error("expected injection");
    expect(decision.systemPrompt[decision.systemPrompt.length - 1]).toBe(AGENT_BLOCK);
    expect(decision.state.mode).toBe("agent");
  });

  it("injects nothing for a session other than the owning one, or for an absent file", () => {
    const path = writeState();
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context("other-session"), path, NOW).kind).toBe("skip");
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, { sessionManager: undefined }, path, NOW).kind).toBe("skip");
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), join(stateDir(), "absent.json"), NOW).kind).toBe("skip");
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), null, NOW).kind).toBe("skip");
  });

  it("refuses the turn when the file claims this session but fails validation", () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeFileSync(
      path,
      JSON.stringify({
        v: 2,
        sessionId: OWNING_SESSION,
        writtenAt: NOW,
        mode: "plan",
        modeBlock: PLAN_BLOCK,
        permissionMode: "ask",
        memory: null,
        skills: [],
        hostTools: [],
      }).replace('"mode":"plan"', '"mode":"chat"'),
    );
    const decision = beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toMatch(/missing or invalid/);

    // A stale owned file is equally a refusal: continuing would run the turn
    // without the current policy.
    writeFileSync(path, JSON.stringify({ v: 2, sessionId: OWNING_SESSION, writtenAt: NOW - MAX_DESKTOP_STATE_AGE_MS - 1 }));
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW).kind).toBe("refuse");
  });

  it("treats a malformed v1 file that names another session as absent, never as a refusal", () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeFileSync(path, JSON.stringify({ v: 1, sessionId: "some-other-session", mode: "plan" }));
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW).kind).toBe("skip");
  });

  it("refuses every non-owned read once the bridge marks the channel mandatory", () => {
    const interactive = () => ({ ...context(), hasUI: true });
    const required = { required: true };
    // Deleted, malformed, oversized, identity-less and out-of-schema files are
    // all "missing/unreadable" on the mandatory channel — never a silent
    // Agent turn.
    const deleted = writeState();
    rmSync(deleted);
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, interactive(), deleted, NOW, required)).toMatchObject({
      kind: "refuse",
      code: "state-missing",
    });

    for (const corrupt of ["{", "x".repeat(600 * 1024)]) {
      const path = writeState();
      writeFileSync(path, corrupt);
      expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, interactive(), path, NOW, required)).toMatchObject({
        kind: "refuse",
        code: "state-missing",
      });
    }

    const noIdentity = writeState();
    writeFileSync(noIdentity, JSON.stringify({ v: 2, mode: "plan", writtenAt: NOW }));
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, interactive(), noIdentity, NOW, required)).toMatchObject({
      kind: "refuse",
      code: "state-missing",
    });

    const unknownSchema = writeState();
    writeFileSync(unknownSchema, JSON.stringify({ v: 1, sessionId: OWNING_SESSION, mode: "plan", writtenAt: NOW }));
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, interactive(), unknownSchema, NOW, required)).toMatchObject({
      kind: "refuse",
      code: "state-invalid",
    });

    const foreign = writeState({ sessionId: "some-other-native" });
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, interactive(), foreign, NOW, required)).toMatchObject({
      kind: "refuse",
      code: "state-foreign",
    });
  });

  it("keeps the delegate zero-injection skip on a mandatory channel (hasUI=false)", () => {
    const path = writeState(); // valid, owned by the parent native session
    const delegate = { ...context("delegate-native"), hasUI: false };
    const required = { required: true };
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, delegate, path, NOW, required).kind).toBe("skip");
    expect(
      beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, delegate, join(stateDir(), "gone.json"), NOW, required)
        .kind,
    ).toBe("skip");
  });

  it("degrades explicitly without the marker, and fails closed when hasUI is unknown", () => {
    const absent = join(stateDir(), "absent.json");
    expect(beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), absent, NOW).kind).toBe("skip");
    expect(
      beforeAgentStartPolicy({ systemPrompt: [...BASE_PROMPT] }, context(), absent, NOW, { required: true }).kind,
    ).toBe("refuse");
  });
});

describe("contract tool catalog", () => {
  const hostTools = [
    { name: "plugin_demo_run", risk: "low" as const, planSafeActions: ["inspect"], origin: "plugin" as const },
    { name: "plugin_demo_write", risk: "high" as const, planSafeActions: [], origin: "plugin" as const },
    { name: "mcp_server_tool", risk: "low" as const, planSafeActions: [], origin: "user-mcp" as const },
  ];
  const active = [
    "read",
    "write",
    "grep",
    "glob",
    "bash",
    "ask",
    "new_context",
    "todo",
    "task",
    "Skill",
    "plugin_demo_run",
    "plugin_demo_write",
    "mcp_server_tool",
    "eval",
  ];

  it("keeps the PI contract natives plus declared plan-safe plugin tools, in current order", () => {
    expect(contractActiveToolNames({ mode: "plan", hostTools }, active)).toEqual([
      "read",
      "grep",
      "glob",
      "bash",
      "ask",
      "new_context",
      "plugin_demo_run",
    ]);
  });

  it("never invents a tool absent from the live set and never admits user MCP", () => {
    const live = ["read", "write", "mcp_server_tool"];
    expect(contractActiveToolNames({ mode: "plan", hostTools }, live)).toEqual(["read"]);
    expect(contractActiveToolNames({ mode: "plan", hostTools: [] }, ["read", "browser", "plugin_demo_run"])).toEqual(["read"]);
  });

  it("admits exactly the mode's own submit tool and deny the other kind", () => {
    const submit = { name: "SubmitPlan", risk: "low" as const, planSafeActions: [], origin: "desktop" as const };
    expect(contractAllowsTool("SubmitPlan", [submit], "plan")).toBe(true);
    expect(contractAllowsTool("SubmitGoal", [submit], "plan")).toBe(false);
    expect(contractAllowsTool("SubmitPlan", [], "goal")).toBe(false);
    expect(contractAllowsTool("SubmitGoal", [], "goal")).toBe(true);
    // No mode, no grant: a caller that does not name the contract cannot admit
    // a submit tool by name.
    expect(contractAllowsTool("SubmitPlan", [submit])).toBe(false);
    expect(contractAllowsTool("SubmitPlan", [submit], "agent")).toBe(false);
  });

  it("keeps the mode's submit tool in the contract clamp and drops the other kind", () => {
    const live = ["read", "write", "bash", "SubmitPlan", "SubmitGoal"];
    expect(contractActiveToolNames({ mode: "plan", hostTools: [] }, live)).toEqual([
      "read",
      "bash",
      "SubmitPlan",
    ]);
    expect(contractActiveToolNames({ mode: "goal", hostTools: [] }, live)).toEqual([
      "read",
      "bash",
      "SubmitGoal",
    ]);
  });
});

describe("contract clamp state machine", () => {
  function fakeApi(active: string[]) {
    const calls: string[][] = [];
    return {
      calls,
      api: {
        getActiveTools: () => [...active],
        setActiveTools: async (names: string[]) => {
          calls.push([...names]);
          active.splice(0, active.length, ...names);
        },
      },
      active,
    };
  }

  it("does nothing in Agent when no clamp is live", async () => {
    const { api, calls } = fakeApi(["read", "write"]);
    const result = await applyContractToolClamp(api, { applied: false, before: [], removed: [] }, { mode: "agent", hostTools: [] });
    expect(result).toEqual({ ok: true, changed: false, active: ["read", "write"] });
    expect(calls).toEqual([]);
  });

  it("clamps on entering Plan and is a no-op when the selection already matches", async () => {
    const { api, calls, active } = fakeApi(["read", "write", "bash"]);
    const clamp = { applied: false, before: [] as string[], removed: [] as string[] };
    const entered = await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    expect(entered.ok).toBe(true);
    if (entered.ok) expect(entered.active).toEqual(["read", "bash"]);
    expect(clamp).toEqual({ applied: true, before: ["read", "write", "bash"], removed: [] });
    expect(active).toEqual(["read", "bash"]);
    expect(calls).toHaveLength(1);

    const stable = await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    expect(stable.ok).toBe(true);
    if (stable.ok) expect(stable.changed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("restores the pre-clamp selection plus a catalog-current tool activated while clamped", async () => {
    const { api, calls, active } = fakeApi(["read", "write", "bash"]);
    const clamp = { applied: false, before: [] as string[], removed: [] as string[] };
    await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    // The runtime auto-activates a newly registered host tool while clamped;
    // the clamp observes it before hiding it, so it is a restore candidate.
    active.push("plugin_demo_run");
    const clampAgain = await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    expect(clampAgain.ok).toBe(true);
    if (clampAgain.ok) expect(clampAgain.active).toEqual(["read", "bash"]);
    expect(clamp.removed).toContain("plugin_demo_run");

    const catalogTool = { name: "plugin_demo_run", risk: "low" as const, planSafeActions: ["inspect"], origin: "plugin" as const };
    const restored = await applyContractToolClamp(api, clamp, {
      mode: "agent",
      hostTools: [catalogTool],
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.active).toEqual(["read", "write", "bash", "plugin_demo_run"]);
    expect(clamp).toEqual({ applied: false, before: [], removed: [] });
    expect(calls.at(-1)).toEqual(["read", "write", "bash", "plugin_demo_run"]);

    // A second Agent turn without a new clamp changes nothing.
    const stable = await applyContractToolClamp(api, clamp, { mode: "agent", hostTools: [catalogTool] });
    expect(stable.ok).toBe(true);
    if (stable.ok) expect(stable.changed).toBe(false);
  });

  it("never revives a removed or disabled catalog tool on the Agent restore", async () => {
    const { api, active } = fakeApi(["read", "write", "bash"]);
    const clamp = { applied: false, before: [] as string[], removed: [] as string[] };
    await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    // Two host tools are auto-activated while clamped; the plugin is then
    // removed from the catalog before the Agent prompt, the MCP server is
    // disabled the same way.
    active.push("plugin_demo_run", "mcp_alpha_lookup");
    await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    const restored = await applyContractToolClamp(api, clamp, { mode: "agent", hostTools: [] });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.active).toEqual(["read", "write", "bash"]);
    expect(clamp.removed).toEqual([]);
  });

  it("does not invent a catalog tool that was never part of the live selection", async () => {
    const { api } = fakeApi(["read", "write"]);
    const clamp = { applied: true, before: ["read", "write"], removed: [] as string[] };
    // The catalog declares a tool the runtime never activated for this
    // session: the restore must not enable it just because it is declared.
    const catalogTool = { name: "plugin_demo_declared", risk: "low" as const, planSafeActions: ["inspect"], origin: "plugin" as const };
    const restored = await applyContractToolClamp(api, clamp, { mode: "agent", hostTools: [catalogTool] });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.active).toEqual(["read", "write"]);
  });

  it("refuses a contract mode when the runtime exposes no tool-selection API", async () => {
    const result = await applyContractToolClamp({}, { applied: false, before: [], removed: [] }, { mode: "goal", hostTools: [] });
    expect(result.ok).toBe(false);
  });
});

describe("registered handlers", () => {
  type Captured = {
    toolCall?: (event: unknown, context: unknown) => Promise<unknown>;
    beforeAgentStart?: (event: unknown, context: unknown) => Promise<unknown>;
    commands: Map<string, (args: string, context: unknown) => unknown>;
  };

  function fakeGate() {
    const captured: Captured = { commands: new Map() };
    const active = ["read", "write", "bash", "ask"];
    const setCalls: string[][] = [];
    const api: ExtensionAPI = {
      on: ((event: string, handler: unknown) => {
        if (event === "tool_call") captured.toolCall = handler as Captured["toolCall"];
        if (event === "before_agent_start") captured.beforeAgentStart = handler as Captured["beforeAgentStart"];
      }) as ExtensionAPI["on"],
      registerCommand: ((name: string, options: { handler: (args: string, context: unknown) => unknown }) => {
        captured.commands.set(name, options.handler);
      }) as ExtensionAPI["registerCommand"],
      getActiveTools: () => [...active],
      setActiveTools: async (names: string[]) => {
        setCalls.push([...names]);
        active.splice(0, active.length, ...names);
      },
    };
    return { api, captured, setCalls, active };
  }

  it("registers both handlers on the real events", () => {
    const { api, captured } = fakeGate();
    ompDesktopGate(api);
    expect(typeof captured.beforeAgentStart).toBe("function");
    expect(typeof captured.toolCall).toBe("function");
  });

  it("applies the Plan clamp and appends the mode block through the registered handler", async () => {
    const path = writeState({}, Date.now());
    process.env.OMP_DESKTOP_STATE = path;
    const { api, captured, setCalls } = fakeGate();
    ompDesktopGate(api);
    const result = (await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      context(),
    )) as { systemPrompt: string[] } | undefined;
    expect(result!.systemPrompt.slice(0, 2)).toEqual(BASE_PROMPT);
    expect(result!.systemPrompt.at(-1)).toBe(PLAN_BLOCK);
    expect(setCalls).toEqual([["read", "bash", "ask"]]);
  });

  it("refuses the turn through ctx.abort and a structured notify when the owned state is invalid", async () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeFileSync(path, JSON.stringify({ v: 1, sessionId: OWNING_SESSION, skills: [], memory: null }));
    process.env.OMP_DESKTOP_STATE = path;
    const { api, captured, setCalls } = fakeGate();
    ompDesktopGate(api);
    let aborted = 0;
    const notifications: Array<{ message: string; type?: string }> = [];
    const result = await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      {
        ...context(),
        abort: () => {
          aborted += 1;
        },
        hasUI: true,
        ui: {
          notify: (message: string, type?: "info" | "warning" | "error") => {
            notifications.push({ message, type });
          },
        },
      },
    );
    expect(result).toBeUndefined();
    expect(aborted).toBe(1);
    expect(setCalls).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    const refusal = parseStartRefusalNotice({
      type: "extension_ui_request",
      id: "frame-1",
      method: "notify",
      message: notifications[0]?.message,
    });
    expect(refusal).toMatchObject({ sessionId: OWNING_SESSION, code: "state-invalid" });
  });

  it("refuses a deleted mandatory state in the registered handler, but never a delegate", async () => {
    const path = writeState({}, Date.now());
    rmSync(path);
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const { api, captured } = fakeGate();
    ompDesktopGate(api);
    let aborted = 0;
    await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      {
        ...context(),
        abort: () => {
          aborted += 1;
        },
        hasUI: true,
        ui: { notify: () => undefined },
      },
    );
    expect(aborted).toBe(1);

    // A delegate (no UI) reading the same run root keeps zero injection and
    // is never aborted: its own state read is not the owner's failure.
    const delegate = await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      {
        ...context("delegate-native"),
        abort: () => {
          aborted += 1;
        },
        hasUI: false,
        ui: { notify: () => undefined },
      },
    );
    expect(delegate).toBeUndefined();
    expect(aborted).toBe(1);
  });

  it("installs the turn token through the registered command and echoes it in the refusal", async () => {
    const path = writeState({}, Date.now());
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const { api, captured } = fakeGate();
    ompDesktopGate(api);
    const notifications: Array<{ message: string; type?: string }> = [];
    const notifyContext = {
      ...context(),
      hasUI: true,
      ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    };
    const handler = captured.commands.get(OMP_TURN_COMMAND);
    expect(typeof handler).toBe("function");
    const token = "0123456789abcdef0123456789abcdef";
    handler!(token, notifyContext);
    expect(parseTurnAckNotice({ type: "extension_ui_request", id: "ack-1", method: "notify", message: notifications[0]?.message })).toEqual({
      v: 2,
      kind: "omp-desktop-turn-ack",
      token,
      admissionDigest: null,
    });
    expect(notifications[0]?.type).toBe("info");

    // A malformed argument installs nothing and is not acknowledged: the
    // runner then refuses the prompt before submitting it.
    handler!("not-a-token", notifyContext);
    expect(notifications).toHaveLength(1);

    // The turn the token was installed for refuses with that exact token.
    rmSync(path);
    let aborted = 0;
    const result = await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      { ...notifyContext, abort: () => { aborted += 1; } },
    );
    expect(result).toBeUndefined();
    expect(aborted).toBe(1);
    const refusal = parseStartRefusalNotice({
      type: "extension_ui_request",
      id: "frame-1",
      method: "notify",
      message: notifications.at(-1)?.message,
    });
    expect(refusal).toMatchObject({ sessionId: OWNING_SESSION, code: "state-missing", turnToken: token });
  });

  it("leaves the refusal unbound when no handshake preceded the turn", async () => {
    const path = writeState({}, Date.now());
    rmSync(path);
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const { api, captured } = fakeGate();
    ompDesktopGate(api);
    const notifications: string[] = [];
    await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      {
        ...context(),
        hasUI: true,
        abort: () => undefined,
        ui: { notify: (message: string) => notifications.push(message) },
      },
    );
    const refusal = parseStartRefusalNotice({
      type: "extension_ui_request",
      id: "frame-1",
      method: "notify",
      message: notifications[0],
    });
    // `turnToken: null` is valid on the wire and can never match a live
    // generation, so a refusal produced without a fence closes nothing.
    expect(refusal).toMatchObject({ code: "state-missing", turnToken: null });
  });

  it("carries the effective permission mode into the approval descriptor from the owned state", async () => {
    const path = writeState({ permissionMode: "accept-edits" }, Date.now());
    process.env.OMP_DESKTOP_STATE = path;
    const { api, captured } = fakeGate();
    ompDesktopGate(api);
    let dialogItems: Array<{ label: string; description?: string }> = [];
    const toolContext = {
      ...context(),
      hasUI: true,
      ui: {
        select: async (_title: string, items: Array<{ label: string; description?: string }>) => {
          dialogItems = items;
          return items[0]!.label;
        },
      },
    };
    const verdict = await captured.toolCall!(
      // A contract-allowed tool: `write` is hard-denied in Plan (M5/T20-C),
      // while Bash still cards under accept-edits, which is the mode the
      // descriptor must report.
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "true" } },
      toolContext,
    );
    expect(verdict).toBeUndefined();
    const descriptor = parseApprovalDescriptor(dialogItems[0]?.description);
    expect(descriptor?.permissionMode).toBe("accept-edits");
    expect(descriptor?.mode).toBe("plan");
    expect(descriptor?.toolName).toBe("bash");
  });

  it("omits the permission mode in the descriptor when no owned state is readable", async () => {
    delete process.env.OMP_DESKTOP_STATE;
    const { api, captured } = fakeGate();
    ompDesktopGate(api);
    let dialogItems: Array<{ label: string; description?: string }> = [];
    const verdict = await captured.toolCall!(
      { type: "tool_call", toolCallId: "call-2", toolName: "bash", input: { command: "true" } },
      {
        ...context(),
        hasUI: true,
        ui: {
          select: async (_title: string, items: Array<{ label: string; description?: string }>) => {
            dialogItems = items;
            return items[0]!.label;
          },
        },
      },
    );
    expect(verdict).toBeUndefined();
    const descriptor = parseApprovalDescriptor(dialogItems[0]?.description);
    expect(descriptor?.permissionMode).toBeUndefined();
  });
});
