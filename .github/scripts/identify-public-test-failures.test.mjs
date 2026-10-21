import assert from "node:assert/strict";
import test from "node:test";
import { identifyPublicTestFailures } from "./identify-public-test-failures.mjs";

test("returns only committed source coordinates for a known failed test", () => {
  const sources = new Map([["app/example.test.mjs", '\ntest("known failing example", () => {});']]);
  assert.deepEqual(identifyPublicTestFailures("✖ known failing example token=do-not-publish https://private.invalid", sources), [{ path: "app/example.test.mjs", line: 2 }]);
});
test("passing tests and unknown failure contents produce no output", () => {
  const sources = new Map([["app/example.test.mjs", 'test("known failing example", () => {});']]);
  assert.deepEqual(identifyPublicTestFailures("✔ known failing example\n✖ unknown secret=do-not-publish", sources), []);
});
test("untrusted paths are refused and the output is bounded", () => {
  const source = 'test("known failing example", () => {});';
  const sources = new Map([["private/secret.test.mjs", source], ...Array.from({ length: 50 }, (_, i) => [`app/fixture-${i}.test.ts`, source])]);
  const matches = identifyPublicTestFailures("not ok 1 - known failing example", sources);
  assert.equal(matches.length, 30);
  assert(matches.every((entry) => /^app\/fixture-\d+\.test.ts$/.test(entry.path)));
});
