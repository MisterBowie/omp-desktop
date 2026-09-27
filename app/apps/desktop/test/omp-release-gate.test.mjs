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
const { planRelease, runRelease } = await import(
  pathToFileURL(join(appRoot, "scripts", "release-package.mjs")).href
);

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
 */
const SIGNED_MACOS_ARGS = [
  "--arm64",
  "-c.mac.forceCodeSigning=true",
  "-c.mac.notarize=true",
];

test("the release entry forwards the builder arguments it does not own", () => {
  const plan = planRelease(["--platform", "darwin", ...SIGNED_MACOS_ARGS], {
    platform: "darwin",
    arch: "arm64",
  });
  // Handed to electron-builder unchanged and in the given order.
  assert.deepEqual(plan.builder.args.slice(-2), [
    "-c.mac.forceCodeSigning=true",
    "-c.mac.notarize=true",
  ]);
  assert.ok(plan.builder.args.includes("--mac"));
  assert.ok(plan.builder.args.includes("--arm64"));
  // Forwarding did not cost the entry its own arguments.
  assert.ok(plan.builder.args.includes("--publish"));
  assert.ok(plan.builder.args.includes("never"));
  assert.equal(plan.target.arch, "arm64");

  // Order is preserved relative to each other, whatever else is in between.
  const interleaved = planRelease(
    ["--platform", "darwin", "-c.mac.target=default", "--dir", "-c.mac.notarize=true"],
    { platform: "darwin", arch: "arm64" },
  );
  assert.deepEqual(
    interleaved.builder.args.filter((arg) => arg.startsWith("-c.")),
    ["-c.mac.target=default", "-c.mac.notarize=true"],
  );
  assert.ok(interleaved.builder.args.includes("--dir"));
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
 */
const PLATFORM_SWITCH = /^(?:--(?:mac|macos|win|windows|linux)|-[mwlo])$/;

const DARWIN_HOST = { platform: "darwin", arch: "arm64" };

test("an electron-builder platform switch is the same axis as --platform", () => {
  const cases = [
    { argv: ["--mac"], host: DARWIN_HOST, platform: "darwin", arch: "arm64", flag: "--mac" },
    { argv: ["--macos", "--x64"], host: DARWIN_HOST, platform: "darwin", arch: "x64", flag: "--mac" },
    { argv: ["-m", "--x64"], host: DARWIN_HOST, platform: "darwin", arch: "x64", flag: "--mac" },
    { argv: ["-o", "--x64"], host: DARWIN_HOST, platform: "darwin", arch: "x64", flag: "--mac" },
    { argv: ["--win"], host: { platform: "linux", arch: "x64" }, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["--windows"], host: DARWIN_HOST, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["-w"], host: DARWIN_HOST, platform: "win32", arch: "x64", flag: "--win" },
    { argv: ["--linux"], host: DARWIN_HOST, platform: "linux", arch: "x64", flag: "--linux" },
    { argv: ["-l"], host: DARWIN_HOST, platform: "linux", arch: "x64", flag: "--linux" },
  ];
  for (const scenario of cases) {
    const label = JSON.stringify(scenario.argv);
    const plan = planRelease(scenario.argv, scenario.host);
    assert.deepEqual(plan.target, { platform: scenario.platform, arch: scenario.arch }, label);
    const platformIndex = plan.preflight.args.indexOf("--platform");
    assert.equal(plan.preflight.args[platformIndex + 1], scenario.platform, label);
    // Exactly one platform switch reaches electron-builder: the alias is
    // consumed as the declaration, never forwarded beside the parsed flag.
    const switches = plan.builder.args.filter((arg) => PLATFORM_SWITCH.test(arg));
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

test("a conflicting or repeated target is refused instead of silently picked", () => {
  const host = DARWIN_HOST;
  const conflicts = [
    ["--platform", "darwin", "--x64", "--arm64"],
    ["--platform", "darwin", "--x64", "--arch", "arm64"],
    ["--platform", "darwin", "--arch", "x64", "--arch", "arm64"],
    ["--platform", "darwin", "--x64", "--x64"],
    ["--platform", "darwin", "--platform", "darwin"],
    ["--platform", "darwin", "--publish", "never", "--publish", "always"],
    // The reported fork: a platform declaration plus an additive alias made the
    // preflight validate darwin/arm64 while electron-builder also built win32.
    ["--platform", "darwin", "--arm64", "--win"],
    ["--platform", "darwin", "--win"],
    ["--win", "--linux"],
    // The same axis spelled twice, in any of its spellings.
    ["--mac", "--platform", "darwin"],
    ["--mac", "--macos"],
    ["--mac", "--mac"],
    ["-m", "-w"],
    // A bundled short cluster names more than one platform.
    ["-mwl"],
  ];
  for (const argv of conflicts) {
    assert.throws(
      () => planRelease(argv, host),
      /must be given once|given more than once|more than one platform/,
      `${JSON.stringify(argv)} must be refused`,
    );
  }

  // The same refusal stops the run before anything is spawned.
  const calls = [];
  const code = runRelease(["--platform", "darwin", "--arm64", "--win"], {
    host,
    spawn: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.equal(code, 2);
  assert.deepEqual(calls, [], "nothing may be spawned for an ambiguous target");
});
