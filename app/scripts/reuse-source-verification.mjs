import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VERIFIED_SOURCE = "ae173d361370b1840f6781d8822186d743dce06b";
const DELIVERY_FILES = new Set([
  "app/scripts/verify-release-candidate.mjs", "app/scripts/verify-release-candidate.test.mjs",
  "app/scripts/stage-release-inputs.mjs", "app/scripts/stage-release-inputs.test.mjs",
  "app/scripts/reuse-source-verification.mjs", "app/scripts/reuse-source-verification.test.mjs",
  "app/scripts/check-release-workflows.test.mjs",
  "app/scripts/classify-release-failure.mjs", "app/scripts/classify-release-failure.test.mjs",
  "app/scripts/e2e/installed-product.mjs", "app/scripts/e2e/installed-product.test.mjs",
  "app/apps/desktop/test/omp-plan-submit-e2e.test.mjs",
]);
const CHECKS = [
  "Require the stable version and its release notes", "Run pnpm build:js",
  "Run pnpm --filter @pi-desktop/desktop typecheck", "Run pnpm lint",
  "Run pnpm -r --if-present test", "Run cargo test -p host-core --locked",
];

/** Reuse only completed source checks when every product input is unchanged. */
export function canReuseSourceVerification({ run, jobs, changedPaths }) {
  if (run.repository?.full_name !== "MisterBowie/omp-desktop" ||
      run.head_sha !== VERIFIED_SOURCE || run.path !== ".github/workflows/release.yml") return false;
  const verify = jobs.find(job => job.name === "verify");
  if (verify?.conclusion !== "success" || !CHECKS.every(name =>
    verify.steps?.some(step => step.name === name && step.conclusion === "success"))) return false;
  return changedPaths.every(path => path.startsWith("app/docs/") || DELIVERY_FILES.has(path));
}

export function trackedProductChanges(revision, cwd = process.cwd()) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd,encoding:"utf8"}).trim();
  return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", revision, "HEAD", "--", "app", ".gitmodules", "upstream"], { cwd:root,encoding:"utf8" }).split("\0").filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [runPath, jobsPath] = process.argv.slice(2);
  assert(runPath && jobsPath, "run metadata and job metadata required");
  const changedPaths = trackedProductChanges(VERIFIED_SOURCE);
  console.log(canReuseSourceVerification({run:JSON.parse(readFileSync(runPath)),jobs:JSON.parse(readFileSync(jobsPath)).jobs,changedPaths}) ? "true" : "false");
}
