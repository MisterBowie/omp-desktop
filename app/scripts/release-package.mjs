#!/usr/bin/env node
/**
 * Release packaging entry: pick the target once, then use it everywhere.
 *
 * The bundled OMP sidecar is a native, platform-specific artifact, so a release
 * has two target-sensitive steps: the sidecar preflight (which builds the
 * artifact for a host target or verifies a staged one for a cross target) and
 * electron-builder (which packages the app for one platform/architecture).
 * Electron's `pnpm run dist:mac -- --x64` appends the architecture flag to the
 * LAST command of the script chain, so a preflight earlier in the chain could
 * not see it — an arm64 Mac asked for x64 built an arm64 sidecar and packaged
 * it into an x64 application (review finding 2).
 *
 * This entry is the last command in every `pack`/`dist` release script and owns
 * both target-sensitive steps. It parses the architecture passthrough once and
 * gives the same platform/architecture to the preflight and to electron-builder;
 * it refuses to start either when the target is not usable (for example a mac
 * cross-release with no explicit architecture, whose artifact would have to be
 * staged first).
 *
 * Contract per platform:
 *   - darwin: the architecture is the explicit `--x64`/`--arm64`/`--arch`, or
 *     the host's when it is a native build; a cross architecture requires a
 *     staged artifact, which `omp-sidecar.mjs --preflight` already enforces.
 *   - win32/linux: fixed x64, matching the shipped preflight aliases and the
 *     release matrix; the same `--x64` is passed to electron-builder so the
 *     package and the sidecar can never disagree.
 *
 * Arguments. The entry interprets the command line in three buckets, and
 * nothing reaches electron-builder that could move one side without the other:
 *
 *   - Owned axes: platform, architecture, `--dir` and publish. electron-builder
 *     gives every one of them more than one accepted spelling, so a forwarded
 *     spelling is the same fork the entry exists to close. The installed CLI's
 *     yargs contract (`electron-builder/out/builder.js`
 *     `configureBuildCommand`, exercised by
 *     `apps/desktop/test/omp-release-gate.test.mjs`) is the source of truth:
 *     `--mac`/`-m`/`-o`/`--macos`, `--win`/`-w`/`--windows`, `--linux`/`-l`
 *     (target lists and bundled short clusters such as `-mwl` or `-mdmg` are
 *     refused, because the platform axis names the platform only); the boolean
 *     architecture switches (`--x64`, `--arm64`, …) including their `=true` and
 *     `=<literal> true` forms; `--dir`; and `--publish` with its `-p`/`--p`
 *     aliases in the space, `=` and attached forms. The entry regenerates each
 *     axis exactly once, so the builder argv can only contain one platform
 *     switch, at most one architecture switch, at most one `--dir` and one
 *     normalized `--publish <value>`. Negations (`--no-x64`, `--dir=false`) are
 *     refused rather than forwarded: a negation is a second declaration of an
 *     axis that already has an owner.
 *
 *   - Refused: builder arguments that replace or stop the package the preflight
 *     validated. `--prepackaged`/`--pd` make `doPack` a no-op and package an
 *     external application (`app-builder-lib/out/platformPackager.js:146`,
 *     `out/macPackager.js:268-270`), so the sidecar preflight would validate one
 *     input while the builder packages another; `--projectDir`/`--project`
 *     move the project the config is read from; `--config`/`-c`/`--c` as a
 *     *path* substitutes an external configuration file, and a path combined
 *     with dotted overrides becomes an `extends` merge. Dotted config
 *     overrides are therefore only accepted through the source-neutral
 *     allowlist below — a key may be allowed only when it cannot change the
 *     packaged input set, and never "any key except a denylist".
 *
 *   - Forwarded verbatim, in the given order: the dotted overrides on that
 *     allowlist, and every token that is not an option electron-builder
 *     declares. The forwarding contract keeps the signed lane working: upstream
 *     PI Desktop puts electron-builder last in every release command
 *     (`upstream/pi-desktop/apps/desktop/package.json:27-31`), so the release
 *     workflow appends builder configuration through the package script —
 *     `-c.mac.forceCodeSigning=true` and `-c.mac.notarize=true` on the signed
 *     macOS lane (`upstream/pi-desktop/.github/workflows/release.yml:245-287`),
 *     and the local signed lane adds `-c.mac.identity=<name>`. Those three
 *     signature-phase overrides select a certificate or a signing/notarization
 *     gate and cannot add, move or rename a single packaged file, so they are
 *     the allowlist. Refusing them breaks the signed release; recognizing only
 *     today's two flags breaks the next one.
 *
 * Entry points: the `pack`/`dist`/`dist:*` package scripts append this module
 * after `electron-vite build`, and the signed local lane
 * (`scripts/release-macos.sh`) enters it the same way, through `pnpm --filter
 * @pi-desktop/desktop exec node ../../scripts/release-package.mjs`, so the
 * electron-builder this module spawns resolves from the workspace instead of
 * relying on an interactive shell's PATH.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = join(APP_ROOT, "apps", "desktop");
const SIDECAR_SCRIPT = join(APP_ROOT, "scripts", "omp-sidecar.mjs");

/** electron-builder's platform switch for each release platform. */
export const PLATFORM_FLAGS = { darwin: "--mac", win32: "--win", linux: "--linux" };

/**
 * Every spelling the installed electron-builder CLI accepts for a platform
 * switch (`out/builder.js`: `--mac` aliases `-m`, `-o`, `--macos`; `--win`
 * aliases `-w`, `--windows`; `--linux` aliases `-l`). yargs accepts an alias as
 * a long option too (`--m`, `--w`, `--l`, `--o`), so a single-char alias is a
 * second spelling of the same switch, not a different one: they are all
 * additive in electron-builder, so forwarding any of them builds a second
 * platform and is the same fork under another spelling.
 */
const PLATFORM_SWITCHES = {
  "--mac": "darwin",
  "-m": "darwin",
  "--m": "darwin",
  "-o": "darwin",
  "--o": "darwin",
  "--macos": "darwin",
  "--win": "win32",
  "-w": "win32",
  "--w": "win32",
  "--windows": "win32",
  "--linux": "linux",
  "-l": "linux",
  "--l": "linux",
};

/** Long platform switches, longest first, for the near-miss refusal below. */
const PLATFORM_LONG_SWITCHES = ["--macos", "--windows", "--linux", "--mac", "--win"];

/** The short platform switches; any other token starting with one bundles several switches or attaches a target list. */
const PLATFORM_SHORT_SWITCHES = ["-m", "-o", "-w", "-l"];

/** electron-builder's architecture switches (`configureBuildCommand`, type boolean). */
export const ARCH_FLAGS = {
  x64: "--x64",
  arm64: "--arm64",
  ia32: "--ia32",
  armv7l: "--armv7l",
  universal: "--universal",
};

/** The CLI spelling of each architecture switch (`--x64` -> `x64`). */
const ARCH_SWITCHES = Object.fromEntries(
  Object.entries(ARCH_FLAGS).map(([arch, flag]) => [flag, arch]),
);

/** The architecture switch spellings, for the near-miss refusal below. */
const ARCH_LONG_SWITCHES = Object.keys(ARCH_SWITCHES);

/** The entry's publish axis: `--publish` plus the aliases the installed CLI declares. */
const PUBLISH_SWITCHES = ["--publish", "-p", "--p"];

/**
 * The values the installed CLI declares for `--publish`
 * (`configureBuildCommand`, `choices`). The release entry owns the axis, so it
 * validates the value the builder would reject anyway — before it spawns the
 * preflight, which on a host target compiles the whole sidecar. The contract
 * test reads the choice list back from the installed electron-builder, so a
 * version that adds a value fails the suite instead of silently refusing it.
 */
export const PUBLISH_CHOICES = ["onTag", "onTagOrDraft", "always", "never"];

/**
 * Dotted electron-builder config overrides the release entry forwards.
 *
 * Source-neutral allowlist: a key belongs here only when it selects a signing
 * or notarization phase and cannot change the packaged input set (no files,
 * extra resources, extra files, app directory, `extends`, or a platform's
 * target list). These three are exactly what the fixed upstream lanes pass:
 * `-c.mac.identity=<common name>` on the local Developer ID lane and
 * `-c.mac.forceCodeSigning=true` / `-c.mac.notarize=true` on both
 * (`upstream/pi-desktop/.github/workflows/release.yml:245-287`). An unknown key
 * is refused, and so is a key that is *about* to change a source: allowing
 * "any `-c.*`" would let `-c.files`, `-c.extraResources`,
 * `-c.directories.app` or `-c.extends` replace the app the preflight validated.
 */
export const ALLOWED_CONFIG_OVERRIDES = ["mac.identity", "mac.forceCodeSigning", "mac.notarize"];

/** The three spellings the installed CLI accepts for the config option (`-c`, `--c`, `--config`). */
const CONFIG_SWITCHES = ["-c", "--c", "--config"];

/**
 * Arguments the installed electron-builder CLI accepts that would replace or
 * stop the package this entry validated. `--prepackaged`/`--pd` skip
 * `doPack` and package the external application
 * (`app-builder-lib/out/platformPackager.js:146` returns early,
 * `out/macPackager.js:268-270` hashes straight to the external path);
 * `--projectDir`/`--project` read another project; `--help`/`--version`
 * end the builder before it packages anything, which would make a release
 * "succeed" without an artifact.
 */
const REFUSED_BUILDER_ARGUMENTS = new Map([
  ["--prepackaged", "it packages an external application instead of the validated build"],
  ["--pd", "it packages an external application instead of the validated build"],
  ["--projectDir", "it reads the project from another directory"],
  ["--project", "it reads the project from another directory"],
  ["--help", "it stops electron-builder before it packages anything"],
  ["--version", "it stops electron-builder before it packages anything"],
]);

/** Platforms whose releases are x64-only by contract. */
const FIXED_X64_PLATFORMS = new Set(["win32", "linux"]);

const HOST = { platform: process.platform, arch: process.arch };

/** `--flag=value` split into its flag and its attached value (`null` when there is none). */
function splitArgument(arg) {
  const eq = arg.indexOf("=");
  return eq === -1 ? { flag: arg, attached: null } : { flag: arg.slice(0, eq), attached: arg.slice(eq + 1) };
}

function refuse(message) {
  throw new Error(message);
}

/**
 * Parse the command line.
 *
 * The entry owns four axes (platform, architecture, dir, publish) and refuses
 * the builder arguments that could replace the packaging input; everything else
 * is forwarded verbatim, in the given order. See the module header for the
 * contract and the evidence behind each bucket.
 *
 * An owned axis is one declaration however it is spelled: `--x64 --arm64`,
 * `--x64 --arch arm64`, `--platform darwin --platform win32`, `--mac
 * --platform darwin`, `--win --linux` and `--dir --dir` are refusals rather
 * than a silent last-one-wins, because a duplicated axis is exactly the case
 * where the preflight and the package could end up on different targets. Every
 * refusal names the argument that caused it.
 */
export function parseReleaseArgs(argv) {
  const options = { platform: null, arch: null, dir: false, publish: null, forwarded: [] };
  const declared = { platform: [], arch: [], dir: [], publish: [] };
  const declare = (axis, label, value) => {
    declared[axis].push(label);
    if (axis === "publish") options.publish = value;
    else if (axis === "dir") options.dir = true;
    else options[axis] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const { flag, attached } = splitArgument(arg);
    /** The value of an owned option, from `=<value>` or from the next argument. */
    const takeValue = () => {
      if (attached !== null) {
        if (attached === "") refuse(`the release entry needs a value for ${arg}`);
        return attached;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        refuse(`the release entry needs a value for ${arg}`);
      }
      index += 1;
      return value;
    };
    /** yargs consumes a literal `true`/`false` after a boolean option; `false` is a negation. */
    const consumeBooleanLiteral = (describe) => {
      const value = argv[index + 1];
      if (value === "true") index += 1;
      else if (value === "false") {
        refuse(`the release entry does not accept a negated ${describe}: ${arg} false`);
      }
    };
    /**
     * A platform declaration also checks what follows it: electron-builder's
     * platform switches take a target list as their value (`--mac dmg zip`),
     * and a bare token after `--platform <value>` is the same list in another
     * spelling. The platform axis selects the platform and nothing else, so the
     * list is refused instead of being dropped or forwarded next to the flag
     * this entry picks.
     */
    const declarePlatform = (label, platform) => {
      declare("platform", label, platform);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        refuse(`a platform target list is not supported: ${label} ${next}`);
      }
    };

    if (arg === "--") {
      refuse(`the release entry does not support "--": it would hide the rest of the command line from electron-builder`);
    }
    if (flag === "--platform" || flag === "--arch") {
      const value = takeValue();
      if (flag === "--platform") declarePlatform(`${flag} ${value}`, value);
      else declare("arch", `${flag} ${value}`, value);
      continue;
    }
    if (flag.startsWith("--no-")) {
      refuse(`the release entry does not accept the negated argument ${arg}: the axis it would negate is owned here`);
    }
    if (flag === "--dir") {
      if (attached !== null) {
        if (attached !== "true") refuse(`the release entry does not accept a negated --dir: ${arg}`);
      } else {
        consumeBooleanLiteral("--dir");
      }
      declare("dir", arg);
      continue;
    }
    if (flag in ARCH_SWITCHES) {
      if (attached !== null) {
        if (attached !== "true") refuse(`the release entry does not accept the negated architecture ${arg}`);
      } else {
        consumeBooleanLiteral("architecture");
      }
      declare("arch", arg, ARCH_SWITCHES[flag]);
      continue;
    }
    if (PUBLISH_SWITCHES.includes(flag)) {
      const value = takeValue();
      if (!PUBLISH_CHOICES.includes(value)) {
        refuse(
          `unsupported publish value for ${arg}: ${value} (the installed electron-builder accepts ${PUBLISH_CHOICES.join(", ")})`,
        );
      }
      declare("publish", arg, value);
      continue;
    }
    if (flag in PLATFORM_SWITCHES) {
      // A target list is refused (`--mac dmg zip`, `-m=dmg`, `--w=portable`).
      // The long spellings' empty value is the same declaration as the bare
      // switch (`--mac=`, `--m=`); a single-dash switch takes no `=` at all —
      // the installed CLI rejects `-m=`.
      if (attached !== null && (!flag.startsWith("--") || attached !== "")) {
        refuse(`a platform target list is not supported: ${arg}`);
      }
      declarePlatform(arg, PLATFORM_SWITCHES[flag]);
      continue;
    }
    if (REFUSED_BUILDER_ARGUMENTS.has(flag)) {
      refuse(`the release entry refuses ${arg}: ${REFUSED_BUILDER_ARGUMENTS.get(flag)}`);
    }
    const configSwitch = CONFIG_SWITCHES.find(
      (candidate) => flag === candidate || flag.startsWith(`${candidate}.`),
    );
    if (configSwitch !== undefined) {
      if (!flag.startsWith(`${configSwitch}.`)) {
        refuse(`the release entry does not support an external electron-builder config: ${arg}`);
      }
      const key = flag.slice(configSwitch.length + 1);
      if (attached === null || attached === "") {
        refuse(`the release entry needs an attached =<value> for a config override: ${arg}`);
      }
      if (!ALLOWED_CONFIG_OVERRIDES.includes(key)) {
        refuse(
          `the release entry refuses the electron-builder config override ${arg}: it is not on the signature allowlist (${ALLOWED_CONFIG_OVERRIDES.join(", ")})`,
        );
      }
      options.forwarded.push(arg);
      continue;
    }
    // Near misses: a token that starts like an owned option but is not one of
    // its declared spellings (a short cluster such as `-mwl` or `-mdmg`, an
    // attached value such as `-pad`, an unknown prefix such as `--macosx`, a
    // config spelling such as `-csome.yml`). Refusing names the argument;
    // forwarding it would only rely on electron-builder's own parser, which is
    // the parser the entry must not hand the axis to.
    if (PLATFORM_SHORT_SWITCHES.some((short) => arg.startsWith(short))) {
      refuse(`unsupported platform argument: ${arg}: the release entry takes one platform switch, not a bundle of switches or an attached target list`);
    }
    if (PLATFORM_LONG_SWITCHES.some((long) => flag.startsWith(long))) {
      refuse(`unsupported platform argument: ${arg}: the release entry takes one platform switch, not an attached target list`);
    }
    if (ARCH_LONG_SWITCHES.some((arch) => flag.startsWith(arch))) {
      refuse(`unsupported architecture argument: ${arg}: the release entry takes one architecture switch, without a value`);
    }
    if (arg.startsWith("-p") || arg.startsWith("--p")) {
      refuse(`unsupported argument: ${arg}: the publish, prepackaged and project options are owned or refused by the release entry`);
    }
    if (arg.startsWith("-c") || arg.startsWith("--c")) {
      refuse(`unsupported argument: ${arg}: the electron-builder config option is refused or restricted to the signature allowlist by the release entry`);
    }
    if (flag.startsWith("--dir")) {
      refuse(`unsupported argument: ${arg}: --dir takes no value`);
    }
    options.forwarded.push(arg);
  }

  for (const [axis, labels] of Object.entries(declared)) {
    if (labels.length > 1) {
      const what = axis === "platform" ? "release platform" : axis === "arch" ? "release architecture" : axis;
      refuse(`${what} must be given once; got ${labels.join(", ")}`);
    }
  }
  return options;
}

/**
 * Select the one platform/architecture the release runs for.
 *
 * Throws when the target is not usable (an unsupported platform, a
 * non-x64 Windows/Linux release, or a mac cross-release whose architecture was
 * not stated).
 */
export function resolveReleaseTarget(parsed, host = HOST) {
  const platform = parsed.platform ?? host.platform;
  const builderFlag = PLATFORM_FLAGS[platform];
  if (!builderFlag) throw new Error(`unsupported release platform: ${platform}`);
  if (parsed.arch && !(parsed.arch in ARCH_FLAGS)) {
    throw new Error(`unsupported release architecture: ${parsed.arch}`);
  }
  if (FIXED_X64_PLATFORMS.has(platform)) {
    if (parsed.arch && parsed.arch !== "x64") {
      throw new Error(
        `a ${platform} release is x64-only; refusing the requested ${parsed.arch}`,
      );
    }
    return { platform, arch: "x64", builderFlag, archFlag: ARCH_FLAGS.x64 };
  }
  const arch = parsed.arch ?? (platform === host.platform ? host.arch : null);
  if (!arch) {
    throw new Error(
      `--arch is required for a ${platform} release from a ${host.platform} host: a cross-target package needs an artifact staged for that target`,
    );
  }
  if (!(arch in ARCH_FLAGS)) throw new Error(`unsupported release architecture: ${arch}`);
  // A native mac build follows the runner (no pinned target); an explicit
  // architecture selects that package target in electron-builder too.
  return { platform, arch, builderFlag, archFlag: parsed.arch ? ARCH_FLAGS[arch] : null };
}

/** The preflight and electron-builder invocations for one release. */
export function planRelease(argv, host = HOST) {
  const parsed = parseReleaseArgs(argv);
  const target = resolveReleaseTarget(parsed, host);
  return {
    target: { platform: target.platform, arch: target.arch },
    preflight: {
      command: process.execPath,
      args: [SIDECAR_SCRIPT, "--preflight", "--platform", target.platform, "--arch", target.arch],
    },
    builder: {
      command: "electron-builder",
      args: [
        target.builderFlag,
        ...(target.archFlag ? [target.archFlag] : []),
        ...(parsed.dir ? ["--dir"] : []),
        "--publish",
        parsed.publish ?? "never",
        ...parsed.forwarded,
      ],
      cwd: DESKTOP_DIR,
    },
  };
}

/** Run the preflight, then electron-builder — only if the preflight passed. */
export function runRelease(argv, options = {}) {
  const host = options.host ?? HOST;
  const spawn = options.spawn ?? spawnSync;
  const log = options.log ?? console.log;
  const logError = options.error ?? console.error;
  const spawnOptions = { cwd: DESKTOP_DIR, stdio: "inherit", shell: process.platform === "win32" };
  let plan;
  try {
    plan = planRelease(argv, host);
  } catch (error) {
    logError(`RELEASE-PACKAGE-FAIL ${error.message}`);
    return 2;
  }
  log(
    `RELEASE-PACKAGE ${plan.target.platform}/${plan.target.arch}: preflight ${[plan.preflight.command, ...plan.preflight.args].join(" ")}`,
  );
  const preflight = spawn(plan.preflight.command, plan.preflight.args, spawnOptions);
  if (preflight.status !== 0) return preflight.status ?? 1;
  log(`RELEASE-PACKAGE ${plan.target.platform}/${plan.target.arch}: electron-builder ${plan.builder.args.join(" ")}`);
  const builder = spawn(plan.builder.command, plan.builder.args, {
    ...spawnOptions,
    cwd: plan.builder.cwd,
  });
  return builder.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runRelease(process.argv.slice(2)));
}
