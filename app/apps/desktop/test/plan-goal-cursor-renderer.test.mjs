import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreModuleSync } from "./helpers/source-contracts.mjs";

/**
 * T20-R3C renderer half of the Plan/Goal × Cursor gate.
 *
 * The main-process seams are behaviour-tested in `plan-goal-cursor-gate.test.mjs`;
 * these are the renderer contracts that keep the invalid choice out of the
 * composer and explain it in the user's language. The gate predicate itself is
 * pinned by `packages/shared/src/plan-goal-model-gate.test.ts`.
 */
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [sessionSlice, modelMenuHook, modelPicker, errorsSource, englishSource, chineseSource] =
  await Promise.all([
    readStoreModuleSync("slices/session-slice.ts"),
    read("../src/features/chat/composer/hooks/useComposerModelMenu.ts"),
    read("../src/features/chat/composer/ComposerModelPicker.tsx"),
    read("../../../packages/shared/src/errors.ts"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);

test("the refusal code is registered once and localized", () => {
  assert.match(errorsSource, /PLAN_GOAL_CURSOR_UNSUPPORTED: "PLAN_GOAL_CURSOR_UNSUPPORTED"/);
  assert.match(englishSource, /PLAN_GOAL_CURSOR_UNSUPPORTED:/);
  assert.match(chineseSource, /PLAN_GOAL_CURSOR_UNSUPPORTED:/);
});

test("the model menu withholds the Cursor provider in Plan and Goal mode", () => {
  assert.match(modelMenuHook, /import \{[^}]*isCursorProviderId[^}]*\} from "@pi-desktop\/shared"/s);
  assert.match(modelMenuHook, /if \(mode === "agent"\) return \{ modelGroups: groups, hiddenCursorProviders: 0 \}/);
  assert.match(modelMenuHook, /groups\.filter\(\s*\(group\) => !isCursorProviderId\(group\.provider\.id\)/);
  assert.match(modelMenuHook, /hiddenCursorProviders/);
  // The withheld entries are explained, not silently missing.
  assert.match(modelPicker, /t\("errors\.PLAN_GOAL_CURSOR_UNSUPPORTED"\)/);
  assert.match(modelPicker, /hiddenCursorProviders > 0/);
});

test("the renderer writer refuses the pair before it reaches IPC", () => {
  assert.match(sessionSlice, /planGoalCursorRefusal/);
  assert.match(sessionSlice, /i18n\.t\(`errors\.\$\{planGoalRefusal\.errorCode\}`\)/);
  // Both the draft and the live-session branches fall through it: the guard is
  // placed before the branch on `activeSessionId`.
  const guardIndex = sessionSlice.indexOf("const planGoalRefusal = planGoalCursorRefusal(");
  const draftIndex = sessionSlice.indexOf("if (!sessionId) {");
  assert.ok(guardIndex >= 0 && draftIndex > guardIndex, "the guard must precede the draft branch");
  assert.match(sessionSlice, /config\.providerId \?\? boundProviderId \?\? null/);
});

test("an invalid model pin is skipped with the reason instead of forking local state", () => {
  const pinIndex = sessionSlice.indexOf("const pinRefusal = planGoalCursorRefusal(selected.mode, pin.providerId)");
  const optimisticIndex = sessionSlice.indexOf("applyOptimisticSessionConfiguration(session, pin)");
  assert.ok(pinIndex >= 0, "the pin path must reuse the shared predicate");
  assert.ok(optimisticIndex > pinIndex, "the optimistic pin must sit behind the refusal check");
});
