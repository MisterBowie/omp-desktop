/**
 * The three-platform test-package staging and assembly entries
 * (`M6` three-platform delivery, user goal #9).
 *
 * The packaging workflow builds installers on three native runners and then has
 * exactly two jobs left: turn one platform's output into reviewed release
 * assets, and turn the three reviewed platforms into one prerelease. Both are
 * scripts (`scripts/stage-test-package.mjs`, `scripts/assemble-test-release.mjs`)
 * so they can be driven here with fixtures instead of only inside a tag run.
 *
 * These tests pin the refusals, not the plumbing: an artifact from another
 * revision, another patch level, another platform set, a mismatch between what
 * a record declares and what is on disk, an updater feed, or a stray payload all
 * have to stop the release. The working directory is a temporary tree; nothing
 * here needs a compiler, a package build or the network.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const stageModule = await import("../../../scripts/stage-test-package.mjs");
const assembleModule = await import("../../../scripts/assemble-test-release.mjs");

const MANIFEST = JSON.parse(readFileSync(join(here, "../../../patches/oh-my-pi/manifest.json"), "utf8"));
const REVISION = "860c264177314f5c9501f90c2ef6bcbcd6aaa11b";
const VERSION = "0.15.2";
const STAGE = "m5-test-20261003";
const RUN_URL = "https://github.com/MisterBowie/omp-desktop/actions/runs/1";

const scratch = [];
function makeScratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}
test.after(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/**
 * A packaged `Resources` tree carrying the manifest's pins, plus the two
 * acceptance artifacts the release requires: the packaged-runtime report and
 * the Plan/Goal regression log.
 */
function fixtureAcceptance(root, { platform, arch, patchLevel = MANIFEST.patchLevel, gate = "gate-bytes" } = {}) {
  const resources = join(root, `Resources ${platform}`);
  const runtimeDir = join(resources, "omp-runtime");
  write(join(runtimeDir, "omp"), "sidecar-bytes");
  write(join(runtimeDir, "extensions", "omp-desktop-gate.js"), gate);
  const binary = readFileSync(join(runtimeDir, "omp"));
  const gateBytes = readFileSync(join(runtimeDir, extensionsPath()));
  write(
    join(runtimeDir, "provenance.json"),
    `${JSON.stringify(
      {
        schema: "omp-desktop.bundled-sidecar/3",
        fork: { repository: MANIFEST.fork.repository, commit: MANIFEST.fork.commit, tree: MANIFEST.fork.tree },
        upstreamBase: { sha: MANIFEST.base.sha, version: MANIFEST.base.version },
        patchLevel,
        ompVersion: MANIFEST.base.version,
        desktopVersion: VERSION,
        platform,
        arch,
        binary: { filename: platform === "win32" ? "omp.exe" : "omp", bytes: binary.length, sha256: hashOf(binary) },
        extensions: [
          { path: extensionsPath(), bytes: gateBytes.length, sha256: hashOf(gateBytes) },
        ],
        build: { tool: "bun", bunVersion: "1.4.2", bytecode: true },
      },
      null,
      2,
    )}\n`,
  );
  const report = join(root, `report-${platform}.json`);
  write(
    report,
    `${JSON.stringify(
      {
        mode: "run",
        resources,
        binary: { path: join(runtimeDir, "omp"), bytes: binary.length, sha256: hashOf(binary) },
        gate: { path: join(runtimeDir, extensionsPath()), bytes: gateBytes.length, sha256: hashOf(gateBytes) },
        provenance: { ompVersion: MANIFEST.base.version, patchLevel, forkCommit: MANIFEST.fork.commit, platform, arch },
        run: {
          runtimeVersion: MANIFEST.base.version,
          protocolVersion: 2,
          getState: true,
          gateLoadControl: "refused",
          stop: { stopped: true, reaped: true, cleaned: true },
          leftoverRuns: 0,
          child: { readable: true },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { resources, report };
}

function extensionsPath() {
  return join("extensions", "omp-desktop-gate.js");
}

const hashOf = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A `node --test` transcript: the counts the staging entry parses. */
function writeTestLog(root, { pass = 10, fail = 0, skipped = 0 } = {}) {
  return write(
    join(root, "plan-goal.txt"),
    [
      "# tests 10",
      `# pass ${pass}`,
      `# fail ${fail}`,
      `# cancelled 0`,
      `# skipped ${skipped}`,
      "# todo 0",
      "# duration_ms 1234",
    ].join("\n") + "\n",
  );
}

/** An electron-builder output directory for one platform. */
function fixtureReleaseDir(root, platform, { version = VERSION, extra = null, updaterFeeds = true } = {}) {
  const releaseDir = join(root, `release-${platform}`);
  mkdirSync(releaseDir, { recursive: true });
  const files =
    platform === "darwin"
      ? [`OMP-Desktop-${version}-arm64.dmg`, `OMP-Desktop-${version}-arm64-mac.zip`]
      : platform === "win32"
        ? [`OMP-Desktop-Setup-${version}.exe`, `OMP-Desktop-Portable-${version}.exe`]
        : [`OMP-Desktop-${version}-x86_64.AppImage`, `omp-desktop_${version}_amd64.deb`, `omp-desktop-${version}-x86_64.rpm`];
  for (const name of files) write(join(releaseDir, name), `${name} payload\n`);
  if (updaterFeeds) {
    write(join(releaseDir, platform === "linux" ? "latest-linux.yml" : platform === "win32" ? "latest.yml" : "latest-mac.yml"), "version: 0.15.2\n");
    write(join(releaseDir, files[0] + ".blockmap"), "blockmap-bytes\n");
  }
  if (extra) write(join(releaseDir, extra), "unexpected\n");
  return releaseDir;
}

function stageArgs({ root, platform, arch, acceptance, releaseDir, log }) {
  return {
    platform,
    arch,
    releaseDir,
    resources: acceptance.resources,
    verifyReport: acceptance.report,
    planGoalLog: log,
    out: join(root, `stage-${platform}`),
    version: VERSION,
    stage: STAGE,
    revision: REVISION,
    runId: "12345",
    runAttempt: "1",
    runUrl: RUN_URL,
    manifest: join(here, "../../../patches/oh-my-pi/manifest.json"),
  };
}

test("staging publishes exactly the platform's payloads under release names", () => {
  const root = makeScratch("stage-linux-");
  const acceptance = fixtureAcceptance(root, { platform: "linux", arch: "x64" });
  const releaseDir = fixtureReleaseDir(root, "linux");
  const log = writeTestLog(root);
  const record = stageModule.stagePackage(stageArgs({ root, platform: "linux", arch: "x64", acceptance, releaseDir, log }));

  assert.deepEqual(record.assets.map((asset) => asset.name).sort(), [
    `OMP-Desktop-${VERSION}-${STAGE}-linux-x64.AppImage`,
    `OMP-Desktop-${VERSION}-${STAGE}-linux-x64.deb`,
    `OMP-Desktop-${VERSION}-${STAGE}-linux-x64.rpm`,
  ]);
  assert.equal(record.revision, REVISION);
  assert.equal(record.pins.patchLevel, MANIFEST.patchLevel);
  assert.equal(record.pins.forkCommit, MANIFEST.fork.commit);
  assert.deepEqual(record.planGoalRegression, { pass: 10, fail: 0, skipped: 0 });
  // The staged bytes are the built bytes, copied under the release name.
  for (const asset of record.assets) {
    assert.equal(sha256(join(root, "stage-linux", asset.name)), asset.sha256);
    assert.equal(readFileSync(join(root, "stage-linux", asset.name), "utf8"), `${asset.sourceName} payload\n`);
  }
  // An updater feed and a blockmap are recorded as excluded, never published.
  assert.deepEqual(
    record.excluded.map((entry) => entry.name).sort(),
    [`OMP-Desktop-${VERSION}-x86_64.AppImage.blockmap`, "latest-linux.yml"].sort(),
  );
  // The staged directory holds the payload and the record only.
  const stagedDir = join(root, "stage-linux");
  assert.deepEqual(
    readdirSync(stagedDir).sort(),
    [...record.assets.map((asset) => asset.name), "build-record.json"].sort(),
  );
  assert.deepEqual(
    readFileSync(join(stagedDir, "build-record.json"), "utf8"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
});

test("staging refuses a package that is not the controlled patch level", () => {
  const root = makeScratch("stage-wrong-pin-");
  const acceptance = fixtureAcceptance(root, { platform: "linux", arch: "x64", patchLevel: "62bc57b+omp-desktop.4" });
  const releaseDir = fixtureReleaseDir(root, "linux");
  const log = writeTestLog(root);
  assert.throws(
    () => stageModule.stagePackage(stageArgs({ root, platform: "linux", arch: "x64", acceptance, releaseDir, log })),
    /patchLevel/,
  );
});

test("staging refuses a report that verified a different resources tree", () => {
  const root = makeScratch("stage-other-tree-");
  const acceptance = fixtureAcceptance(root, { platform: "win32", arch: "x64" });
  const report = JSON.parse(readFileSync(acceptance.report, "utf8"));
  report.resources = "/somewhere/else/Resources";
  write(acceptance.report, `${JSON.stringify(report, null, 2)}\n`);
  const releaseDir = fixtureReleaseDir(root, "win32");
  const log = writeTestLog(root);
  assert.throws(
    () => stageModule.stagePackage(stageArgs({ root, platform: "win32", arch: "x64", acceptance, releaseDir, log })),
    /isolated copy/,
  );
});

test("staging refuses a runtime that was not reclaimed or whose gate control is unproven", () => {
  for (const [mutate, pattern] of [
    [(report) => (report.run.stop.reaped = false), /reaped/],
    [(report) => (report.run.gateLoadControl = "timeout"), /gateLoadControl/],
    [(report) => (report.run.leftoverRuns = 1), /run directories/],
    [(report) => (report.run.protocolVersion = 1), /protocol v1/],
    [(report) => (report.binary.sha256 = "0".repeat(64)), /not the packaged one/],
    [(report) => (report.gate.sha256 = "0".repeat(64)), /verified gate/],
  ]) {
    const root = makeScratch("stage-bad-report-");
    const acceptance = fixtureAcceptance(root, { platform: "darwin", arch: "arm64" });
    const report = JSON.parse(readFileSync(acceptance.report, "utf8"));
    mutate(report);
    write(acceptance.report, `${JSON.stringify(report, null, 2)}\n`);
    const releaseDir = fixtureReleaseDir(root, "darwin");
    const log = writeTestLog(root);
    assert.throws(
      () => stageModule.stagePackage(stageArgs({ root, platform: "darwin", arch: "arm64", acceptance, releaseDir, log })),
      pattern,
    );
  }
});

test("the regression counts are read from either reporter, and only from a complete run", () => {
  // `node --test` writes the same summary under the TAP reporter (`# pass 15`)
  // and the spec reporter (`ℹ pass 15`).
  assert.deepEqual(stageModule.parseTestCounts("# tests 15\n# pass 15\n# fail 0\n# skipped 0\n"), {
    pass: 15,
    fail: 0,
    skipped: 0,
  });
  assert.deepEqual(stageModule.parseTestCounts("ℹ tests 15\nℹ pass 15\nℹ fail 0\nℹ skipped 0\n"), {
    pass: 15,
    fail: 0,
    skipped: 0,
  });
  // A truncated run (no summary) and a doubled one are both refusals: neither
  // may be read as "nothing failed".
  assert.throws(() => stageModule.parseTestCounts("ℹ pass 15\n"), /"fail" summary line \(found 0\)/);
  assert.throws(
    () => stageModule.parseTestCounts("# pass 15\n# pass 15\n# fail 0\n# skipped 0\n"),
    /"pass" summary line \(found 2\)/,
  );
});

test("staging refuses a regression that failed or never ran", () => {
  for (const [log, pattern] of [
    [{ pass: 9, fail: 1 }, /failed 1 case/],
    [{ pass: 0, fail: 0, skipped: 10 }, /no passing case/],
  ]) {
    const root = makeScratch("stage-bad-log-");
    const acceptance = fixtureAcceptance(root, { platform: "linux", arch: "x64" });
    const releaseDir = fixtureReleaseDir(root, "linux");
    assert.throws(
      () =>
        stageModule.stagePackage(
          stageArgs({ root, platform: "linux", arch: "x64", acceptance, releaseDir, log: writeTestLog(root, log) }),
        ),
      pattern,
    );
  }

  const root = makeScratch("stage-truncated-log-");
  const acceptance = fixtureAcceptance(root, { platform: "linux", arch: "x64" });
  const releaseDir = fixtureReleaseDir(root, "linux");
  const truncated = write(join(root, "truncated.txt"), "# pass 3\n");
  assert.throws(
    () => stageModule.stagePackage(stageArgs({ root, platform: "linux", arch: "x64", acceptance, releaseDir, log: truncated })),
    /must contain exactly one "fail" summary line/,
  );
});

test("staging refuses a missing or unexpected package output", () => {
  const rootMissing = makeScratch("stage-missing-");
  const acceptanceMissing = fixtureAcceptance(rootMissing, { platform: "linux", arch: "x64" });
  const releaseMissing = fixtureReleaseDir(rootMissing, "linux");
  rmSync(join(releaseMissing, `omp-desktop-${VERSION}-x86_64.rpm`));
  assert.throws(
    () =>
      stageModule.stagePackage(
        stageArgs({
          root: rootMissing,
          platform: "linux",
          arch: "x64",
          acceptance: acceptanceMissing,
          releaseDir: releaseMissing,
          log: writeTestLog(rootMissing),
        }),
      ),
    /expected exactly one omp-desktop-0\.15\.2-x86_64\.rpm/,
  );

  const rootStray = makeScratch("stage-stray-");
  const acceptanceStray = fixtureAcceptance(rootStray, { platform: "linux", arch: "x64" });
  const releaseStray = fixtureReleaseDir(rootStray, "linux", { extra: "omp-desktop_0.15.2_arm64.deb" });
  assert.throws(
    () =>
      stageModule.stagePackage(
        stageArgs({
          root: rootStray,
          platform: "linux",
          arch: "x64",
          acceptance: acceptanceStray,
          releaseDir: releaseStray,
          log: writeTestLog(rootStray),
        }),
      ),
    /unexpected package output/,
  );
});

test("staging refuses a platform/architecture the stage does not deliver", () => {
  const root = makeScratch("stage-arch-");
  const acceptance = fixtureAcceptance(root, { platform: "darwin", arch: "x64" });
  const releaseDir = fixtureReleaseDir(root, "darwin");
  const log = writeTestLog(root);
  assert.throws(
    () => stageModule.stagePackage(stageArgs({ root, platform: "darwin", arch: "x64", acceptance, releaseDir, log })),
    /arm64-only/,
  );
});

/** A staged release tree for one platform, as the workflow uploads it. */
function fixtureStagedPlatform(input, { platform, arch, revision = REVISION, version = VERSION, stage = STAGE } = {}) {
  const dir = join(input, `${platform}-${arch}`);
  mkdirSync(dir, { recursive: true });
  const assets = [];
  const files =
    platform === "darwin"
      ? [`OMP-Desktop-${version}-${stage}-macos-${arch}.dmg`, `OMP-Desktop-${version}-${stage}-macos-${arch}.zip`]
      : platform === "win32"
        ? [`OMP-Desktop-${version}-${stage}-windows-${arch}-setup.exe`, `OMP-Desktop-${version}-${stage}-windows-${arch}-portable.exe`]
        : [`OMP-Desktop-${version}-${stage}-linux-${arch}.AppImage`, `OMP-Desktop-${version}-${stage}-linux-${arch}.deb`, `OMP-Desktop-${version}-${stage}-linux-${arch}.rpm`];
  for (const name of files) {
    const path = write(join(dir, name), `${name} payload\n`);
    assets.push({ kind: "fixture", name, bytes: readFileSync(path).length, sha256: sha256(path), sourceName: "source" });
  }
  write(
    join(dir, "build-record.json"),
    `${JSON.stringify(
      {
        schema: "omp-desktop.test-package/1",
        platform,
        arch,
        version,
        stage,
        revision,
        run: { id: "12345", attempt: "1", url: RUN_URL },
        pins: {
          patchLevel: MANIFEST.patchLevel,
          forkRepository: MANIFEST.fork.repository,
          forkCommit: MANIFEST.fork.commit,
          forkTree: MANIFEST.fork.tree ?? null,
          baseSha: MANIFEST.base.sha,
          baseVersion: MANIFEST.base.version,
        },
        packagedRuntime: {
          provenance: { ompVersion: MANIFEST.base.version, patchLevel: MANIFEST.patchLevel, platform, arch },
          acceptance: { resources: "/isolated/Resources", protocolVersion: 2, getState: true, gateLoadControl: "refused", stop: { stopped: true, reaped: true, cleaned: true }, leftoverRuns: 0, childEnvironmentReadable: true },
        },
        planGoalRegression: { pass: 10, fail: 0, skipped: 0 },
        excluded: [],
        assets,
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

function assembleArgs({ input, out }) {
  return {
    input,
    out,
    tag: STAGE,
    revision: REVISION,
    version: VERSION,
    runUrl: RUN_URL,
    manifest: join(here, "../../../patches/oh-my-pi/manifest.json"),
  };
}

function threePlatformInput(prefix) {
  const root = makeScratch(prefix);
  const input = join(root, "dist");
  fixtureStagedPlatform(input, { platform: "darwin", arch: "arm64" });
  fixtureStagedPlatform(input, { platform: "win32", arch: "x64" });
  fixtureStagedPlatform(input, { platform: "linux", arch: "x64" });
  return { root, input, out: join(root, "release") };
}

test("assembly requires the three-platform set and re-hashes every payload", () => {
  const { input, out } = threePlatformInput("assemble-ok-");
  const combined = assembleModule.assembleRelease(assembleArgs({ input, out }));
  assert.equal(combined.revision, REVISION);
  assert.deepEqual(combined.platforms.map((entry) => `${entry.platform}/${entry.arch}`), ["darwin/arm64", "linux/x64", "win32/x64"]);
  const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
  for (const line of sums.trim().split("\n")) {
    const [digest, name] = line.split(/\s+/);
    assert.equal(sha256(join(out, name)), digest, `${name} must match its checksum line`);
  }
  // The checksum list describes the payload only — never itself, and never a
  // previous list left in the output directory by an earlier assembly.
  assert.doesNotMatch(sums, /SHA256SUMS/);
  assert.doesNotMatch(sums, /BUILD-RECORD|RELEASE-NOTES/);

  // Re-assembling into the same directory (as a rerun of the publish job would)
  // produces the same list: it cannot certify its own stale digest.
  const again = assembleModule.assembleRelease(assembleArgs({ input, out }));
  assert.equal(readFileSync(join(out, "SHA256SUMS.txt"), "utf8"), sums);
  assert.equal(again.platforms.length, 3);
});

test("assembly refuses a platform set that is not exactly the three delivered ones", () => {
  const { input, out } = threePlatformInput("assemble-missing-");
  rmSync(join(input, "linux-x64"), { recursive: true, force: true });
  assert.throws(() => assembleModule.assembleRelease(assembleArgs({ input, out })), /exactly darwin\/arm64, linux\/x64, win32\/x64/);
});

test("assembly refuses artifacts from another revision, stage or patch level", () => {
  for (const [fixture, pattern] of [
    [{ revision: "0".repeat(40) }, /was built from/],
    [{ stage: "m5-test-other" }, /was packaged for/],
    [{ version: "9.9.9" }, /is version 9\.9\.9/],
  ]) {
    const root = makeScratch("assemble-identity-");
    const input = join(root, "dist");
    fixtureStagedPlatform(input, { platform: "darwin", arch: "arm64" });
    fixtureStagedPlatform(input, { platform: "win32", arch: "x64" });
    fixtureStagedPlatform(input, { platform: "linux", arch: "x64", ...fixture });
    assert.throws(() => assembleModule.assembleRelease(assembleArgs({ input, out: join(root, "release") })), pattern);
  }

  const root = makeScratch("assemble-pin-");
  const input = join(root, "dist");
  fixtureStagedPlatform(input, { platform: "darwin", arch: "arm64" });
  fixtureStagedPlatform(input, { platform: "win32", arch: "x64" });
  const linuxDir = fixtureStagedPlatform(input, { platform: "linux", arch: "x64" });
  const record = JSON.parse(readFileSync(join(linuxDir, "build-record.json"), "utf8"));
  record.pins.patchLevel = "62bc57b+omp-desktop.4";
  write(join(linuxDir, "build-record.json"), `${JSON.stringify(record, null, 2)}\n`);
  assert.throws(() => assembleModule.assembleRelease(assembleArgs({ input, out: join(root, "release") })), /pins patch level/);
});

test("assembly refuses payload bytes that disagree with their record, and stray payloads", () => {
  const rootBytes = makeScratch("assemble-bytes-");
  const inputBytes = join(rootBytes, "dist");
  fixtureStagedPlatform(inputBytes, { platform: "darwin", arch: "arm64" });
  fixtureStagedPlatform(inputBytes, { platform: "win32", arch: "x64" });
  const linuxDir = fixtureStagedPlatform(inputBytes, { platform: "linux", arch: "x64" });
  write(join(linuxDir, `OMP-Desktop-${VERSION}-${STAGE}-linux-x64.deb`), "tampered\n");
  assert.throws(
    () => assembleModule.assembleRelease(assembleArgs({ input: inputBytes, out: join(rootBytes, "release") })),
    /does not match its record/,
  );

  const rootStray = makeScratch("assemble-stray-");
  const inputStray = join(rootStray, "dist");
  fixtureStagedPlatform(inputStray, { platform: "darwin", arch: "arm64", });
  fixtureStagedPlatform(inputStray, { platform: "win32", arch: "x64" });
  const dir = fixtureStagedPlatform(inputStray, { platform: "linux", arch: "x64" });
  write(join(dir, "latest-linux.yml"), "version: 0.15.2\n");
  assert.throws(
    () => assembleModule.assembleRelease(assembleArgs({ input: inputStray, out: join(rootStray, "release") })),
    /only publishes its payload and record/,
  );
});

test("assembly refuses to assemble or verify anything but a controlled m5-test-* tag", () => {
  // The tag rule is a policy gate at the command line: a run that was not
  // triggered by `m5-test-*` must not build a release directory at all.
  const parsed = assembleModule.parseArgs([
    "--input",
    "dist",
    "--out",
    "release",
    "--tag",
    STAGE,
    "--revision",
    REVISION,
    "--version",
    VERSION,
    "--run-url",
    RUN_URL,
  ]);
  assert.equal(parsed.tag, STAGE);
  assert.throws(
    () =>
      assembleModule.parseArgs([
        "--input",
        "dist",
        "--out",
        "release",
        "--tag",
        "v0.15.2",
        "--revision",
        REVISION,
        "--version",
        VERSION,
        "--run-url",
        RUN_URL,
      ]),
    /m5-test-\*/,
  );
});

test("the published release is verified against the assembled directory", () => {
  const { input, out } = threePlatformInput("verify-release-");
  assembleModule.assembleRelease(assembleArgs({ input, out }));
  const files = readFileSync(join(out, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/)[1]);
  const view = {
    tagName: STAGE,
    isPrerelease: true,
    isDraft: false,
    assets: [...files, "SHA256SUMS.txt", "BUILD-RECORD.json"].map((name) => ({
      name,
      size: readFileSync(join(out, name)).length,
      url: `https://github.com/MisterBowie/omp-desktop/releases/download/${STAGE}/${name}`,
    })),
  };
  const result = assembleModule.verifyPublishedRelease(view, { out, tag: STAGE, revision: REVISION });
  assert.equal(result.assets, files.length + 2);

  const cases = [
    [{ ...view, isPrerelease: false }, /not a prerelease/],
    [{ ...view, tagName: "m5-test-other" }, /live release is on/],
    [{ ...view, assets: [...view.assets, { name: "latest-linux.yml", size: 1, url: "u" }] }, /carries/],
    [
      { ...view, assets: view.assets.map((asset) => (asset.name === files[0] ? { ...asset, size: asset.size + 1 } : asset)) },
      /on the release/,
    ],
    [
      { ...view, assets: view.assets.map((asset) => (asset.name === files[0] ? { ...asset, url: "https://example.com/other" } : asset)) },
      /download URL outside/,
    ],
    [{ ...view, assets: view.assets.filter((asset) => asset.name !== "SHA256SUMS.txt") }, /carries|no SHA256SUMS/],
  ];
  for (const [mutated, pattern] of cases) {
    assert.throws(() => assembleModule.verifyPublishedRelease(mutated, { out, tag: STAGE, revision: REVISION }), pattern);
  }
});
