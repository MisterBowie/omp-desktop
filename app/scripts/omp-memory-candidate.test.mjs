import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateMemorySnapshot } from "./omp-memory-candidate.mjs";
test("memory candidate binds exact postimages and rejects path escapes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-memory-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.ts"), "original");
  const descriptor = {
    files: [{ path: "source.ts", sha256: createHash("sha256").update("original").digest("hex") }],
  };
  validateMemorySnapshot(root, descriptor);
  writeFileSync(join(root, "source.ts"), "tampered");
  assert.throws(() => validateMemorySnapshot(root, descriptor), /differs/);
  assert.throws(() => validateMemorySnapshot(root, { files: [{ path: "../secret" }] }), /Invalid/);
});
