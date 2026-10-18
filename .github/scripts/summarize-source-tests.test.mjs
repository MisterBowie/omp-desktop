import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSourceTests } from "./summarize-source-tests.mjs";

test("only public tracked test paths and fixed categories survive", () => {
  const path = "app/packages/omp-runtime/src/pinned-runtime.test.ts";
  const result = summarizeSourceTests([
    "packages/omp-runtime test: FAIL src/pinned-runtime.test.ts > PRIVATE_MESSAGE",
    "packages/omp-runtime test: ❯ src/pinned-runtime.test.ts:83:22",
    "packages/omp-runtime test: ❯ src/../../private/secret.test.ts:999:1",
    "AssertionError: PRIVATE_VALUE /Users/private/token",
  ].join("\n"), [path]);
  assert.deepEqual(result, { schemaVersion: 1, categories: ["ASSERTION"], locations: [{ path, lines: [0, 83] }] });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|Users/);
});
