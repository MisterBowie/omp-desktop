import assert from "node:assert/strict";
import test from "node:test";
import { LatestWinsGate } from "../src/lib/latest-wins.ts";

test("latest request wins and stale tokens are rejected", () => {
  const gate = new LatestWinsGate();
  const a = gate.begin();
  assert.ok(gate.isCurrent(a));
  const b = gate.begin();
  assert.ok(gate.isCurrent(b));
  assert.ok(!gate.isCurrent(a), "stale A must not land after B started");
});

test("invalidate represents close/reopen", () => {
  const gate = new LatestWinsGate();
  const a = gate.begin();
  gate.invalidate();
  assert.ok(!gate.isCurrent(a));
  const b = gate.begin();
  assert.ok(gate.isCurrent(b));
});
