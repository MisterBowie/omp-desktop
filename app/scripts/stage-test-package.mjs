#!/usr/bin/env node
/**
 * Stage one platform's test-package payload (M5 three-platform delivery).
 *
 * The packaging workflow builds with the product's own `dist:*` chain and then
 * has to answer three questions before anything may be published:
 *
 *   1. is this platform's package the one the controlled manifest describes?
 *      (`provenance.json` inside the *packaged* Resources, compared against
 *      `patches/oh-my-pi/manifest.json` — the same pins the preflight proved
 *      before electron-builder ran),
 *   2. did the packaged runtime pass the production acceptance entry
 *      (`scripts/verify-packaged-runtime.mjs --json`) on the isolated copy of
 *      those Resources, and did the this-stage Plan/Goal regression run against
 *      those same packaged artifacts?
 *   3. which exact bytes become the release assets?
 *
 * Doing that in this file instead of in YAML keeps it executable and testable on
 * a workstation: `apps/desktop/test/test-package-staging.test.mjs` drives every
 * refusal below with fixtures.
 *
 * Exits 2 on a command-line or input-contract refusal, 1 on a package that does
 * not match the manifest/acceptance. Both are non-zero: the workflow must not
 * publish on either.
 *
 * Usage:
 *   node scripts/stage-test-package.mjs \
 *     --platform <darwin|win32|linux> --arch <arm64|x64> \
 *     --release-dir <electron-builder output> --resources <verified Resources> \
 *     --verify-report <verify-packaged-runtime --json output> \
 *     --plan-goal-log <node --test output of the packaged regression> \
 *     --out <staging directory> \
 *     --version <product version> --stage <stage label> --revision <git sha> \
 *     --run-id <id> --run-attempt <n> --run-url <url> \
 *     [--manifest <path>] [--json]
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = join(appRoot, "patches", "oh-my-pi", "manifest.json");

class StagingError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function refuse(message, exitCode = 2) {
  throw new StagingError(message, exitCode);
}

/**
 * The payload each platform must produce, by electron-builder target name.
 *
 * `source` is the name the product's `electron-builder` configuration writes
 * (apps/desktop/package.json); `asset` is the name the release publishes, which
 * carries version, stage, platform and architecture (M5 delivery requirement:
 * three platforms must be told apart from the file name alone). Names are exact
 * on purpose: a rename in the builder config has to be a deliberate change here
 * too, not a silently different download.
 */
export const PLATFORM_PAYLOADS = {
  darwin: {
    arch: ["arm64"],
    targets: [
      {
        kind: "dmg",
        source: (v, a) => `OMP-Desktop-${v}-${a}.dmg`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-macos-${a}.dmg`,
      },
      {
        kind: "zip",
        source: (v, a) => `OMP-Desktop-${v}-${a}-mac.zip`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-macos-${a}.zip`,
      },
    ],
  },
  win32: {
    arch: ["x64"],
    targets: [
      {
        kind: "nsis-setup",
        source: (v) => `OMP-Desktop-Setup-${v}.exe`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-windows-${a}-setup.exe`,
      },
      {
        kind: "portable",
        source: (v) => `OMP-Desktop-Portable-${v}.exe`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-windows-${a}-portable.exe`,
      },
    ],
  },
  linux: {
    arch: ["x64"],
    targets: [
      {
        kind: "appimage",
        // electron-builder expands `${arch}` in `linux.artifactName` with the
        // AppImage target's own architecture spelling (`x86_64` for x64).
        source: (v) => `OMP-Desktop-${v}-x86_64.AppImage`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-linux-${a}.AppImage`,
      },
      {
        kind: "deb",
        source: (v) => `omp-desktop_${v}_amd64.deb`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-linux-${a}.deb`,
      },
      {
        kind: "rpm",
        source: (v) => `omp-desktop-${v}-x86_64.rpm`,
        asset: (v, s, a) => `OMP-Desktop-${v}-${s}-linux-${a}.rpm`,
      },
    ],
  },
};

/** Files electron-builder also writes that this release must never publish. */
const EXCLUDED_PATTERNS = [
  { pattern: /^latest.*\.yml$/, reason: "an electron-updater feed would make a test package an update source" },
  { pattern: /\.blockmap$/, reason: "a differential-update blockmap; this release ships no updater payload" },
];

/** Payload-looking extensions: anything unconsumed under these is a refusal. */
const PAYLOAD_PATTERN = /\.(dmg|zip|exe|AppImage|deb|rpm)$/;

export function parseArgs(argv) {
  const options = { json: false, manifest: defaultManifest };
  const values = new Set([
    "--platform",
    "--arch",
    "--release-dir",
    "--resources",
    "--verify-report",
    "--plan-goal-log",
    "--out",
    "--version",
    "--stage",
    "--revision",
    "--run-id",
    "--run-attempt",
    "--run-url",
    "--manifest",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!values.has(arg)) refuse(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) refuse(`${arg} requires a value`);
    index += 1;
    const key = arg
      .slice(2)
      .replace(/-(.)/g, (_, c) => c.toUpperCase());
    options[key] = value;
  }
  for (const required of [
    "platform",
    "arch",
    "releaseDir",
    "resources",
    "verifyReport",
    "planGoalLog",
    "out",
    "version",
    "stage",
    "revision",
    "runId",
    "runAttempt",
    "runUrl",
  ]) {
    if (!options[required]) refuse(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!(options.platform in PLATFORM_PAYLOADS)) refuse(`unsupported release platform: ${options.platform}`);
  if (!PLATFORM_PAYLOADS[options.platform].arch.includes(options.arch)) {
    refuse(`a ${options.platform} test package is ${PLATFORM_PAYLOADS[options.platform].arch.join("/")}-only; got ${options.arch}`);
  }
  return options;
}

/** SHA-256 of a file, read in bounded chunks so an installer is never buffered whole. */
export function sha256OfFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * The counts a `node --test` run prints in its summary.
 *
 * Node writes `# pass 15` under the TAP reporter and `ℹ pass 15` under the spec
 * reporter, and which one is chosen depends on where stdout points. Both are
 * accepted, and a missing *or duplicated* summary line is a refusal: a run that
 * did not finish must not be read as "0 failed".
 */
export function parseTestCounts(source) {
  const counts = {};
  for (const label of ["pass", "fail", "skipped"]) {
    const matches = [...source.matchAll(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, "gm"))];
    if (matches.length !== 1) {
      refuse(
        `the packaged regression log must contain exactly one "${label}" summary line (found ${matches.length}); it did not run to completion`,
        1,
      );
    }
    counts[label] = Number(matches[0][1]);
  }
  return counts;
}

/** The pins every packaged artifact must carry, from the packaged provenance. */
function assertProvenance(provenance, manifest, options) {
  const expectations = [
    ["platform", provenance.platform, options.platform],
    ["arch", provenance.arch, options.arch],
    ["patchLevel", provenance.patchLevel, manifest.patchLevel],
    ["fork.commit", provenance.fork?.commit, manifest.fork.commit],
    ["fork.repository", provenance.fork?.repository, manifest.fork.repository],
    ["upstreamBase.sha", provenance.upstreamBase?.sha, manifest.base.sha],
    ["ompVersion", provenance.ompVersion, manifest.base.version],
    ["desktopVersion", provenance.desktopVersion, options.version],
  ];
  for (const [field, actual, expected] of expectations) {
    if (actual !== expected) {
      refuse(
        `the packaged runtime is not the controlled one: ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        1,
      );
    }
  }
}

/** The packaged-runtime acceptance report, as the release must have seen it. */
function assertVerifyReport(report, provenance, resources) {
  const fail = (message) => refuse(message, 1);
  if (report.mode !== "run") fail(`the packaged-runtime report is not a run (mode ${report.mode})`);
  if (resolve(report.resources ?? "") !== resolve(resources)) {
    fail(`the packaged-runtime report verified ${report.resources}, not the isolated copy ${resources}`);
  }
  const run = report.run ?? {};
  for (const [field, actual] of [
    ["getState", run.getState],
    ["gateLoadControl", run.gateLoadControl],
    ["stop.stopped", run.stop?.stopped],
    ["stop.reaped", run.stop?.reaped],
    ["stop.cleaned", run.stop?.cleaned],
  ]) {
    if (actual !== true && actual !== "refused") fail(`the packaged-runtime report is missing ${field}: ${JSON.stringify(actual)}`);
  }
  if (typeof run.runtimeVersion !== "string" || run.runtimeVersion !== provenance.ompVersion) {
    fail(`the packaged runtime reported omp/${run.runtimeVersion ?? "unknown"}, the package pins omp/${provenance.ompVersion}`);
  }
  if (run.protocolVersion !== 2) fail(`the packaged runtime negotiated protocol v${run.protocolVersion}, expected v2`);
  if (run.leftoverRuns !== 0) fail(`the packaged-runtime run left ${run.leftoverRuns} run directories behind`);
  if (report.binary?.sha256 !== provenance.binary?.sha256) {
    fail(`the verified binary (${report.binary?.sha256}) is not the packaged one (${provenance.binary?.sha256})`);
  }
  const gate = provenance.extensions?.find((extension) => extension.path === "extensions/omp-desktop-gate.js");
  if (!gate) fail("the package provenance does not declare the tool gate");
  if (report.gate?.sha256 !== gate.sha256) {
    fail(`the verified gate (${report.gate?.sha256}) is not the packaged one (${gate.sha256})`);
  }
  return report;
}

/** Everything in the release directory that must not be published, for the record. */
function findExcluded(releaseDir) {
  return readdirSync(releaseDir)
    .filter((entry) => EXCLUDED_PATTERNS.some(({ pattern }) => pattern.test(entry)))
    .sort()
    .map((entry) => ({
      name: entry,
      reason: EXCLUDED_PATTERNS.find(({ pattern }) => pattern.test(entry)).reason,
    }));
}

export function stagePackage(options) {
  // The same two refusals the command line makes, repeated at the function
  // boundary: this entry decides which bytes become release assets, so it must
  // not depend on its caller having parsed anything.
  if (!(options.platform in PLATFORM_PAYLOADS)) refuse(`unsupported release platform: ${options.platform}`);
  if (!PLATFORM_PAYLOADS[options.platform].arch.includes(options.arch)) {
    refuse(`a ${options.platform} test package is ${PLATFORM_PAYLOADS[options.platform].arch.join("/")}-only; got ${options.arch}`);
  }
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  const resources = resolve(options.resources);
  const provenancePath = join(resources, "omp-runtime", "provenance.json");
  if (!existsSync(provenancePath)) {
    refuse(`the verified resources have no omp-runtime/provenance.json: ${resources} (is this a packaged Resources directory?)`);
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  assertProvenance(provenance, manifest, options);

  const verifyReport = assertVerifyReport(
    JSON.parse(readFileSync(options.verifyReport, "utf8")),
    provenance,
    resources,
  );
  const planGoal = parseTestCounts(readFileSync(options.planGoalLog, "utf8"));
  if (planGoal.fail !== 0) refuse(`the packaged Plan/Goal regression failed ${planGoal.fail} case(s)`, 1);
  if (planGoal.pass < 1) {
    refuse("the packaged Plan/Goal regression reported no passing case: the packaged gate/bridge were not exercised", 1);
  }

  const releaseDir = resolve(options.releaseDir);
  if (!existsSync(releaseDir)) refuse(`the release directory does not exist: ${releaseDir}`);
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });

  const { targets } = PLATFORM_PAYLOADS[options.platform];
  const assets = [];
  const consumed = new Set();
  for (const target of targets) {
    const expected = target.source(options.version, options.arch);
    const candidates = readdirSync(releaseDir).filter((entry) => entry === expected);
    if (candidates.length !== 1) {
      refuse(
        `expected exactly one ${expected} in ${releaseDir} for the ${target.kind} target (found ${candidates.length})`,
        1,
      );
    }
    const source = join(releaseDir, expected);
    consumed.add(expected);
    const name = target.asset(options.version, options.stage, options.arch);
    const destination = join(out, name);
    copyFileSync(source, destination);
    assets.push({
      kind: target.kind,
      name,
      bytes: statSync(destination).size,
      sha256: sha256OfFile(destination),
      sourceName: expected,
    });
  }

  // An unconsumed payload-looking file means the builder produced something this
  // release does not describe (a renamed target, a second installer). Publishing
  // it would ship an artifact nobody verified.
  const strays = readdirSync(releaseDir)
    .filter((entry) => PAYLOAD_PATTERN.test(entry) && !consumed.has(entry))
    .sort();
  if (strays.length > 0) {
    refuse(`unexpected package output that this release does not publish: ${strays.join(", ")}`, 1);
  }

  const record = {
    schema: "omp-desktop.test-package/1",
    platform: options.platform,
    arch: options.arch,
    version: options.version,
    stage: options.stage,
    revision: options.revision,
    run: { id: options.runId, attempt: options.runAttempt, url: options.runUrl },
    pins: {
      patchLevel: manifest.patchLevel,
      forkRepository: manifest.fork.repository,
      forkCommit: manifest.fork.commit,
      forkTree: manifest.fork.tree ?? null,
      baseSha: manifest.base.sha,
      baseVersion: manifest.base.version,
    },
    packagedRuntime: {
      provenance: {
        ompVersion: provenance.ompVersion,
        desktopVersion: provenance.desktopVersion,
        platform: provenance.platform,
        arch: provenance.arch,
        patchLevel: provenance.patchLevel,
        forkCommit: provenance.fork?.commit ?? null,
        binaryBytes: provenance.binary?.bytes ?? null,
        binarySha256: provenance.binary?.sha256 ?? null,
        gateBytes: provenance.extensions?.[0]?.bytes ?? null,
        gateSha256: provenance.extensions?.[0]?.sha256 ?? null,
        build: provenance.build ?? null,
      },
      acceptance: {
        resources: verifyReport.resources,
        runtimeVersion: verifyReport.run.runtimeVersion,
        protocolVersion: verifyReport.run.protocolVersion,
        getState: verifyReport.run.getState,
        gateLoadControl: verifyReport.run.gateLoadControl,
        stop: verifyReport.run.stop,
        leftoverRuns: verifyReport.run.leftoverRuns,
        childEnvironmentReadable: verifyReport.run.child?.readable ?? false,
      },
    },
    planGoalRegression: planGoal,
    excluded: findExcluded(releaseDir),
    assets,
  };
  writeFileSync(join(out, "build-record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** A one-screen summary; the JSON record is the machine-readable form. */
function formatRecord(record) {
  const lines = [
    `TEST-PACKAGE-STAGED ${record.platform}/${record.arch} ${record.version} (${record.stage})`,
    `  revision   : ${record.revision}`,
    `  pins       : ${record.pins.patchLevel}, fork ${record.pins.forkCommit}`,
    `  runtime    : omp/${record.packagedRuntime.provenance.ompVersion}, protocol v${record.packagedRuntime.acceptance.protocolVersion}, gate control ${record.packagedRuntime.acceptance.gateLoadControl}`,
    `  regression : ${record.planGoalRegression.pass} passed, ${record.planGoalRegression.fail} failed, ${record.planGoalRegression.skipped} skipped`,
  ];
  for (const asset of record.assets) {
    lines.push(`  asset      : ${asset.name} (${asset.bytes} B, sha256 ${asset.sha256})`);
  }
  for (const excluded of record.excluded) {
    lines.push(`  excluded   : ${excluded.name} — ${excluded.reason}`);
  }
  return lines.join("\n");
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`TEST-PACKAGE-STAGE-FAIL ${error.message}`);
    return error.exitCode ?? 2;
  }
  try {
    const record = stagePackage(options);
    console.log(options.json ? JSON.stringify(record) : formatRecord(record));
    return 0;
  } catch (error) {
    console.error(`TEST-PACKAGE-STAGE-FAIL ${error?.message ?? error}`);
    return error?.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
