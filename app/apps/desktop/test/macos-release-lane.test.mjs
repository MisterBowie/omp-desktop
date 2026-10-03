import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * End-to-end structure test for the signed local macOS lane.
 *
 * The lane was broken twice by rewrites that never ran. First, two
 * electron-builder flags became two commands but kept the line continuation, so
 * the notarization script became a positional argument of electron-builder
 * while a second command kept pointing at a deleted script. Then the lane kept
 * calling electron-builder directly, so the bundled-sidecar preflight that
 * every `dist:*` command runs never ran locally and a signed package could
 * carry a missing or stale `resources/omp-runtime` (fourth-review finding F2).
 *
 * This drives the whole script against stub tooling in a temporary repository
 * root, so the command structure, the release-wrapper entry, the flag set, and
 * the phase order are pinned without a certificate, a network, a real package
 * build, or even a macOS host: `uname` is stubbed as well, so the lane runs
 * everywhere. The wrapper, the watchdog, the bundle inventory, the DMG
 * notarizer, and the release verifier are the real scripts; only the tools they
 * call (cargo, pnpm, electron-builder, codesign, spctl, xcrun) and the OMP
 * sidecar preflight are stubs. What the preflight inside the wrapper decides is
 * covered by test/omp-release-gate.test.mjs against real fixtures; here the
 * stub records the target it was asked for and can be made to fail, which is
 * what pins "preflight before electron-builder" as behaviour rather than text.
 */

const scripts = new URL("../../../scripts/", import.meta.url);
const LANE_SCRIPTS = [
  "release-macos.sh",
  "release-package.mjs",
  "notarize-and-staple-macos-release-dmg.sh",
  "verify-macos-release.sh",
  "macos-signing-watchdog.mjs",
  "macos-codesign-shim.sh",
  "macos-bundle-inventory.mjs",
];
const SIGNING_IDENTITY = "Developer ID Application: XingYu Liu (DUV63RKYTW)";
const SUBMISSION_ID = "11111111-2222-3333-4444-555555555555";
/** The architecture the stubbed host reports, so the lane follows it. */
const HOST_ARCH = "arm64";

/**
 * The bundled-sidecar preflight stub. It records the exact target the release
 * wrapper asked for and exits with `PI_FAKE_SIDECAR_EXIT`, which is how the
 * lane's fail-closed path is driven.
 */
const SIDECAR_STUB = [
  "#!/usr/bin/env node",
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync(process.env.PI_LANE_LOG, `sidecar ${process.argv.slice(2).join(' ')}\\n`);",
  "process.exit(Number(process.env.PI_FAKE_SIDECAR_EXIT ?? '0'));",
  "",
].join("\n");

async function writeStubs(bin, log, repoRoot) {
  await mkdir(bin, { recursive: true });
  const stubs = {
    // A macOS host that may be any real one: the lane only asks for the system
    // name and the machine architecture.
    uname: `#!/usr/bin/env bash
case "$1" in
  -s) echo Darwin ;;
  -m) echo ${HOST_ARCH} ;;
  *)
    echo "uname stub: unexpected invocation: $*" >&2
    exit 1
    ;;
esac
`,
    cargo: `#!/usr/bin/env bash
printf 'cargo %s\\n' "$*" >> "${log}"
exit 0
`,
    // The lane's only job here is to call the toolchain in the documented
    // order. `pnpm exec` runs the command from the package directory with the
    // package's own binaries ahead on PATH, which is how the lane reaches the
    // release wrapper — and how the wrapper inside it resolves
    // electron-builder without assuming an interactive shell.
    pnpm: `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >> "${log}"
args=("$@")
case "$*" in
  *"exec node ../../scripts/release-package.mjs"*)
    while [[ "\${args[0]}" != "node" ]]; do args=("\${args[@]:1}"); done
    args=("\${args[@]:1}")
    cd "${repoRoot}/apps/desktop"
    exec "\${PI_LANE_NODE}" "\${args[@]}"
    ;;
  *"exec electron-builder"*)
    while [[ "\${args[0]}" != "electron-builder" ]]; do args=("\${args[@]:1}"); done
    args=("\${args[@]:1}")
    cd "${repoRoot}/apps/desktop"
    exec electron-builder "\${args[@]}"
    ;;
esac
exit 0
`,
    // The packaging stub produces the artifacts the later steps expect. It
    // deliberately does not create them unless it was really invoked.
    "electron-builder": `#!/usr/bin/env bash
printf 'electron-builder %s\\n' "$*" >> "${log}"
app="${repoRoot}/apps/desktop/release/mac-${HOST_ARCH}/OMP Desktop.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/bin"
: > "$app/Contents/MacOS/OMP Desktop"
: > "$app/Contents/Resources/bin/pi-desktop-host-core"
: > "${repoRoot}/apps/desktop/release/OMP-Desktop-0.0.0-${HOST_ARCH}.dmg"
exit 0
`,
    codesign: `#!/usr/bin/env bash
printf 'codesign %s\\n' "$*" >> "${log}"
if [[ "$*" == *"-dv"* ]]; then
  echo "Authority=${SIGNING_IDENTITY}" >&2
  echo "flags=0x10000(runtime)" >&2
fi
exit 0
`,
    spctl: `#!/usr/bin/env bash
printf 'spctl %s\\n' "$*" >> "${log}"
echo "source=Notarized Developer ID" >&2
exit 0
`,
    xcrun: `#!/usr/bin/env bash
printf 'xcrun %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "notarytool submit")
    echo "  id: ${SUBMISSION_ID}"
    echo "  status: Accepted"
    ;;
esac
exit 0
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
}

/** Run the real lane against the stubs, and return its call log. */
async function runLane(t, extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-lane-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repoRoot = join(root, "repo");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await mkdir(join(repoRoot, "apps/desktop"), { recursive: true });
  for (const name of LANE_SCRIPTS) {
    await cp(new URL(name, scripts), join(repoRoot, "scripts", name));
  }
  await chmod(join(repoRoot, "scripts", "release-macos.sh"), 0o755);
  await writeFile(join(repoRoot, "scripts", "omp-sidecar.mjs"), SIDECAR_STUB);
  await writeStubs(bin, log, repoRoot);

  const result = spawnSync("bash", [join(repoRoot, "scripts", "release-macos.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PI_LANE_LOG: log,
      PI_LANE_NODE: process.execPath,
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password",
      APPLE_TEAM_ID: "DUV63RKYTW",
      STAPLE_DELAY_SECONDS: "1",
      ...extraEnv,
    },
  });

  const calls = (await readFile(log, "utf8")).trim().split("\n");
  return { result, calls };
}

const indexOfCall = (calls, pattern) => calls.findIndex((line) => pattern.test(line));

test("the signed local macOS lane packages through the release wrapper", async (t) => {
  const { result, calls } = await runLane(t);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  // The lane enters the release wrapper the way every `dist:*` command does:
  // through pnpm's package context, so the wrapper and the electron-builder it
  // spawns resolve without an interactive shell's PATH.
  const wrapperCall = calls.find((line) => line.includes("release-package.mjs"));
  assert.ok(wrapperCall, "the lane runs scripts/release-package.mjs");
  assert.match(wrapperCall, /^pnpm --filter @pi-desktop\/desktop exec node \.\.\/\.\.\/scripts\/release-package\.mjs /);
  assert.match(wrapperCall, new RegExp(`--platform darwin --${HOST_ARCH}\\b`));
  assert.match(wrapperCall, /--publish never/);
  assert.match(wrapperCall, /-c\.mac\.identity=XingYu Liu \(DUV63RKYTW\)/);
  assert.match(wrapperCall, /-c\.mac\.forceCodeSigning=true/);
  assert.match(wrapperCall, /-c\.mac\.notarize=true/);

  // The wrapper's own trace inside the watchdog proves the lane really went
  // through it: these lines can only be printed by the wrapper.
  assert.match(result.stdout, new RegExp(`\\[sign\\] RELEASE-PACKAGE darwin/${HOST_ARCH}: preflight`));
  assert.match(result.stdout, new RegExp(`\\[sign\\] RELEASE-PACKAGE darwin/${HOST_ARCH}: electron-builder`));

  // The preflight validates the target being packaged, and it runs first.
  const preflightIndex = indexOfCall(calls, /^sidecar /);
  assert.ok(preflightIndex > -1, "the lane runs the bundled-sidecar preflight");
  assert.equal(
    calls[preflightIndex],
    `sidecar --preflight --platform darwin --arch ${HOST_ARCH}`,
  );
  const builderIndex = indexOfCall(calls, /^electron-builder /);
  assert.ok(
    builderIndex > preflightIndex,
    `the preflight must run before electron-builder: ${JSON.stringify(calls)}`,
  );

  // Every documented flag reaches electron-builder, and only one platform.
  const builderCall = calls[builderIndex];
  assert.match(builderCall, /--mac/);
  assert.match(builderCall, new RegExp(`--${HOST_ARCH}\\b`));
  assert.match(builderCall, /--publish never/);
  assert.match(builderCall, /-c\.mac\.identity=XingYu Liu \(DUV63RKYTW\)/);
  assert.match(builderCall, /-c\.mac\.forceCodeSigning=true/);
  assert.match(builderCall, /-c\.mac\.notarize=true/);
  assert.equal(
    (builderCall.match(/--(?:mac|win|linux)\b/g) ?? []).length,
    1,
    "the wrapper hands electron-builder exactly one platform",
  );
  assert.doesNotMatch(
    builderCall,
    /notarize-and-staple-macos-release-dmg\.sh/,
    "the DMG script must be a command, not an electron-builder argument",
  );

  // The lane must submit, staple, and verify exactly once, in that order.
  const submitIndex = indexOfCall(calls, /^xcrun notarytool submit /);
  const stapleIndex = indexOfCall(calls, /^xcrun stapler staple /);
  const validateIndex = indexOfCall(calls, /^xcrun stapler validate /);
  const verifyIndex = indexOfCall(calls, /verify-macos-release\.sh|^codesign -dv/);
  assert.ok(submitIndex > builderIndex, "the DMG is submitted after packaging");
  assert.ok(stapleIndex > submitIndex, "the DMG is submitted before stapling");
  assert.ok(validateIndex > stapleIndex, "the stapled ticket is validated");
  assert.ok(verifyIndex > validateIndex, "verification happens after stapling");
  assert.equal(
    calls.filter((line) => /^xcrun notarytool submit /.test(line)).length,
    1,
    "one DMG submission",
  );

  // The lane's own phase markers pin the sequence around the DMG work: the
  // packaged bundle is inventoried, the DMG is notarized and stapled, and only
  // then is the signed release verified.
  const phases = [
    /Analyzing the packaged app bundle/,
    /Notarizing and stapling the DMG/,
    /Verifying the signed and notarized release/,
  ].map((pattern) => result.stdout.search(pattern));
  assert.ok(
    phases.every((index) => index > -1),
    `every lane phase must run: ${result.stdout}`,
  );
  assert.deepEqual([...phases].sort((a, b) => a - b), phases, "inventory, then notarize/staple, then verify");

  // The packaging phase stays wrapped, and the watchdog reports its summary.
  assert.match(result.stdout, /\[sign\] summary label=release-macos-/);
  assert.doesNotMatch(result.stdout, /STALL/);
});

test("the signed local macOS lane stops before electron-builder when the preflight fails", async (t) => {
  const { result, calls } = await runLane(t, { PI_FAKE_SIDECAR_EXIT: "1" });

  assert.notEqual(result.status, 0, "a refused preflight must fail the lane");
  assert.ok(
    calls.some((line) => /^sidecar --preflight /.test(line)),
    "the preflight ran",
  );
  assert.equal(
    calls.filter((line) => /^electron-builder /.test(line)).length,
    0,
    "electron-builder must not run when the preflight refuses",
  );
  assert.equal(
    calls.filter((line) => /^xcrun notarytool submit /.test(line)).length,
    0,
    "nothing may be notarized after a refused preflight",
  );
  assert.equal(
    calls.filter((line) => /verify-macos-release\.sh|^codesign -dv/.test(line)).length,
    0,
    "the release must not be reported verified after a refused preflight",
  );
  assert.doesNotMatch(result.stdout, /Analyzing the packaged app bundle/);
});
