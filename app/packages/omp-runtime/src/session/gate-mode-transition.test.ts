/**
 * The gate's mid-turn contract-mode transition (M5/T20-D).
 *
 * A host-confirmed `EnterPlanMode`/`EnterGoalMode` must move the *live* turn's
 * contract — system prompt, tool catalogue and decision policy — before the
 * next provider request while the durable turn and the agent run stay the
 * same. The authorisation is the record the desktop adapter attaches to the
 * settled result; these registered-handler tests pin the runtime-side half:
 * attribution to the live admission, single use, delegate retirement,
 * fail-closed behaviour for missing/invalid/failed records and for a runtime
 * without the live prompt API, and the cached-parts continuation.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolCallEvent } from "../../extensions/omp-desktop-gate.ts";
import {
  DESKTOP_STATE_FILE,
  serializeDesktopCapabilityState,
  type DesktopHostToolPolicy,
} from "../desktop-state.js";
import { createGateHandlerHarness, type GateHandlerHarness } from "./gate-handler-testkit.js";
import {
  encodeModeTransitionDetails,
  type OmpModeTransition,
} from "./mode-transition.js";
import { parseTurnFailureNotice } from "./turn-failure.js";
import { OMP_APPROVAL_OPTIONS } from "./approval-protocol.js";
import type { OmpTurnAdmission } from "./turn-admission.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OMP_DESKTOP_STATE;
  delete process.env.OMP_DESKTOP_STATE_REQUIRED;
  delete process.env.OMP_DESKTOP_GATE_MODE;
  delete process.env.OMP_DESKTOP_GATE_TOOLS;
});

const OWNER = "native-owner";
const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);
const AGENT_BLOCK = "You are operating in Agent mode. After the user approves a plan.";
const PLAN_BLOCK = "You are operating in Plan mode as the same PI-Desktop agent.";
const GOAL_BLOCK = "You are operating in Goal mode as the same PI-Desktop agent.";

const ENTER_PLAN = "EnterPlanMode";
const ENTER_GOAL = "EnterGoalMode";

const ENTER_POLICY: DesktopHostToolPolicy = {
  name: ENTER_PLAN,
  risk: "low",
  planSafeActions: [],
  origin: "desktop",
};
const ENTER_GOAL_POLICY: DesktopHostToolPolicy = { ...ENTER_POLICY, name: ENTER_GOAL };
const SUBMIT_POLICY: DesktopHostToolPolicy = {
  name: "SubmitPlan",
  risk: "low",
  planSafeActions: [],
  origin: "desktop",
};
const PLUGIN_SAFE: DesktopHostToolPolicy = {
  name: "plugin_demo_readonly",
  risk: "low",
  planSafeActions: ["read"],
  origin: "plugin",
};
const PLUGIN_UNSAFE: DesktopHostToolPolicy = {
  name: "plugin_demo_mutate",
  risk: "medium",
  planSafeActions: [],
  origin: "plugin",
};

/** The Agent catalogue the prompt would have registered (before the transition). */
const AGENT_HOST_TOOLS = [ENTER_POLICY, ENTER_GOAL_POLICY, PLUGIN_SAFE, PLUGIN_UNSAFE];

/** The Plan catalogue the desktop prepares for the transition. */
const PLAN_HOST_TOOLS = [SUBMIT_POLICY, PLUGIN_SAFE, PLUGIN_UNSAFE];

/** The live active set: Agent selection with both Enter tools, a plugin pair and SubmitPlan registered. */
const AGENT_ACTIVE = [
  "read",
  "write",
  "edit",
  "bash",
  "ask",
  "new_context",
  ENTER_PLAN,
  ENTER_GOAL,
  "SubmitPlan",
  "SubmitGoal",
  "plugin_demo_readonly",
  "plugin_demo_mutate",
];

function writeState(mode: "agent" | "plan" | "goal" = "agent"): string {
  const dir = join(tmpdir(), `omp-gate-transition-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  const path = join(dir, DESKTOP_STATE_FILE);
  writeFileSync(
    path,
    serializeDesktopCapabilityState(
      {
        sessionId: OWNER,
        mode,
        modeBlock: mode === "agent" ? AGENT_BLOCK : mode === "plan" ? PLAN_BLOCK : GOAL_BLOCK,
        permissionMode: "auto",
        skills: [],
        memory: null,
        hostTools: mode === "agent" ? AGENT_HOST_TOOLS : PLAN_HOST_TOOLS,
      },
      Date.now(),
    ),
  );
  return path;
}

function admission(overrides: Partial<OmpTurnAdmission> = {}): OmpTurnAdmission {
  return {
    v: 1,
    nativeSessionId: OWNER,
    mode: "agent",
    permissionMode: "auto",
    hostTools: AGENT_HOST_TOOLS,
    grants: [],
    ...overrides,
  };
}

function readyRecord(overrides: Partial<Extract<OmpModeTransition, { state: "ready" }>> = {}): OmpModeTransition {
  return {
    v: 1,
    kind: "plan",
    state: "ready",
    sessionId: OWNER,
    liveTurnId: "omp-turn:native-owner:1",
    hostTurnId: "host-turn-1",
    toolCallId: "enter-1",
    expectedMode: "agent",
    modeBlock: PLAN_BLOCK,
    hostTools: PLAN_HOST_TOOLS,
    at: Date.now(),
    ...overrides,
  } as OmpModeTransition;
}

function failedRecord(overrides: Partial<Extract<OmpModeTransition, { state: "failed" }>> = {}): OmpModeTransition {
  return {
    v: 1,
    kind: "plan",
    state: "failed",
    sessionId: OWNER,
    liveTurnId: "omp-turn:native-owner:1",
    hostTurnId: "host-turn-1",
    toolCallId: "enter-1",
    expectedMode: "agent",
    reason: "the desktop could not register the transitioned catalogue",
    at: Date.now(),
    ...overrides,
  } as OmpModeTransition;
}

function enterResult(record: OmpModeTransition, toolCallId = record.toolCallId, toolName = ENTER_PLAN) {
  return {
    type: "tool_result" as const,
    toolCallId,
    toolName,
    details: encodeModeTransitionDetails(record),
    isError: false,
  };
}

/** The structured turn-failure descriptors the gate emitted (not the fence ack). */
function failureNotices(h: GateHandlerHarness) {
  return h.notices
    .map((notice) =>
      parseTurnFailureNotice({ type: "extension_ui_request", method: "notify", message: notice.message }),
    )
    .filter((failure) => failure !== null);
}

const BASH: ToolCallEvent = { type: "tool_call", toolCallId: "call-bash", toolName: "bash", input: { command: "true" } };
const READ: ToolCallEvent = { type: "tool_call", toolCallId: "call-read", toolName: "read", input: { path: "a.txt" } };
const WRITE: ToolCallEvent = { type: "tool_call", toolCallId: "call-write", toolName: "write", input: { path: "out.txt", content: "x" } };

/** Start the harness on an admitted Agent turn and return it. */
async function startedAgentTurn(
  options: {
    liveSystemPrompt?: boolean;
    awaitSystemPrompt?: () => Promise<void> | void;
    awaitToolSelection?: () => Promise<void> | void;
  } = {},
): Promise<GateHandlerHarness> {
  const path = writeState("agent");
  process.env.OMP_DESKTOP_STATE = path;
  process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
  const h = createGateHandlerHarness({
    sessionId: OWNER,
    activeTools: [...AGENT_ACTIVE],
    ...(options.liveSystemPrompt === false ? { liveSystemPrompt: false } : {}),
    ...(options.awaitSystemPrompt ? { awaitSystemPrompt: options.awaitSystemPrompt } : {}),
    ...(options.awaitToolSelection ? { awaitToolSelection: options.awaitToolSelection } : {}),
  });
  h.arm(TOKEN_A, admission());
  expect(await h.beforeAgentStart()).toMatchObject({ systemPrompt: ["native prompt", AGENT_BLOCK] });
  h.agentStart();
  return h;
}

/** A promise the test settles explicitly: the async seams of the transition. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield microtasks until the predicate holds (the seams above are microtask-only). */
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) await Promise.resolve();
}

/**
 * Arm and start a successor Agent turn B — a terminal `agent_end` for A, a new
 * fence admission, its start and a bound delegate — the real interleaving a
 * suspended transition must not touch.
 */
async function startSuccessorAgentTurn(
  h: GateHandlerHarness,
  childSessionId: string,
): Promise<Record<string, unknown>> {
  h.agentEnd();
  h.arm(TOKEN_B, admission());
  await h.beforeAgentStart();
  h.agentStart();
  const child = h.delegateContext(childSessionId);
  await h.lifecycle("session_start", child);
  return child;
}

describe("gate mid-turn mode transition", () => {
  it("applies a ready record: prompt, catalogue and policy move to the new mode", async () => {
    const h = await startedAgentTurn();
    expect(await h.toolCall(READ)).toBeUndefined();
    expect(await h.toolCall(WRITE)).toBeUndefined();

    const verdict = await h.toolResult(enterResult(readyRecord()));
    expect(verdict).toBeUndefined();
    expect(h.aborted()).toBe(0);
    expect(failureNotices(h)).toHaveLength(0);

    // The live prompt is base + the new mode block (the old block replaced).
    expect(h.systemPromptReplacements).toEqual([["native prompt", PLAN_BLOCK]]);
    // The clamp keeps exactly the contract catalogue: read-only natives, the
    // plan-safe plugin and the mode's submit tool; the Enter tools, the
    // write-capable natives and the undeclared plugin are gone.
    expect(h.toolSelections).toHaveLength(1);
    expect([...h.toolSelections[0]].sort()).toEqual([
      "SubmitPlan",
      "ask",
      "bash",
      "new_context",
      "plugin_demo_readonly",
      "read",
    ]);

    // The decision policy is the transitioned one: Write is contract-denied,
    // the plugin without a declaration is contract-denied, and a read-only
    // call still passes.
    const write = await h.toolCall(WRITE);
    expect(write?.block).toBe(true);
    expect(write?.reason).toMatch(/WRITE_DISABLED_IN_PLAN/);
    const unsafe = await h.toolCall({
      type: "tool_call",
      toolCallId: "call-unsafe",
      toolName: "plugin_demo_mutate",
      input: {},
    });
    expect(unsafe?.block).toBe(true);
    expect(unsafe?.reason).toMatch(/PLUGIN_DISABLED_IN_PLAN/);
    expect(await h.toolCall(READ)).toBeUndefined();
    expect(h.dialogs).toHaveLength(0);
  });

  it("retires the delegate bindings that belonged to the prompt-time record", async () => {
    const h = await startedAgentTurn();
    const child = h.delegateContext("native-child-1");
    await h.lifecycle("session_start", child);
    // Bound to the Agent record: `auto` allows Bash with no card.
    expect(await h.toolCall(BASH, child)).toBeUndefined();

    await h.toolResult(enterResult(readyRecord()));

    // The same delegate can no longer decide: it started under the Agent
    // record, and that record was retired by the transition.
    const after = await h.toolCall(BASH, child);
    expect(after?.block).toBe(true);
    expect(after?.reason).toMatch(/policy is unavailable/);
    expect(h.dialogs).toHaveLength(0);
  });

  it("refuses a replayed record: one transition per admitted turn", async () => {
    const h = await startedAgentTurn();
    await h.toolResult(enterResult(readyRecord()));
    expect(h.systemPromptReplacements).toHaveLength(1);

    const replay = await h.toolResult(enterResult(readyRecord()));
    expect(replay).toBeUndefined();
    // The replay fails the turn (there is no lawful second transition).
    expect(h.aborted()).toBe(1);
    expect(h.systemPromptReplacements).toHaveLength(1);
    const [failure] = failureNotices(h);
    expect(failure?.code).toBe("transition-invalid");
    expect(failure?.turnToken).toBe(TOKEN_A);
    expect(failure?.sessionId).toBe(OWNER);
  });

  it("fails closed for a record that fails attribution", async () => {
    const cases: Array<[string, OmpModeTransition, string]> = [
      ["foreign session", readyRecord({ sessionId: "native-other" }), "different native session"],
      ["foreign tool call", readyRecord({ toolCallId: "enter-other" }), "does not name this tool call"],
      ["wrong direction", readyRecord({ kind: "goal" }), "not the tool that produced this result"],
    ];
    for (const [label, record, reason] of cases) {
      const h = await startedAgentTurn();
      // The event carries the live call id; a record naming another call can
      // never move this one.
      await h.toolResult(enterResult(record, "enter-live"));
      expect(h.aborted(), label).toBe(1);
      expect(h.systemPromptReplacements, label).toHaveLength(0);
      expect(h.toolSelections, label).toHaveLength(0);
      const [failure] = failureNotices(h);
      expect(failure?.code, label).toBe("transition-invalid");
      expect(failure?.reason, label).toMatch(new RegExp(reason));
    }
  });

  it("fails closed for a record whose admitted turn never started", async () => {
    const path = writeState("agent");
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER, activeTools: [...AGENT_ACTIVE] });
    h.arm(TOKEN_B, admission());
    await h.beforeAgentStart();
    // No `agent_start`: the admission decides nothing yet, so it cannot be
    // transitioned either.
    await h.toolResult(enterResult(readyRecord()));
    expect(h.aborted()).toBe(1);
    expect(h.systemPromptReplacements).toHaveLength(0);
    const [failure] = failureNotices(h);
    expect(failure?.code).toBe("transition-invalid");
    expect(failure?.reason).toMatch(/has not started/);
  });

  it("fails the turn on a failed-state record and on a success result without a record", async () => {
    const h = await startedAgentTurn();
    await h.toolResult(enterResult(failedRecord()));
    expect(h.aborted()).toBe(1);
    expect(h.systemPromptReplacements).toHaveLength(0);
    expect(failureNotices(h)[0]?.code).toBe("transition-apply-failed");

    // A fresh turn: an Enter success without any record is an anomaly (the
    // desktop adapter always attaches one), so it fails the turn too.
    const h2 = await startedAgentTurn();
    await h2.toolResult({
      type: "tool_result",
      toolCallId: "enter-1",
      toolName: ENTER_PLAN,
      details: {},
      isError: false,
    });
    expect(h2.aborted()).toBe(1);
    expect(failureNotices(h2)[0]?.code).toBe("transition-invalid");
  });

  it("leaves an ordinary host refusal correctable: an error result with no record changes nothing", async () => {
    const h = await startedAgentTurn();
    await h.toolResult({
      type: "tool_result",
      toolCallId: "enter-1",
      toolName: ENTER_PLAN,
      details: {},
      isError: true,
    });
    expect(h.aborted()).toBe(0);
    expect(h.systemPromptReplacements).toHaveLength(0);
    expect(h.toolSelections).toHaveLength(0);
    // The turn keeps its Agent contract — the Enter tool still exists and the
    // Agent permission policy (auto) is unchanged — so the model can retry.
    expect(await h.toolCall(READ)).toBeUndefined();
    expect(
      await h.toolCall({ type: "tool_call", toolCallId: "call-enter-again", toolName: ENTER_PLAN, input: {} }),
    ).toBeUndefined();
  });

  it("fails the turn when the runtime exposes no live system-prompt API", async () => {
    const h = await startedAgentTurn({ liveSystemPrompt: false });
    await h.toolResult(enterResult(readyRecord()));
    expect(h.aborted()).toBe(1);
    expect(h.systemPromptReplacements).toHaveLength(0);
    expect(h.toolSelections).toHaveLength(0);
    const [failure] = failureNotices(h);
    expect(failure?.code).toBe("transition-apply-failed");
    expect(failure?.reason).toMatch(/live system-prompt API/);
  });

  it("rebuilds a same-turn continuation from the cached parts instead of the stale file", async () => {
    const h = await startedAgentTurn();
    await h.toolResult(enterResult(readyRecord()));

    // A queued batch inside the same live turn reaches `before_agent_start`
    // again while the run-scoped file still describes the prompt-time mode.
    // The record, not the file, must describe the injection.
    expect(await h.beforeAgentStart()).toMatchObject({ systemPrompt: ["native prompt", PLAN_BLOCK] });
    expect(failureNotices(h)).toHaveLength(0);
    expect(h.aborted()).toBe(0);
  });

  it("carries a Goal transition with only SubmitGoal and the Goal block", async () => {
    const h = await startedAgentTurn();
    await h.toolResult(
      enterResult(
        readyRecord({
          kind: "goal",
          modeBlock: GOAL_BLOCK,
          hostTools: [{ ...SUBMIT_POLICY, name: "SubmitGoal" }, PLUGIN_SAFE, PLUGIN_UNSAFE],
        } as Partial<Extract<OmpModeTransition, { state: "ready" }>>),
        "enter-1",
        ENTER_GOAL,
      ),
    );
    expect(h.systemPromptReplacements).toEqual([["native prompt", GOAL_BLOCK]]);
    const selected = [...h.toolSelections[0]].sort();
    expect(selected).toContain("SubmitGoal");
    expect(selected).not.toContain("SubmitPlan");
    expect(selected).not.toContain(ENTER_GOAL);
    // The wrong kind's submit tool is contract-denied in Goal mode.
    const submit = await h.toolCall({
      type: "tool_call",
      toolCallId: "call-submit",
      toolName: "SubmitPlan",
      input: { title: "t", markdown: "m", question: "q" },
    });
    expect(submit?.block).toBe(true);
    expect(submit?.reason).toMatch(/PLAN_KIND_MISMATCH/);
  });

  it("keeps the new fence in charge: the next prompt's admission replaces the transitioned record", async () => {
    const h = await startedAgentTurn();
    await h.toolResult(enterResult(readyRecord()));
    h.agentEnd();

    // A new prompt arrives in Plan mode (the host row is authoritative); its
    // own file and admission describe Plan and a fresh record replaces the
    // transitioned one.
    const planPath = writeState("plan");
    process.env.OMP_DESKTOP_STATE = planPath;
    h.arm(TOKEN_B, admission({ mode: "plan", hostTools: PLAN_HOST_TOOLS }));
    expect(await h.beforeAgentStart()).toMatchObject({ systemPrompt: ["native prompt", PLAN_BLOCK] });
    h.agentStart();
    const write = await h.toolCall(WRITE);
    expect(write?.block).toBe(true);
    expect(write?.reason).toMatch(/WRITE_DISABLED_IN_PLAN/);
  });

  it("a prompt replacement that resolves after a successor turn is armed never moves the successor", async () => {
    const hold = deferred();
    const h = await startedAgentTurn({ awaitSystemPrompt: () => hold.promise });
    const pending = h.toolResult(enterResult(readyRecord()));
    await until(() => h.systemPromptReplacements.length === 1);
    const child = await startSuccessorAgentTurn(h, "native-child-late-resolve");
    // The successor turn is live: its Agent policy allows Write and its bound
    // delegate is decided by the successor's record.
    expect(await h.toolCall(WRITE)).toBeUndefined();
    expect(await h.toolCall(BASH, child)).toBeUndefined();
    const before = {
      prompts: h.systemPromptReplacements.length,
      selections: h.toolSelections.length,
      aborts: h.aborted(),
    };
    hold.resolve();
    await pending;
    // The late continuation neither replaced the successor's record with the
    // transitioned copy, retired its delegate bindings, applied the old clamp,
    // failed its turn nor aborted its context.
    expect(h.systemPromptReplacements).toHaveLength(before.prompts);
    expect(h.toolSelections).toHaveLength(before.selections);
    expect(h.aborted()).toBe(before.aborts);
    expect(failureNotices(h)).toHaveLength(0);
    expect(await h.toolCall(WRITE)).toBeUndefined();
    expect(await h.toolCall(BASH, child)).toBeUndefined();
  });

  it("a stale prompt rejection never retires, fails or aborts the successor turn", async () => {
    const hold = deferred();
    const h = await startedAgentTurn({ awaitSystemPrompt: () => hold.promise });
    const pending = h.toolResult(enterResult(readyRecord()));
    await until(() => h.systemPromptReplacements.length === 1);
    const child = await startSuccessorAgentTurn(h, "native-child-late-reject");
    const aborts = h.aborted();
    hold.reject(new Error("controlled stale API rejection"));
    await pending;
    // The rejection is this continuation's own failure, but the admission it
    // started under is gone: it must not retire the successor's record, emit a
    // failure attributed to the successor's token or abort its context.
    expect(h.aborted()).toBe(aborts);
    expect(failureNotices(h)).toHaveLength(0);
    expect(h.systemPromptReplacements).toHaveLength(1);
    expect(h.toolSelections).toHaveLength(0);
    expect(await h.toolCall(WRITE)).toBeUndefined();
    expect(await h.toolCall(BASH, child)).toBeUndefined();
  });

  it("a stale clamp rejection never retires the successor's admission", async () => {
    // Only the transitioned clamp is held: the successor's own start performs
    // its legitimate Agent restore, which must not suspend on the stale seam.
    const seam = deferred();
    let consumed = false;
    const h = await startedAgentTurn({
      awaitToolSelection: () => {
        if (consumed) return undefined;
        consumed = true;
        return seam.promise;
      },
    });
    const pending = h.toolResult(enterResult(readyRecord()));
    await until(() => h.toolSelections.length === 1);
    // The prompt replacement resolved synchronously; the handler installed the
    // transitioned copy and is now suspended inside the clamp's selection.
    expect(h.systemPromptReplacements).toHaveLength(1);
    const child = await startSuccessorAgentTurn(h, "native-child-late-clamp");
    const before = { selections: h.toolSelections.length, aborts: h.aborted() };
    seam.reject(new Error("controlled stale clamp rejection"));
    await pending;
    expect(h.toolSelections).toHaveLength(before.selections);
    expect(h.aborted()).toBe(before.aborts);
    expect(failureNotices(h)).toHaveLength(0);
    expect(await h.toolCall(WRITE)).toBeUndefined();
    expect(await h.toolCall(BASH, child)).toBeUndefined();
  });
});
