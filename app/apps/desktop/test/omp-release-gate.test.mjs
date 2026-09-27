/**
 * The release gate (M5/T20-R4B, ADR 0307).
 *
 * Two guarantees are tested here. First, every packaging command must run the
 * sidecar preflight between the runtime bundling step and electron-builder, so
 * a release cannot ship a missing, stale or foreign runtime. Second, the
 * preflight itself fails closed: a cross-target release may only proceed with
 * an artifact staged for exactly that platform and architecture that verifies
 * against the controlled manifest being released — the host binary is never
 * reused for another platform, and a tampered artifact stops the release.
 *
 * The fixtures are tiny git repositories and stand-in artifacts; no compiler and
 * no electron-builder run here.
 *
 * A third guarantee covers what the entry lets through. Every option the
 * installed electron-builder CLI declares is either owned (the four release
 * axes: platform, architecture, dir, publish), refused (an argument that could
 * replace or stop the package the preflight validated), or — for the three
 * signature-phase dotted config overrides the fixed lanes pass — forwarded
 * verbatim. The entry's tables are compared against the installed CLI's yargs
 * contract here, so a builder version that declares a new option fails this
 * suite instead of silently reaching the builder (fifth-review F1/F2).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FIXTURE_VERSION,
  cleanupScratch,
  fixtureRepo,
  scratch,
  stageArtifact,
  writeFixtureManifest,
} from "./helpers/omp-fork-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..", "..");
const sidecarScript = join(appRoot, "scripts", "omp-sidecar.mjs");
const packageJson = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const { ALLOWED_CONFIG_OVERRIDES, PUBLISH_CHOICES, parseReleaseArgs, planRelease, runRelease } =
  await import(pathToFileURL(join(appRoot, "scripts", "release-package.mjs")).href);

/** A platform that is never the host, so the cross-target path is exercised. */
const CROSS_PLATFORM = process.platform === "win32" ? "darwin" : "win32";

process.on("exit", cleanupScratch);

function runPreflight(args) {
  return spawnSync(process.execPath, [sidecarScript, "--preflight", ...args], { encoding: "utf8" });
}

/** A fixture checkout, its manifest, and the staged-artifact options for it. */
function releaseFixture() {
  const fixture = fixtureRepo();
  const manifestPath = writeFixtureManifest(fixture);
  return {
    fixture,
    manifestPath,
    artifactOptions: {
      platform: CROSS_PLATFORM,
      arch: "x64",
      patchLevel: `${fixture.baseSha.slice(0, 7)}+fixture.1`,
      baseSha: fixture.baseSha,
      forkCommit: fixture.headSha,
      ompVersion: FIXTURE_VERSION,
    },
  };
}

function preflightArgs({ fixture, manifestPath }, out) {
  return [
    "--platform",
    CROSS_PLATFORM,
    "--arch",
    "x64",
    "--out",
    out,
    "--source",
    fixture.root,
    "--manifest",
    manifestPath,
  ];
}

test("every release command bundles the runtime, then runs the target-aware packaging step", () => {
  const steps = {
    pack: null,
    dist: null,
    "dist:mac": "darwin",
    "dist:win": "win32",
    "dist:linux": "linux",
  };
  for (const [script, platform] of Object.entries(steps)) {
    const command = packageJson.scripts[script];
    assert.ok(command, `${script} must exist`);
    const bundle = command.indexOf("bundle:runtime");
    const wrapper = command.indexOf("release-package.mjs");
    assert.ok(bundle > 0, `${script} must bundle the runtime`);
    assert.ok(wrapper > 0, `${script} must run scripts/release-package.mjs`);
    assert.ok(
      bundle < wrapper,
      `${script}: the runtime step (bundle:runtime) must precede the packaging step`,
    );
    if (platform) {
      assert.ok(
        command.includes(`--platform ${platform}`),
        `${script} must name the release platform`,
      );
    }
    // The architecture is decided by the wrapper from the CLI passthrough, so
    // the package script must not pin one and let the preflight and
    // electron-builder disagree.
    assert.doesNotMatch(command, /--(?:x64|arm64|ia32|armv7l)\b/, `${script} must not pin an architecture`);
  }
});

test("the preflight and electron-builder are given the same platform and architecture", () => {
  const cases = [
    // An arm64 mac asked for x64: the preflight must build/verify x64, not the
    // host's arm64, and electron-builder must package x64.
    { argv: ["--platform", "darwin", "--x64"], host: { platform: "darwin", arch: "arm64" }, platform: "darwin", arch: "x64", builderArch: "--x64" },
    { argv: ["--platform", "darwin", "--arm64"], host: { platform: "darwin", arch: "arm64" }, platform: "darwin", arch: "arm64", builderArch: "--arm64" },
    // No arch: a mac release follows the native runner.
    { argv: ["--platform", "darwin"], host: { platform: "darwin", arch: "arm64" }, platform: "darwin", arch: "arm64", builderArch: null },
    // Host default (pack/dist without a platform): Linux keeps the fixed x64
    // contract, so electron-builder gets --x64 too.
    { argv: [], host: { platform: "linux", arch: "x64" }, platform: "linux", arch: "x64", builderArch: "--x64" },
    // Windows and Linux keep the fixed x64 contract.
    { argv: ["--platform", "win32"], host: { platform: "linux", arch: "x64" }, platform: "win32", arch: "x64", builderArch: "--x64" },
    { argv: ["--platform", "linux"], host: { platform: "darwin", arch: "arm64" }, platform: "linux", arch: "x64", builderArch: "--x64" },
  ];
  for (const scenario of cases) {
    const plan = planRelease(scenario.argv, scenario.host);
    const platformIndex = plan.preflight.args.indexOf("--platform");
    const archIndex = plan.preflight.args.indexOf("--arch");
    assert.equal(plan.preflight.args[platformIndex + 1], scenario.platform, JSON.stringify(scenario.argv));
    assert.equal(plan.preflight.args[archIndex + 1], scenario.arch, JSON.stringify(scenario.argv));
    assert.equal(plan.target.arch, scenario.arch);
    if (scenario.builderArch) {
      assert.ok(
        plan.builder.args.includes(scenario.builderArch),
        `${JSON.stringify(scenario.argv)}: electron-builder must select ${scenario.builderArch}`,
      );
    } else {
      assert.ok(
        !plan.builder.args.some((arg) => /^--(?:x64|arm64|ia32|armv7l|universal)$/.test(arg)),
        `${JSON.stringify(scenario.argv)}: a host-arch mac release must not pin the package target`,
      );
    }
    assert.ok(plan.builder.args.includes("--publish"), "electron-builder must never self-publish");
    assert.ok(plan.builder.args.includes("never"), "electron-builder must never self-publish");
  }
});

test("a cross-target release without an explicit architecture fails closed before building", () => {
  const host = { platform: "linux", arch: "x64" };
  assert.throws(() => planRelease(["--platform", "darwin"], host), /arch/);

  const calls = [];
  const code = runRelease(["--platform", "darwin"], {
    host,
    spawn: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.notEqual(code, 0, "a cross-target release without an arch must fail");
  assert.deepEqual(calls, [], "nothing may be spawned when the target is not usable");
});

test("the packaging step runs the preflight before electron-builder and stops on failure", () => {
  const host = { platform: "linux", arch: "x64" };
  const calls = [];
  const code = runRelease(["--platform", "win32"], {
    host,
    spawn: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2, "one preflight and one electron-builder invocation");
  assert.match(calls[0].args[0], /omp-sidecar\.mjs$/);
  assert.equal(calls[0].args[1], "--preflight");
  assert.equal(calls[0].args[calls[0].args.indexOf("--arch") + 1], "x64");
  assert.ok(calls[1].args.includes("--win"));
  assert.ok(calls[1].args.includes("--x64"), "electron-builder must receive the same architecture");
  assert.ok(calls[1].args.includes("--publish"));
  assert.ok(calls[1].args.includes("never"));

  const attempted = [];
  const failed = runRelease(["--platform", "win32"], {
    host,
    spawn: (command) => {
      attempted.push(command);
      return { status: 1 };
    },
  });
  assert.equal(failed, 1);
  assert.equal(attempted.length, 1, "electron-builder must not run when the preflight refuses");
});

test("the preflight admits a staged cross-target artifact built from the same control", () => {
  const release = releaseFixture();
  const out = join(scratch("staged"), "omp-runtime");
  stageArtifact(out, release.artifactOptions);

  const run = runPreflight([...preflightArgs(release, out), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).fork.commit, release.fixture.headSha);
});

test("the preflight refuses a missing, tampered or foreign staged artifact", () => {
  const release = releaseFixture();
  const call = (out) => runPreflight(preflightArgs(release, out));

  // Missing artifact entirely.
  const empty = join(scratch("empty"), "omp-runtime");
  mkdirSync(empty, { recursive: true });
  const missing = call(empty);
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /does not match the controlled manifest|not usable/);

  // Tampered binary digest in the manifest.
  const tamperedManifest = join(scratch("tampered-manifest"), "omp-runtime");
  const stagedManifest = stageArtifact(tamperedManifest, release.artifactOptions);
  const value = JSON.parse(readFileSync(join(tamperedManifest, "provenance.json"), "utf8"));
  value.binary.sha256 = "b".repeat(64);
  writeFileSync(join(tamperedManifest, "provenance.json"), JSON.stringify(value));
  const tamperedDigest = call(tamperedManifest);
  assert.equal(tamperedDigest.status, 1);
  assert.match(tamperedDigest.stderr, /does not match the controlled manifest/);

  // Tampered gate.
  const tamperedGate = join(scratch("tampered-gate"), "omp-runtime");
  const stagedGate = stageArtifact(tamperedGate, release.artifactOptions);
  writeFileSync(stagedGate.gate, `${readFileSync(stagedGate.gate, "utf8")}\n// extra\n`);
  const gateRun = call(tamperedGate);
  assert.equal(gateRun.status, 1);
  assert.match(gateRun.stderr, /extension .*|bytes/);

  // Artifact from a different control: same platform and shape, other patch level.
  const foreign = join(scratch("foreign"), "omp-runtime");
  stageArtifact(foreign, { ...release.artifactOptions, patchLevel: "0000000+other.9" });
  const foreignRun = call(foreign);
  assert.equal(foreignRun.status, 1);
  assert.match(foreignRun.stderr, /patch level|does not match the controlled manifest/);

  // An artifact written under the superseded provenance schema is refused.
  const oldSchema = join(scratch("old-schema"), "omp-runtime");
  stageArtifact(oldSchema, {
    ...release.artifactOptions,
    mutateProvenance: (provenance) => {
      provenance.schema = "omp-desktop.bundled-sidecar/1";
    },
  });
  const oldSchemaRun = call(oldSchema);
  assert.equal(oldSchemaRun.status, 1);
  assert.match(oldSchemaRun.stderr, /schema/);

  // Untouched artifact plus a dirty checkout: the control itself is validated.
  const dirtyOut = join(scratch("dirty"), "omp-runtime");
  stageArtifact(dirtyOut, release.artifactOptions);
  writeFileSync(join(release.fixture.root, "src", "tool.ts"), "export const value = 'dirty';\n");
  const dirtyRun = call(dirtyOut);
  assert.equal(dirtyRun.status, 1);
  assert.match(dirtyRun.stderr, /uncommitted changes/);

  // Staged artifact is untouched by the failures above.
  const stagedManifestSha = JSON.parse(
    readFileSync(join(tamperedManifest, "provenance.json"), "utf8"),
  ).binary.sha256;
  assert.equal(stagedManifestSha, "b".repeat(64));
});

test("a cross-target release cannot reuse the host binary", () => {
  const release = releaseFixture();
  const out = join(scratch("host-binary"), "omp-runtime");
  // Stage the *host* binary name and platform in the runtime directory the
  // cross-target release would consume.
  stageArtifact(out, { ...release.artifactOptions, platform: process.platform });

  const wrongPlatform = runPreflight(preflightArgs(release, out));
  assert.equal(wrongPlatform.status, 1);
  assert.match(wrongPlatform.stderr, /platform|does not match the controlled manifest/);

  // A cross-target release without an explicit architecture is refused rather
  // than defaulting to the host's.
  const noArch = runPreflight([
    "--platform",
    CROSS_PLATFORM,
    "--out",
    out,
    "--source",
    release.fixture.root,
    "--manifest",
    release.manifestPath,
  ]);
  assert.equal(noArch.status, 1);
  assert.match(noArch.stderr, /--arch is required/);
});

/**
 * The signed macOS lane, verbatim from `release.yml`: the architecture and the
 * builder configuration the upstream package script forwards to
 * electron-builder. Refusing these was review finding F1.
 *
 * The dotted overrides are a source-neutral allowlist: `mac.identity` selects a
 * certificate, `mac.forceCodeSigning` and `mac.notarize` are signing-phase
 * gates. None of them can add, move or rename a packaged file, which is why
 * they may pass through; every other `-c.*` key is refused before any process
 * is spawned (fifth-review F2).
 */
const SIGNED_MACOS_ARGS = [
  "--arm64",
  "-c.mac.forceCodeSigning=true",
  "-c.mac.notarize=true",
];

const SIGNATURE_OVERRIDES = [
  "-c.mac.identity=Developer ID Application: XingYu Liu (DUV63RKYTW)",
  "-c.mac.forceCodeSigning=true",
  "-c.mac.notarize=true",
];

test("the release entry forwards the signature overrides it does not own", () => {
  const plan = planRelease(["--platform", "darwin", "--arm64", ...SIGNATURE_OVERRIDES], {
    platform: "darwin",
    arch: "arm64",
  });
  // Handed to electron-builder unchanged and in the given order.
  assert.deepEqual(plan.builder.args.slice(-SIGNATURE_OVERRIDES.length), SIGNATURE_OVERRIDES);
  assert.ok(plan.builder.args.includes("--mac"));
  assert.ok(plan.builder.args.includes("--arm64"));
  // Forwarding did not cost the entry its own arguments.
  assert.ok(plan.builder.args.includes("--publish"));
  assert.ok(plan.builder.args.includes("never"));
  assert.equal(plan.target.arch, "arm64");

  // Each override stands on its own, and the equivalent spellings of the config
  // option are accepted the same way.
  for (const override of SIGNATURE_OVERRIDES) {
    const single = planRelease(["--platform", "darwin", override], {
      platform: "darwin",
      arch: "arm64",
    });
    assert.ok(single.builder.args.includes(override), override);
  }
  const interleaved = planRelease(
    ["--platform", "darwin", "-c.mac.identity=Local Dev ID", "--dir", "-c.mac.notarize=true"],
    { platform: "darwin", arch: "arm64" },
  );
  assert.deepEqual(
    interleaved.builder.args.filter((arg) => arg.startsWith("-c.")),
    ["-c.mac.identity=Local Dev ID", "-c.mac.notarize=true"],
  );
  assert.ok(interleaved.builder.args.includes("--dir"));
  const spellings = planRelease(
    ["--platform", "darwin", "--config.mac.notarize=true", "--c.mac.identity=Local Dev ID"],
    { platform: "darwin", arch: "arm64" },
  );
  assert.deepEqual(spellings.builder.args.slice(-2), [
    "--config.mac.notarize=true",
    "--c.mac.identity=Local Dev ID",
  ]);
});

test("the config allowlist is exactly the signature overrides the fixed lanes pass", () => {
  const laneSources = [
    readFileSync(join(appRoot, "scripts", "release-macos.sh"), "utf8"),
    readFileSync(join(appRoot, ".github", "workflows", "release.yml"), "utf8"),
  ];
  const passed = new Set();
  for (const source of laneSources) {
    for (const match of source.matchAll(/-c\.([A-Za-z0-9_.[\]]+)=/g)) passed.add(match[1]);
  }
  assert.deepEqual(
    [...passed].sort(),
    [...ALLOWED_CONFIG_OVERRIDES].sort(),
    "the allowlist must be exactly what the signed lanes pass through the package script",
  );
});

test("forwarded arguments reach electron-builder only after the preflight passes", () => {
  const host = { platform: "darwin", arch: "arm64" };
  const calls = [];
  const code = runRelease(["--platform", "darwin", ...SIGNED_MACOS_ARGS], {
    host,
    spawn: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2, "one preflight and one electron-builder invocation");
  assert.match(calls[0].args[0], /omp-sidecar\.mjs$/);
  assert.equal(calls[0].args[1], "--preflight");
  assert.equal(calls[0].args[calls[0].args.indexOf("--arch") + 1], "arm64");
  // The builder arguments arrive, and electron-builder is still the last call.
  assert.deepEqual(
    calls[1].args.filter((arg) => arg.startsWith("-c.mac.")),
    ["-c.mac.forceCodeSigning=true", "-c.mac.notarize=true"],
  );
  assert.ok(calls[1].args.includes("--mac"));
  assert.ok(calls[1].args.includes("--arm64"));

  // A failing preflight still stops the forwarding: electron-builder never runs.
  const attempted = [];
  const failed = runRelease(["--platform", "darwin", ...SIGNED_MACOS_ARGS], {
    host,
    spawn: (command) => {
      attempted.push(command);
      return { status: 1 };
    },
  });
  assert.equal(failed, 1);
  assert.equal(attempted.length, 1, "electron-builder must not run when the preflight refuses");
});

/**
 * electron-builder's platform switches. Its CLI declares `--mac`/`--macos`/
 * `-m`/`-o`, `--win`/`--windows`/`-w` and `--linux`/`-l`, and every one of them
 * is additive: a second switch builds a second platform. Forwarding any of them
 * would move electron-builder to a target the preflight never checked, so they
 * are the platform axis — one declaration, one mapping, refused before spawn.
 * yargs also accepts a single-char alias as a long option (`--m`, `--w`, `--l`,
 * `--o`) and a target list as the switch's value; both are the same axis.
 */
const BUILDER_PLATFORM_FLAGS = ["--mac", "--win", "--linux"];
const BUILDER_ARCH_FLAGS = ["--x64", "--arm64", "--ia32", "--armv7l", "--universal"];
const DARWIN_HOST = { platform: "darwin", arch: "arm64" };
const LINUX_HOST = { platform: "linux", arch: "x64" };

/** Run the release entry with a stub spawn and the console captured, so a refusal never pollutes TAP. */
function runWithSpy(argv, host = DARWIN_HOST) {
  const calls = [];
  const output = [];
  const code = runRelease(argv, {
    host,
    spawn: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
    log: (line) => output.push(line),
    error: (line) => output.push(line),
  });
  return { code, calls, output: output.join("\n") };
}

/**
 * Assert the entry refused `argv` before spawning anything — neither the sidecar
 * preflight nor electron-builder — and that the refusal names the argument.
 */
function assertRefusedBeforeSpawn(argv, token) {
  const { code, calls, output } = runWithSpy(argv);
  assert.equal(code, 2, `${JSON.stringify(argv)} must be refused with exit code 2\n${output}`);
  assert.equal(calls.length, 0, `${JSON.stringify(argv)} must not spawn anything\n${output}`);
  assert.ok(output.includes(token), `${JSON.stringify(argv)} must name ${token}\n${output}`);
}

test("an electron-builder platform switch is the same axis as --platform", () => {
  const cases = [
    { argv: ["--mac"], host: DARWIN_HOST, platform: "darwin", arch: "arm64", flag: "--mac" },
    { argv: ["--macos", "--x64"], host: DARWIN_HOST, platform: "darwin", arch: "x64", flag: "--mac" },
    { argv: ["-m", "--x64"], host: DARWIN_HOST, platform: "darwin", arch: "x64", flag: "--mac" },
    { argv: ["-o", "--x64"], host: DARWIN_HOST, platform: "darwin", arch: "x64", flag: "--mac" },
    { argv: ["--m"], host: DARWIN_HOST, platform: "darwin", arch: "arm64", flag: "--mac" },
    { argv: ["--o", "--arm64"], host: DARWIN_HOST, platform: "darwin", arch: "arm64", flag: "--mac" },
    { argv: ["--win"], host: { platform: "linux", arch: "x64" }, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["--windows"], host: DARWIN_HOST, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["-w"], host: DARWIN_HOST, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["--w", "--x64"], host: DARWIN_HOST, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["--linux"], host: DARWIN_HOST, platform: "linux", arch: "x64", flag: "--linux" },
    { argv: ["-l"], host: DARWIN_HOST, platform: "linux", arch: "x64", flag: "--linux" },
    { argv: ["--l"], host: DARWIN_HOST, platform: "linux", arch: "x64", flag: "--linux" },
  ];
  for (const scenario of cases) {
    const label = JSON.stringify(scenario.argv);
    const plan = planRelease(scenario.argv, scenario.host);
    assert.deepEqual(plan.target, { platform: scenario.platform, arch: scenario.arch }, label);
    const platformIndex = plan.preflight.args.indexOf("--platform");
    assert.equal(plan.preflight.args[platformIndex + 1], scenario.platform, label);
    // Exactly one platform switch reaches electron-builder: the alias is
    // consumed as the declaration, never forwarded beside the parsed flag.
    const switches = plan.builder.args.filter((arg) => BUILDER_PLATFORM_FLAGS.includes(arg));
    assert.deepEqual(switches, [scenario.flag], label);
  }

  // electron-builder's platform switches also accept a target list (`--mac dmg
  // zip`). The platform axis names the release platform only, so a list is
  // refused instead of being forwarded next to the flag the wrapper picks.
  for (const argv of [
    ["--mac", "dmg"],
    ["--platform", "darwin", "dmg", "zip"],
  ]) {
    assert.throws(
      () => planRelease(argv, DARWIN_HOST),
      /target list/,
      `${JSON.stringify(argv)} must be refused`,
    );
  }
});

/**
 * Every spelling of an owned axis, every negation of it, every repeated
 * declaration, and every builder argument that could replace or stop the
 * package the preflight validated. Each one must fail before anything runs, so
 * the sidecar preflight (which compiles the runtime on a host target) never
 * starts for a command that cannot produce the artifact its target checked.
 */
const REFUSED_ARGUMENTS = [
  // A platform switch with an attached or following target list beside the
  // parsed target — the reported fork: the preflight validated darwin/arm64
  // while electron-builder would also build win32 portable.
  [["--platform", "darwin", "--arm64", "--win=portable"], "--win=portable"],
  [["--platform", "darwin", "--mac=dmg"], "--mac=dmg"],
  [["--platform", "win32", "--windows=portable"], "--windows=portable"],
  [["--platform", "darwin", "-m=dmg"], "-m=dmg"],
  [["--platform", "linux", "-l=deb"], "-l=deb"],
  [["--platform", "darwin", "-w="], "-w="],
  [["--platform", "darwin", "--mac=false"], "--mac=false"],
  [["--platform", "darwin", "--m=dmg"], "--m=dmg"],
  [["--platform", "linux", "--w=portable"], "--w=portable"],
  [["--platform", "darwin", "--m", "dmg"], "--m"],
  // Bundled short clusters (`-mwl` builds three platforms) and the single-char
  // aliases yargs also accepts as long options.
  [["-mwl"], "-mwl"],
  [["--platform", "darwin", "-mdmg"], "-mdmg"],
  [["--platform", "darwin", "-mw"], "-mw"],
  [["--platform", "darwin", "--macosx"], "--macosx"],
  [["--platform", "darwin", "--arm64", "--w"], "--w"],
  [["--platform", "darwin", "--m"], "--m"],
  [["--win", "--m"], "--m"],
  [["--no-mac"], "--no-mac"],
  // The architecture axis: negations, non-true values and repeats.
  [["--platform", "darwin", "--no-x64"], "--no-x64"],
  [["--platform", "darwin", "--x64=false"], "--x64=false"],
  [["--platform", "darwin", "--x64=1"], "--x64=1"],
  [["--platform", "darwin", "--x64="], "--x64="],
  [["--platform", "darwin", "--x64", "false"], "--x64"],
  [["--platform", "darwin", "--x64", "--no-arm64"], "--no-arm64"],
  [["--platform", "darwin", "--x64", "--x64"], "--x64"],
  [["--platform", "darwin", "--x64", "--arm64"], "--arm64"],
  [["--platform", "darwin", "--arch=arm64", "--arch", "x64"], "--arch"],
  // The dir axis.
  [["--platform", "darwin", "--dir=false"], "--dir=false"],
  [["--platform", "darwin", "--no-dir"], "--no-dir"],
  [["--platform", "darwin", "--dir="], "--dir="],
  [["--platform", "darwin", "--dir", "false"], "--dir"],
  [["--platform", "darwin", "--dirx"], "--dirx"],
  [["--platform", "darwin", "--dir", "--dir=true"], "--dir=true"],
  // The publish axis, including the reported `--publish never -p always` fork
  // and the values the installed CLI would reject anyway.
  [["--platform", "darwin", "--publish", "never", "-p", "always"], "-p"],
  [["--platform", "darwin", "--publish=never", "--publish=always"], "--publish=always"],
  [["--platform", "darwin", "-pnever"], "-pnever"],
  [["--platform", "darwin", "--publish"], "--publish"],
  [["--platform", "darwin", "--p="], "--p="],
  [["--platform", "darwin", "--p=draft"], "--p=draft"],
  [["--platform", "darwin", "--publish", "sometimes"], "--publish"],
  // `--` would hide every following argument from electron-builder.
  [["--platform", "darwin", "--", "--win"], "--"],
  // The packaged input may not be replaced: an external app, another project,
  // or an external configuration file (fifth-review F2).
  [["--platform", "darwin", "--prepackaged", "/tmp/foreign.app"], "--prepackaged"],
  [["--platform", "darwin", "--prepackaged=/tmp/foreign.app"], "--prepackaged="],
  [["--platform", "darwin", "--pd", "/tmp/foreign.app"], "--pd"],
  [["--platform", "darwin", "--pd=/tmp/foreign.app"], "--pd="],
  [["--platform", "darwin", "--no-prepackaged"], "--no-prepackaged"],
  [["--platform", "darwin", "--projectDir", "/tmp/elsewhere"], "--projectDir"],
  [["--platform", "darwin", "--project", "/tmp/elsewhere"], "--project"],
  [["--platform", "darwin", "--projectDir=/tmp/elsewhere"], "--projectDir="],
  [["--platform", "darwin", "--project-dir", "/tmp/elsewhere"], "--project-dir"],
  [["--platform", "darwin", "--config", "electron-builder.yml"], "--config"],
  [["--platform", "darwin", "--config=electron-builder.yml"], "--config="],
  [["--platform", "darwin", "-c", "electron-builder.yml"], "-c"],
  [["--platform", "darwin", "-c=electron-builder.yml"], "-c="],
  [["--platform", "darwin", "--c=some.yml"], "--c=some.yml"],
  [["--platform", "darwin", "-csome.yml"], "-csome.yml"],
  [["--platform", "darwin", "--config=mac.identity=X"], "--config=mac.identity=X"],
  [["--platform", "darwin", "-c.mac.identity"], "-c.mac.identity"],
  [["--platform", "darwin", "-c.mac.identity", "X"], "-c.mac.identity"],
  // Dotted overrides that could replace the packaged input — global and
  // platform-level — are refused by the allowlist, not by a denylist that
  // would let every unknown key through.
  [["--platform", "darwin", "-c.files[0].from=x"], "-c.files[0].from=x"],
  [["--platform", "darwin", "-c.extraResources[0].from=/tmp/x"], "-c.extraResources[0].from"],
  [["--platform", "darwin", "-c.extraFiles[0].from=/tmp/x"], "-c.extraFiles[0].from"],
  [["--platform", "darwin", "-c.directories.app=other"], "-c.directories.app=other"],
  [["--platform", "darwin", "-c.extends=./base.yml"], "-c.extends=./base.yml"],
  [["--platform", "darwin", "--config.mac.extraResources[0].from=/tmp/x"], "--config.mac.extraResources"],
  [["--platform", "darwin", "-c.win.extraResources[0].from=/tmp/x"], "-c.win.extraResources"],
  [["--platform", "darwin", "-c.linux.extraFiles[0].from=/tmp/x"], "-c.linux.extraFiles"],
  [["--platform", "darwin", "-c.mac.type=dmg"], "-c.mac.type=dmg"],
  [["--platform", "darwin", "-c.afterSign=./x.mjs"], "-c.afterSign=./x.mjs"],
  [["--platform", "darwin", "-c.mac.identity.a=X"], "-c.mac.identity.a=X"],
  // Arguments that would end electron-builder before it packages.
  [["--platform", "darwin", "--help"], "--help"],
  [["--platform", "darwin", "--version"], "--version"],
];

test("every unsupported spelling of an owned axis or a packaging input is refused before spawning", () => {
  for (const [argv, token] of REFUSED_ARGUMENTS) {
    assertRefusedBeforeSpawn(argv, token);
  }
});

test("a conflicting or repeated target is refused instead of silently picked", () => {
  const host = DARWIN_HOST;
  const conflicts = [
    ["--platform", "darwin", "--platform", "darwin"],
    ["--platform", "darwin", "--win"],
    ["--win", "--linux"],
    // The same axis spelled twice, in any of its spellings.
    ["--mac", "--platform", "darwin"],
    ["--mac", "--macos"],
    ["--mac", "--m"],
    ["-m", "-w"],
    // A bundled short cluster names more than one platform.
    ["-mwl"],
  ];
  for (const argv of conflicts) {
    assert.throws(
      () => planRelease(argv, host),
      /must be given once|given more than once|more than one platform|bundle of switches/,
      `${JSON.stringify(argv)} must be refused`,
    );
  }

  // The same refusal stops the run before anything is spawned.
  const { code, calls } = runWithSpy(["--platform", "darwin", "--arm64", "--win"]);
  assert.equal(code, 2);
  assert.deepEqual(calls, [], "nothing may be spawned for an ambiguous target");
});

test("the entry generates exactly one choice per axis and the same target for both steps", () => {
  const cases = [
    {
      argv: ["--platform", "darwin", "--arm64", "--publish", "never"],
      host: DARWIN_HOST,
      head: ["--mac", "--arm64", "--publish", "never"],
    },
    {
      argv: ["--platform=darwin", "--arch=arm64"],
      host: DARWIN_HOST,
      head: ["--mac", "--arm64", "--publish", "never"],
    },
    {
      argv: ["--mac=", "--x64=true"],
      host: DARWIN_HOST,
      head: ["--mac", "--x64", "--publish", "never"],
    },
    {
      argv: ["--win=", "--dir", "true", "--publish=always"],
      host: LINUX_HOST,
      head: ["--win", "--x64", "--dir", "--publish", "always"],
    },
    {
      argv: ["-o", "--arm64", "-p", "onTag"],
      host: DARWIN_HOST,
      head: ["--mac", "--arm64", "--publish", "onTag"],
    },
    {
      argv: ["--w", "--x64", "--p", "onTagOrDraft"],
      host: DARWIN_HOST,
      head: ["--win", "--x64", "--publish", "onTagOrDraft"],
    },
  ];
  for (const scenario of cases) {
    const label = JSON.stringify(scenario.argv);
    const plan = planRelease(scenario.argv, scenario.host);
    // The entry writes its own axes at the head of the argv, before anything it
    // forwards, so a forwarded argument can never add a second choice.
    assert.deepEqual(plan.builder.args.slice(0, scenario.head.length), scenario.head, label);
    assert.equal(
      plan.builder.args.filter((arg) => BUILDER_PLATFORM_FLAGS.includes(arg)).length,
      1,
      `${label}: exactly one platform switch`,
    );
    assert.ok(
      plan.builder.args.filter((arg) => BUILDER_ARCH_FLAGS.includes(arg)).length <= 1,
      `${label}: at most one architecture switch`,
    );
    assert.equal(
      plan.builder.args.filter((arg) => arg === "--publish").length,
      1,
      `${label}: exactly one normalized --publish`,
    );
    assert.ok(
      plan.builder.args.filter((arg) => arg === "--dir").length <= 1,
      `${label}: at most one --dir`,
    );
    // Both steps read the same target.
    assert.equal(plan.preflight.args[plan.preflight.args.indexOf("--platform") + 1], plan.target.platform, label);
    assert.equal(plan.preflight.args[plan.preflight.args.indexOf("--arch") + 1], plan.target.arch, label);
  }
});

/**
 * The entry's tables are a transcription of the installed CLI's yargs contract,
 * and this test keeps the transcription honest: it builds the parser
 * electron-builder builds (`electron-builder/out/builder.js`) and fails when a
 * declared option, alias or publish value is not classified here. A builder
 * upgrade that adds an option cannot reach the release entry unclassified.
 */
test("every option the installed electron-builder CLI declares is classified by the entry", async () => {
  const builder = await import("electron-builder/out/builder.js");
  const parser = builder.createYargs();
  builder.configureBuildCommand(parser);
  const options = parser.getOptions();

  // How the entry treats each declared name: an owned axis, or refused.
  const BUILDER_OPTIONS = {
    mac: "platform", m: "platform", o: "platform", macos: "platform",
    win: "platform", w: "platform", windows: "platform",
    linux: "platform", l: "platform",
    x64: "arch", ia32: "arch", armv7l: "arch", arm64: "arch", universal: "arch",
    dir: "dir",
    publish: "publish", p: "publish",
    prepackaged: "refused", pd: "refused",
    projectDir: "refused", project: "refused",
    config: "refused", c: "refused",
    help: "refused", version: "refused",
  };
  // The CLI accepts a canonical name and every alias, and yargs accepts an
  // alias as a long option too (`--m`, `--pd`, `--c`): the full set is the
  // declared keys plus every alias value.
  const declared = [
    ...new Set([...Object.keys(options.key), ...Object.values(options.alias).flat()]),
  ].sort();
  assert.deepEqual(
    declared.filter((name) => !(name in BUILDER_OPTIONS)),
    [],
    "the installed electron-builder declares an option the entry does not classify",
  );
  assert.deepEqual(
    Object.keys(BUILDER_OPTIONS).filter((name) => !declared.includes(name)),
    [],
    "the entry classifies an option the installed electron-builder does not declare",
  );

  // The publish value list is the installed CLI's own choice list.
  const choices = (options.choices.publish ?? []).filter((choice) => typeof choice === "string");
  assert.deepEqual(choices.slice().sort(), [...PUBLISH_CHOICES].sort(), "publish choices");

  // Representative argv for the refused names; the others get the bare switch
  // (with a value for the publish axis).
  const REFUSED_ARGV = {
    help: ["--help"],
    version: ["--version"],
    prepackaged: ["--prepackaged", "/tmp/foreign.app"],
    pd: ["--pd", "/tmp/foreign.app"],
    projectDir: ["--projectDir", "/tmp/elsewhere"],
    project: ["--project", "/tmp/elsewhere"],
    config: ["--config", "electron-builder.yml"],
    c: ["-c", "electron-builder.yml"],
  };
  const EXPECTED_PLATFORM_FLAG = {
    mac: "--mac", m: "--mac", o: "--mac", macos: "--mac",
    win: "--win", w: "--win", windows: "--win",
    linux: "--linux", l: "--linux",
  };
  for (const name of declared) {
    const bucket = BUILDER_OPTIONS[name];
    if (bucket === "refused") {
      const argv = REFUSED_ARGV[name];
      assert.ok(argv, `${name} needs a representative spelling`);
      assertRefusedBeforeSpawn(argv, argv[0]);
      continue;
    }
    const argv = bucket === "publish" ? [`--${name}`, "never"] : [`--${name}`];
    // The entry consumes the spelling as its own axis: nothing is forwarded,
    // and where the spelling is already the canonical switch the entry writes
    // exactly one copy of it.
    assert.deepEqual(parseReleaseArgs(argv).forwarded, [], `${name} (${bucket}) must be consumed`);
    const args = planRelease(argv, DARWIN_HOST).builder.args;
    assert.equal(
      args.filter((arg) => BUILDER_PLATFORM_FLAGS.includes(arg)).length,
      1,
      `${name}: exactly one platform switch`,
    );
    if (bucket === "platform") {
      assert.ok(args.includes(EXPECTED_PLATFORM_FLAG[name]), `${name} selects its platform`);
    } else if (bucket === "arch") {
      assert.equal(args.filter((arg) => BUILDER_ARCH_FLAGS.includes(arg)).length, 1, name);
      assert.ok(args.includes(`--${name}`), `${name} selects its architecture`);
    } else if (bucket === "dir") {
      assert.equal(args.filter((arg) => arg === "--dir").length, 1, name);
    } else {
      assert.equal(args.filter((arg) => arg === "--publish").length, 1, name);
      assert.ok(args.includes("never"), `${name} keeps its value`);
    }
  }
});

test("an argument the entry does not recognize is still forwarded verbatim, never guessed at", () => {
  // The entry classifies every option electron-builder declares; a token that
  // is not one of them is passed through untouched, so a builder that rejects
  // it fails the release loudly instead of the entry silently dropping it.
  const plan = planRelease(["--platform", "linux", "--unknown-builder-flag", "value"], LINUX_HOST);
  assert.deepEqual(plan.builder.args.slice(-2), ["--unknown-builder-flag", "value"]);
});
