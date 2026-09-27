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
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = join(APP_ROOT, "apps", "desktop");
const SIDECAR_SCRIPT = join(APP_ROOT, "scripts", "omp-sidecar.mjs");

/** electron-builder's platform switch for each release platform. */
export const PLATFORM_FLAGS = { darwin: "--mac", win32: "--win", linux: "--linux" };

/** electron-builder's architecture switches. */
export const ARCH_FLAGS = {
  x64: "--x64",
  arm64: "--arm64",
  ia32: "--ia32",
  armv7l: "--armv7l",
  universal: "--universal",
};

/** Platforms whose releases are x64-only by contract. */
const FIXED_X64_PLATFORMS = new Set(["win32", "linux"]);

/** The CLI spelling of each architecture switch (`--x64` -> `x64`). */
const ARCH_FLAG_TO_ARCH = Object.fromEntries(
  Object.entries(ARCH_FLAGS).map(([arch, flag]) => [flag, arch]),
);

const HOST = { platform: process.platform, arch: process.arch };

/** Parse the target flags this entry accepts; throws on anything unknown. */
export function parseReleaseArgs(argv) {
  const options = { platform: null, arch: null, dir: false, publish: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform" || arg === "--arch" || arg === "--publish") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--platform") options.platform = value;
      else if (arg === "--arch") options.arch = value;
      else options.publish = value;
    } else if (arg === "--dir") {
      options.dir = true;
    } else if (arg in ARCH_FLAG_TO_ARCH) {
      options.arch = ARCH_FLAG_TO_ARCH[arg];
    } else {
      throw new Error(`unknown argument: ${arg}`);
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
      ],
      cwd: DESKTOP_DIR,
    },
  };
}

/** Run the preflight, then electron-builder — only if the preflight passed. */
export function runRelease(argv, options = {}) {
  const host = options.host ?? HOST;
  const spawn = options.spawn ?? spawnSync;
  const spawnOptions = { cwd: DESKTOP_DIR, stdio: "inherit", shell: process.platform === "win32" };
  let plan;
  try {
    plan = planRelease(argv, host);
  } catch (error) {
    console.error(`RELEASE-PACKAGE-FAIL ${error.message}`);
    return 2;
  }
  console.log(
    `RELEASE-PACKAGE ${plan.target.platform}/${plan.target.arch}: preflight ${[plan.preflight.command, ...plan.preflight.args].join(" ")}`,
  );
  const preflight = spawn(plan.preflight.command, plan.preflight.args, spawnOptions);
  if (preflight.status !== 0) return preflight.status ?? 1;
  console.log(`RELEASE-PACKAGE ${plan.target.platform}/${plan.target.arch}: electron-builder ${plan.builder.args.join(" ")}`);
  const builder = spawn(plan.builder.command, plan.builder.args, {
    ...spawnOptions,
    cwd: plan.builder.cwd,
  });
  return builder.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runRelease(process.argv.slice(2)));
}
