import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";

// The gate module imports its siblings by `.js` specifier (bundler style), so the
// sibling-resolution hook has to be registered before it is loaded.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { CURSOR_PROVIDER_ID, planGoalCursorRefusal } = await import(
  "../../../packages/shared/src/plan-goal-model-gate.ts"
);

/**
 * T20-R3C: the Cursor identity and the refusal code cross a language boundary.
 *
 * Rust host-core refuses the pair at the write itself (the `sessions` triggers in
 * `crates/host-core/src/plan_goal_guard.rs`) and reports the code the desktop's
 * `ErrorCodes` registry declares; the TypeScript predicate refuses the same pair
 * at the IPC boundaries. Nothing in the compiler spans the two, so this test
 * pins the literals and the guard's construction together — a drift would
 * silently split the invariant instead of failing a build.
 */
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [rustGuard, sharedGate] = await Promise.all([
  read("../../../crates/host-core/src/plan_goal_guard.rs"),
  read("../../../packages/shared/src/plan-goal-model-gate.ts"),
]);

const rustString = (source, name) => {
  const match = new RegExp(`${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`).exec(source);
  assert.ok(match, `crates/host-core/src/plan_goal_guard.rs must declare ${name}`);
  return match[1];
};

test("the Cursor provider id is one literal across Rust and TypeScript", () => {
  assert.equal(CURSOR_PROVIDER_ID, "cursor");
  assert.equal(rustString(rustGuard, "CURSOR_PROVIDER_ID"), CURSOR_PROVIDER_ID);
  // The shared predicate compares the canonical id, so a rename on either side
  // would stop refusing the pair.
  assert.equal(planGoalCursorRefusal("plan", CURSOR_PROVIDER_ID)?.providerId, "cursor");
  assert.match(sharedGate, /export const CURSOR_PROVIDER_ID = "cursor"/);
});

test("the refusal code is one literal across Rust, TypeScript and the registry", () => {
  const rustCode = rustString(rustGuard, "PLAN_GOAL_CURSOR_UNSUPPORTED");
  assert.equal(rustCode, ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED);
  assert.equal(rustCode, "PLAN_GOAL_CURSOR_UNSUPPORTED");
  // `plan_rpc_err` takes the code from the message's first token, so the guard
  // must raise exactly the registered code and nothing else.
  assert.match(rustGuard, /RAISE\(ABORT, '\{code\}'\)/);
});

test("the guard SQL is generated from those constants, not retyped", () => {
  // The trigger text interpolates the constants; a hardcoded literal in the SQL
  // would be a second source of truth the parity check above cannot see. Scope
  // the check to the generator so test fixtures may still write raw rows.
  const generator = /fn guard_sql\(\) -> String \{([\s\S]*?)\n\}/.exec(rustGuard)?.[1] ?? "";
  assert.ok(generator.length > 0, "crates/host-core/src/plan_goal_guard.rs must keep one guard generator");
  assert.match(generator, /new\.provider_id = '\{provider\}'/);
  assert.match(generator, /provider = CURSOR_PROVIDER_ID/);
  assert.match(generator, /code = PLAN_GOAL_CURSOR_UNSUPPORTED/);
  assert.doesNotMatch(generator, /'\s*cursor\s*'/);
  // The pair is refused on both write shapes, and the update guard only tolerates
  // a row that already held exactly that pair (so plan⇄goal hopping is refused).
  assert.match(generator, /BEFORE INSERT ON sessions/);
  assert.match(generator, /BEFORE UPDATE OF mode, provider_id ON sessions/);
  assert.match(generator, /new\.mode IN \('plan', 'goal'\)/);
  assert.match(generator, /NOT \(old\.mode = new\.mode AND old\.provider_id = new\.provider_id\)/);
});
