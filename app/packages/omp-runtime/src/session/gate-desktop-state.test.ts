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
  type ExtensionAPI,
} from "../../extensions/omp-desktop-gate.ts";
import { parseApprovalDescriptor } from "../session/approval-protocol.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OMP_DESKTOP_STATE;
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
    expect(contractActiveToolNames({ hostTools }, active)).toEqual([
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
    expect(contractActiveToolNames({ hostTools }, live)).toEqual(["read"]);
    expect(contractActiveToolNames({ hostTools: [] }, ["read", "browser", "plugin_demo_run"])).toEqual(["read"]);
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
    const result = await applyContractToolClamp(api, { applied: false, before: [] }, { mode: "agent", hostTools: [] });
    expect(result).toEqual({ ok: true, changed: false, active: ["read", "write"] });
    expect(calls).toEqual([]);
  });

  it("clamps on entering Plan and is a no-op when the selection already matches", async () => {
    const { api, calls, active } = fakeApi(["read", "write", "bash"]);
    const clamp = { applied: false, before: [] as string[] };
    const entered = await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    expect(entered.ok).toBe(true);
    if (entered.ok) expect(entered.active).toEqual(["read", "bash"]);
    expect(clamp).toEqual({ applied: true, before: ["read", "write", "bash"] });
    expect(active).toEqual(["read", "bash"]);
    expect(calls).toHaveLength(1);

    const stable = await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    expect(stable.ok).toBe(true);
    if (stable.ok) expect(stable.changed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("restores the pre-clamp selection plus tools activated meanwhile when returning to Agent", async () => {
    const { api, calls, active } = fakeApi(["read", "write", "bash"]);
    const clamp = { applied: false, before: [] as string[] };
    await applyContractToolClamp(api, clamp, { mode: "plan", hostTools: [] });
    // The runtime auto-activates a newly registered host tool while clamped.
    active.push("plugin_demo_run");
    const restored = await applyContractToolClamp(api, clamp, { mode: "agent", hostTools: [] });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.active).toEqual(["read", "write", "bash", "plugin_demo_run"]);
    expect(clamp).toEqual({ applied: false, before: [] });
    expect(calls.at(-1)).toEqual(["read", "write", "bash", "plugin_demo_run"]);

    // A second Agent turn without a new clamp changes nothing.
    const stable = await applyContractToolClamp(api, clamp, { mode: "agent", hostTools: [] });
    expect(stable.ok).toBe(true);
    if (stable.ok) expect(stable.changed).toBe(false);
  });

  it("refuses a contract mode when the runtime exposes no tool-selection API", async () => {
    const result = await applyContractToolClamp({}, { applied: false, before: [] }, { mode: "goal", hostTools: [] });
    expect(result.ok).toBe(false);
  });
});

describe("registered handlers", () => {
  type Captured = {
    toolCall?: (event: unknown, context: unknown) => Promise<unknown>;
    beforeAgentStart?: (event: unknown, context: unknown) => Promise<unknown>;
  };

  function fakeGate() {
    const captured: Captured = {};
    const active = ["read", "write", "bash", "ask"];
    const setCalls: string[][] = [];
    const api: ExtensionAPI = {
      on: ((event: string, handler: unknown) => {
        if (event === "tool_call") captured.toolCall = handler as Captured["toolCall"];
        if (event === "before_agent_start") captured.beforeAgentStart = handler as Captured["beforeAgentStart"];
      }) as ExtensionAPI["on"],
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

  it("refuses the turn through ctx.abort when the owned state is invalid", async () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeFileSync(path, JSON.stringify({ v: 1, sessionId: OWNING_SESSION, skills: [], memory: null }));
    process.env.OMP_DESKTOP_STATE = path;
    const { api, captured, setCalls } = fakeGate();
    ompDesktopGate(api);
    let aborted = 0;
    const result = await captured.beforeAgentStart!(
      { type: "before_agent_start", systemPrompt: [...BASE_PROMPT] },
      { ...context(), abort: () => { aborted += 1; } },
    );
    expect(result).toBeUndefined();
    expect(aborted).toBe(1);
    expect(setCalls).toEqual([]);
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
      { type: "tool_call", toolCallId: "call-1", toolName: "write", input: { path: "/tmp/x" } },
      toolContext,
    );
    expect(verdict).toBeUndefined();
    const descriptor = parseApprovalDescriptor(dialogItems[0]?.description);
    expect(descriptor?.permissionMode).toBe("accept-edits");
    expect(descriptor?.toolName).toBe("write");
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
