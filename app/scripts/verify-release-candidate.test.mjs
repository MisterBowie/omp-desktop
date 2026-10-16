import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseCandidate } from "./verify-release-candidate.mjs";

function fixture() {
  const revision = "a".repeat(40);
  return {
    version: "0.1.0", revision,
    run: { id: 123, repository: { full_name: "MisterBowie/omp-desktop" }, path: ".github/workflows/release.yml", event: "push", head_sha: revision, head_branch: "release-check-0.1.0-aaaaaaa", status: "completed", conclusion: "success" },
    jobs: [{ name: "verify", conclusion: "success" }, ...["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].map(target => ({ name: `build (${target})`, conclusion: "success", steps: ["Build the fork's host native addon", "Build all release installers", "Verify packaged runtime and actual installed workflow"].map(name => ({ name, conclusion: "success" })) }))],
    artifacts: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].flatMap(target => ["release", "validation"].map(kind => ({ name: `${kind}-${target}`, expired: false, size_in_bytes: 100, workflow_run: { head_sha: revision }, digest: "sha256:" + "b".repeat(64) }))),
  };
}

test("accepts the exact fully tested candidate and keeps its source revision", () => {
  const f = fixture(), receipt = verifyReleaseCandidate(f);
  assert.equal(receipt.sourceRevision, f.revision); assert.equal(receipt.nativeJobs.length, 4); assert.equal(receipt.artifacts.length, 8);
});
test("refuses an unfinished, failed or different-source candidate", () => {
  for (const patch of [{ status: "in_progress" }, { conclusion: "failure" }, { head_sha: "c".repeat(40) }, { head_branch: "other-0.1.0" }, { path: "other.yml" }]) {
    const f = fixture(); Object.assign(f.run, patch); assert.throws(() => verifyReleaseCandidate(f));
  }
});
test("refuses a skipped native acceptance, missing target or stale artifact", () => {
  for (const mutate of [f => { f.jobs[1].steps[2].conclusion = "skipped"; }, f => f.jobs.pop(), f => f.artifacts.pop(), f => { f.artifacts[0].expired = true; }, f => { f.artifacts[0].workflow_run.head_sha = "c".repeat(40); }, f => { f.artifacts[0].digest = null; }]) {
    const f = fixture(); mutate(f); assert.throws(() => verifyReleaseCandidate(f));
  }
});
test("a current stable run may publish only after all its native jobs passed", () => {
  const f = fixture(); f.currentRunId = "123"; f.run.head_branch = "v0.1.0"; f.run.status = "in_progress"; f.run.conclusion = null;
  verifyReleaseCandidate(f); f.jobs[1].conclusion = "failure"; assert.throws(() => verifyReleaseCandidate(f));
});
