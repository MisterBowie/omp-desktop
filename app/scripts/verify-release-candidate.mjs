import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const NATIVE_STEPS = ["Build the fork's host native addon", "Build all release installers", "Verify packaged runtime and actual installed workflow"];

/** Bind publication to successful native jobs and their immutable artifacts. */
export function verifyReleaseCandidate({ run, jobs, artifacts, version, revision, currentRunId = null }) {
  assert(/^\d+\.\d+\.\d+$/.test(version), "stable version required");
  assert(/^[a-f0-9]{40}$/.test(revision), "fixed source revision required");
  assert.equal(run.repository?.full_name, "MisterBowie/omp-desktop", "wrong repository");
  assert.equal(run.path, ".github/workflows/release.yml", "wrong build workflow");
  assert.equal(run.event, "push", "tag push required");
  assert.equal(run.head_sha, revision, "candidate source mismatch");
  const sameRun = String(run.id) === String(currentRunId);
  if (sameRun) {
    assert.equal(run.head_branch, `v${version}`, "wrong stable tag");
  } else {
    assert.equal(run.status, "completed", "candidate is incomplete");
    assert.equal(run.conclusion, "success", "candidate did not pass");
    assert(run.head_branch.startsWith(`release-check-${version}-`), "wrong candidate tag");
  }
  const verify = jobs.find(job => job.name === "verify");
  assert.equal(verify?.conclusion, "success", "source verification did not pass");
  const native = jobs.filter(job => job.name.startsWith("build ("));
  assert.equal(native.length, 4, "all four native targets are required");
  for (const job of native) {
    assert.equal(job.conclusion, "success", `${job.name} did not pass`);
    for (const name of NATIVE_STEPS) {
      assert.equal(job.steps?.find(step => step.name === name)?.conclusion, "success", `${job.name}: ${name} did not pass`);
    }
  }
  const expected = TARGETS.flatMap(target => [`release-${target}`, `validation-${target}`]).sort();
  assert.deepEqual(artifacts.map(artifact => artifact.name).sort(), expected, "incomplete native artifacts");
  for (const artifact of artifacts) {
    assert.equal(artifact.expired, false, "expired candidate artifact");
    assert(artifact.size_in_bytes > 0, "empty candidate artifact");
    assert.equal(artifact.workflow_run?.head_sha, revision, "artifact source mismatch");
    assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest), "artifact digest required");
  }
  return { schema: "omp-desktop.accepted-release-candidate/1", version, sourceRevision: revision, runId: run.id, runUrl: run.html_url, nativeJobs: native.map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion })), artifacts: artifacts.map(({ id, name, digest, size_in_bytes }) => ({ id, name, digest, bytes: size_in_bytes })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [runPath, jobsPath, artifactsPath, output] = process.argv.slice(2);
  const receipt = verifyReleaseCandidate({
    run: JSON.parse(readFileSync(runPath)), jobs: JSON.parse(readFileSync(jobsPath)).jobs,
    artifacts: JSON.parse(readFileSync(artifactsPath)).artifacts,
    version: process.env.RELEASE_VERSION, revision: process.env.RELEASE_REVISION,
    currentRunId: process.env.GITHUB_RUN_ID,
  });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`Accepted native candidate ${receipt.runId} at ${receipt.sourceRevision}`);
}
