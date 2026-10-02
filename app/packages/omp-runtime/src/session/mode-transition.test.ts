/**
 * The mode-transition record's wire contract (M5/T20-D).
 *
 * The record is the desktop's authorisation for a mid-turn `Agent -> Plan|Goal`
 * transition; the gate trusts exactly this shape. The tests pin the strictness
 * the gate relies on: a complete ready/failed round trip, and rejection of
 * anything a forger could smuggle — unknown keys, a wrong direction, missing
 * or extra material, out-of-bound strings and an oversized record.
 */
import { describe, expect, it } from "vitest";

import {
  decodeModeTransitionDetails,
  encodeModeTransitionDetails,
  enterKindForToolName,
  enterToolNameForKind,
  OMP_ENTER_TOOL_NAMES,
  OMP_MODE_TRANSITION_KEY,
  OMP_MODE_TRANSITION_MAX_BYTES,
  type OmpModeTransition,
} from "./mode-transition.js";

const READY: OmpModeTransition = {
  v: 1,
  kind: "plan",
  state: "ready",
  sessionId: "native-owner",
  liveTurnId: "omp-turn:native-owner:1",
  hostTurnId: "host-turn-1",
  toolCallId: "enter-call-1",
  expectedMode: "agent",
  modeBlock: "PLAN-BLOCK",
  hostTools: [{ name: "SubmitPlan", risk: "low", planSafeActions: [], origin: "desktop" }],
  at: 1_700_000_000_000,
};

const FAILED: OmpModeTransition = {
  v: 1,
  kind: "goal",
  state: "failed",
  sessionId: "native-owner",
  liveTurnId: "omp-turn:native-owner:1",
  hostTurnId: "host-turn-1",
  toolCallId: "enter-call-2",
  expectedMode: "agent",
  reason: "the desktop could not prepare the transitioned turn",
  at: 1_700_000_000_001,
};

function ready(overrides: Partial<Extract<OmpModeTransition, { state: "ready" }>> = {}): OmpModeTransition {
  return { ...READY, ...overrides } as OmpModeTransition;
}

describe("mode transition record codec", () => {
  it("round-trips a ready and a failed record", () => {
    expect(decodeModeTransitionDetails(encodeModeTransitionDetails(READY))).toEqual(READY);
    expect(decodeModeTransitionDetails(encodeModeTransitionDetails(FAILED))).toEqual(FAILED);
  });

  it("names the two Enter tools exactly like PI", () => {
    expect(OMP_ENTER_TOOL_NAMES).toEqual({ plan: "EnterPlanMode", goal: "EnterGoalMode" });
    expect(enterToolNameForKind("plan")).toBe("EnterPlanMode");
    expect(enterKindForToolName("EnterPlanMode")).toBe("plan");
    expect(enterKindForToolName("EnterGoalMode")).toBe("goal");
    expect(enterKindForToolName("SubmitPlan")).toBeNull();
    expect(enterKindForToolName("enterplanmode")).toBeNull();
  });

  it("rejects every unattributable envelope shape", () => {
    expect(decodeModeTransitionDetails(undefined)).toBeNull();
    expect(decodeModeTransitionDetails(null)).toBeNull();
    expect(decodeModeTransitionDetails({})).toBeNull();
    expect(decodeModeTransitionDetails({ other: READY })).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: READY, extra: 1 })).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: [] })).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: "text" })).toBeNull();
  });

  it("rejects a record with an unknown key, a wrong version or a wrong direction", () => {
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, future: true } })).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, v: 2 } })).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, kind: "agent" } })).toBeNull();
    expect(
      decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, expectedMode: "plan" } }),
    ).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, state: "done" } })).toBeNull();
  });

  it("rejects missing, empty or out-of-bound identity fields", () => {
    for (const key of ["sessionId", "liveTurnId", "hostTurnId", "toolCallId"] as const) {
      const missing = { ...READY } as Record<string, unknown>;
      delete missing[key];
      expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: missing }), key).toBeNull();
      expect(
        decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, [key]: "" } }),
        key,
      ).toBeNull();
      expect(
        decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, [key]: "x".repeat(513) } }),
        key,
      ).toBeNull();
    }
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, at: "now" } })).toBeNull();
  });

  it("rejects a ready record whose material is missing or malformed", () => {
    const { modeBlock: _block, ...withoutBlock } = READY as Extract<OmpModeTransition, { state: "ready" }>;
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: withoutBlock })).toBeNull();
    const { hostTools: _tools, ...withoutTools } = READY as Extract<OmpModeTransition, { state: "ready" }>;
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: withoutTools })).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, modeBlock: "" } })).toBeNull();
    expect(
      decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, modeBlock: "x".repeat(16 * 1024 + 1) } }),
    ).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, hostTools: [{ name: "x" }] } })).toBeNull();
    expect(
      decodeModeTransitionDetails({
        [OMP_MODE_TRANSITION_KEY]: { ...READY, hostTools: [{ name: "x", risk: "low", planSafeActions: [], origin: "pi" }] },
      }),
    ).toBeNull();
    // A ready record may not carry the failed form's reason.
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...READY, reason: "hmm" } })).toBeNull();
  });

  it("rejects a failed record that also carries ready material", () => {
    expect(
      decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...FAILED, modeBlock: "PLAN-BLOCK" } }),
    ).toBeNull();
    expect(
      decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...FAILED, hostTools: [] } }),
    ).toBeNull();
    expect(decodeModeTransitionDetails({ [OMP_MODE_TRANSITION_KEY]: { ...FAILED, reason: "" } })).toBeNull();
  });

  it("refuses to encode an oversized record", () => {
    const hostTools = Array.from({ length: 1024 }, (_, index) => ({
      name: `plugin_demo_tool_${index}`,
      risk: "medium" as const,
      planSafeActions: Array.from({ length: 64 }, (_, action) => `action_${action}_${"x".repeat(100)}`),
      origin: "plugin" as const,
    }));
    expect(() => encodeModeTransitionDetails(ready({ hostTools }))).toThrow(/ceiling/);
    // The same shape decoded from a raw envelope is refused too.
    const oversized = { [OMP_MODE_TRANSITION_KEY]: { ...READY, hostTools } };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(OMP_MODE_TRANSITION_MAX_BYTES);
    expect(decodeModeTransitionDetails(oversized)).toBeNull();
  });
});
