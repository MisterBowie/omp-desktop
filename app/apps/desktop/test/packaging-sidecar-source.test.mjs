/**
 * The packaging workflows must prepare the controlled OMP fork before they call
 * a release entry (M5/T20-R4B, ADR 0307).
 *
 * Every `dist:*` command ends in `scripts/release-package.mjs`, whose preflight
 * validates the fork checkout and then compiles (host target) or verifies
 * (cross target) the bundled sidecar. A clean runner that only checks out this
 * repository has neither: the preflight would fail on the missing source before
 * it ever reached electron-builder. So each lane that packages has to
 *
 *   - check out `MisterBowie/oh-my-pi` at exactly the commit the patch manifest
 *     pins, with enough history that `git diff <base> HEAD` and
 *     `git apply --check --reverse` can run,
 *   - point `OMP_SIDECAR_SOURCE` at that checkout,
 *   - install the pinned Bun and the fork's frozen dependencies.
 *
 * The repository and commit are read from `patches/oh-my-pi/manifest.json`, so
 * this test compares the workflow against the pin instead of duplicating it.
 * Nothing here needs the fork checkout or a compiler.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const manifest = JSON.parse(await read("../../../patches/oh-my-pi/manifest.json"));
/** `actions/checkout` takes `owner/repo`; the manifest records a full URL. */
const forkRepository = new URL(manifest.fork.repository).pathname.replace(/^\//, "");
const forkCommit = manifest.fork.commit;
const sidecarDir = ".omp-sidecar-source";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const workflows = [
  ["release.yml", await read("../../../.github/workflows/release.yml")],
  ["linux-package.yml", await read("../../../.github/workflows/linux-package.yml")],
];

/** The job block that packages, so the checks cannot be satisfied elsewhere. */
function packagingJob(source, name) {
  if (name === "release.yml") {
    const job = source.match(/^  build:\n[\s\S]*?(?=^  publish:)/m)?.[0];
    assert.ok(job, `${name}: the build job is missing`);
    return job;
  }
  return source;
}

test("every packaging lane checks out the pinned fork the manifest names", () => {
  for (const [name, source] of workflows) {
    const job = packagingJob(source, name);
    const checkouts = [...job.matchAll(/uses: actions\/checkout@v\d+\n\s+with:\n([\s\S]*?)(?=\n      - |\n      $)/g)].map(
      (match) => match[1],
    );
    const checkout = checkouts.find((block) => block.includes(`path: ${sidecarDir}`));
    assert.ok(checkout, `${name}: the OMP fork must be checked out into ${sidecarDir}`);
    assert.match(
      checkout,
      new RegExp(`repository: ${escapeRegExp(forkRepository)}`),
      `${name}: the sidecar source must be ${forkRepository}`,
    );
    assert.match(
      checkout,
      new RegExp(`ref: ${forkCommit}`),
      `${name}: the sidecar source must be the manifest's commit`,
    );
    assert.match(
      checkout,
      /fetch-depth: 0/,
      `${name}: the build re-proves base..HEAD, so the checkout needs its history`,
    );
    assert.doesNotMatch(
      checkout,
      /can1357/,
      `${name}: can1357/oh-my-pi stays a read-only upstream, never a build source`,
    );
    // No lane may substitute an upstream release asset for the controlled build.
    assert.doesNotMatch(job, /can1357|gh release download/, `${name}: no upstream asset download`);
  }
});

test("every packaging lane points OMP_SIDECAR_SOURCE at that checkout", () => {
  for (const [name, source] of workflows) {
    const job = packagingJob(source, name);
    assert.match(
      job,
      new RegExp(
        `OMP_SIDECAR_SOURCE: \\$\\{\\{ github\\.workspace \\}\\}/${escapeRegExp(sidecarDir)}`,
      ),
      `${name}: the preflight must be told where the controlled source is`,
    );
  }
});

test("every packaging lane installs the pinned Bun and frozen fork dependencies", () => {
  for (const [name, source] of workflows) {
    const job = packagingJob(source, name);
    assert.match(job, /uses: oven-sh\/setup-bun@v\d+/, `${name}: Bun must be installed`);
    assert.match(job, /bun-version: "1\.4\.\d+"/, `${name}: the Bun version must be pinned`);
    assert.match(
      job,
      new RegExp(
        `working-directory: ${escapeRegExp(sidecarDir)}\\n\\s+run: bun install --frozen-lockfile`,
      ),
      `${name}: the fork's dependencies must be installed from its lockfile`,
    );
    const prepare = job.indexOf("bun install --frozen-lockfile");
    const packaging = job.search(/run: pnpm (?:--filter @pi-desktop\/desktop )?run (?:dist:|dist\b|\$\{\{ matrix\.dist \}\})/);
    assert.ok(packaging > 0, `${name}: the packaging step is missing`);
    assert.ok(
      prepare < packaging,
      `${name}: the sidecar source must be prepared before the release entry runs`,
    );
  }
});
