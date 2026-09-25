import { describe, expect, it } from "vitest";

import { ErrorCodes } from "./errors.js";
import {
  CURSOR_PROVIDER_ID,
  isCursorProviderId,
  planGoalCursorError,
  planGoalCursorRefusal,
} from "./plan-goal-model-gate.js";

/**
 * The predicate is the single source of truth for the T20-R3C product gate, so
 * the boundary table is pinned here: which (mode, provider) pairs are refused,
 * and which inputs are deliberately NOT treated as Cursor.
 */
describe("planGoalCursorRefusal", () => {
  it("refuses the Cursor provider in both contract modes", () => {
    for (const mode of ["plan", "goal"] as const) {
      const refusal = planGoalCursorRefusal(mode, CURSOR_PROVIDER_ID);
      expect(refusal).toMatchObject({
        errorCode: ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED,
        mode,
        providerId: CURSOR_PROVIDER_ID,
      });
      expect(refusal?.message).toMatch(/not supported with Cursor models/);
      // The pair travels with the refusal: `register.ts` forwards `data` to the
      // renderer as `error.details`, so dropping it would lose the pair.
      expect(refusal?.data).toEqual({
        errorCode: ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED,
        mode,
        providerId: CURSOR_PROVIDER_ID,
      });
    }
  });

  it("allows Agent mode with the Cursor provider", () => {
    expect(planGoalCursorRefusal("agent", CURSOR_PROVIDER_ID)).toBeNull();
  });

  it("allows both contract modes with any other provider", () => {
    for (const mode of ["plan", "goal"] as const) {
      expect(planGoalCursorRefusal(mode, "openai")).toBeNull();
      expect(planGoalCursorRefusal(mode, "anthropic")).toBeNull();
      expect(planGoalCursorRefusal(mode, "plugin:acme:cursor")).toBeNull();
      expect(planGoalCursorRefusal(mode, "11111111-2222-4333-8444-555555555555")).toBeNull();
    }
  });

  it("treats missing or non-string identities as no conflict", () => {
    for (const provider of [undefined, null, "", 0, {}, [], true]) {
      expect(planGoalCursorRefusal("plan", provider)).toBeNull();
      expect(planGoalCursorRefusal("goal", provider)).toBeNull();
    }
    for (const mode of [undefined, null, "", "chat", "vibe", 0, {}]) {
      expect(planGoalCursorRefusal(mode, CURSOR_PROVIDER_ID)).toBeNull();
    }
  });

  it("never guesses at a Cursor identity", () => {
    // Display labels, vendor hints and near-misses are not the canonical id.
    for (const provider of ["Cursor", "CURSOR", " cursor", "cursor ", "cursor-agent"]) {
      expect(isCursorProviderId(provider)).toBe(false);
      expect(planGoalCursorRefusal("plan", provider)).toBeNull();
    }
    expect(isCursorProviderId(CURSOR_PROVIDER_ID)).toBe(true);
  });

  it("names the requested mode kind in the refusal", () => {
    expect(planGoalCursorRefusal("plan", CURSOR_PROVIDER_ID)?.mode).toBe("plan");
    expect(planGoalCursorRefusal("goal", CURSOR_PROVIDER_ID)?.mode).toBe("goal");
  });

  it("builds a thrown error that keeps the code, the pair and the message", () => {
    const refusal = planGoalCursorRefusal("goal", CURSOR_PROVIDER_ID);
    expect(refusal).not.toBeNull();
    const error = planGoalCursorError(refusal!);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(refusal!.message);
    expect(error.errorCode).toBe(ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED);
    expect(error.mode).toBe("goal");
    expect(error.providerId).toBe(CURSOR_PROVIDER_ID);
    expect(error.data).toEqual(refusal!.data);
  });
});
