/**
 * Desktop adapter for the OMP runtime: where its executable comes from, and the
 * supervisor this process owns.
 *
 * The runtime is not started by this module's construction. M2 ships the
 * boundary — a runtime that can be started, supervised and stopped, with an
 * isolated home — and nothing in the product drives a conversation through it
 * yet, so boot does not pay for a process nobody uses.
 *
 * Where the executable may come from, in priority order:
 *
 *   1. `OMP_DESKTOP_RUNTIME` — an explicit absolute path (development, probes).
 *   2. A packaged build's bundled runtime (`resources/omp-runtime/omp`). M6
 *      decides how it is produced; until it exists, a packaged build reports
 *      the engine as unavailable rather than reaching for a global `omp`.
 *   3. Development: the launcher inside the pinned submodule, found by walking
 *      up from the app directory. This is the source tree this build was
 *      validated against, not "whatever `omp` is on PATH".
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { EngineRuntimeStatus } from "@pi-desktop/shared";
import {
  OmpRuntimeSupervisor,
  PINNED_LAUNCHER_RELATIVE_PATH,
  findPinnedLauncher,
  isExecutableAt,
  type OmpReclaimResult,
} from "@pi-desktop/omp-runtime";

/**
 * Launcher inside the pinned OMP submodule, relative to a repository root.
 *
 * Re-exported from the runtime package, which owns the location and the
 * search, so a development checkout has exactly one definition of where its
 * reference runtime lives.
 */
export const PINNED_LAUNCHER_PATH = PINNED_LAUNCHER_RELATIVE_PATH;

export { findPinnedLauncher };

/** Bundled runtime inside a packaged app's resources (M6). */
export const BUNDLED_LAUNCHER_PATH = join("omp-runtime", "omp");

/** Bundled tool gate inside a packaged app's resources (the runtime loads it). */
export const BUNDLED_GATE_PATH = join("omp-runtime", "extensions", "omp-desktop-gate.ts");

export type LauncherResolutionInput = {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  /** Directory to start the development walk-up from (Electron's app path). */
  appPath?: string | null;
  /** `process.resourcesPath` for a packaged build. */
  resourcesPath?: string | null;
};

export type ResolvedLauncher = {
  path: string | null;
  source: "explicit" | "bundled" | "development" | null;
  /** Every location that was tried, for diagnostics. */
  tried: string[];
};

/**
 * Resolve the runtime executable, without starting anything.
 *
 * `null` is a legitimate answer: this product has no bundled runtime until M6,
 * and a missing runtime must surface as an unavailable engine rather than as a
 * silent fallback to a globally installed `omp`.
 */
export function resolveRuntimeLauncher(input: LauncherResolutionInput): ResolvedLauncher {
  const tried: string[] = [];
  const explicit = input.env?.OMP_DESKTOP_RUNTIME?.trim();
  if (explicit) {
    tried.push(`explicit:${explicit}`);
    if (isExecutableAt(explicit)) return { path: explicit, source: "explicit", tried };
    // An explicit path that is unusable is an operator error, not a reason to
    // go looking elsewhere: report it and let the engine show why.
    return { path: null, source: null, tried };
  }

  if (input.isPackaged && input.resourcesPath) {
    const bundled = join(input.resourcesPath, BUNDLED_LAUNCHER_PATH);
    tried.push(`bundled:${bundled}`);
    if (isExecutableAt(bundled)) return { path: bundled, source: "bundled", tried };
    return { path: null, source: null, tried };
  }

  const start = input.appPath ?? process.cwd();
  const dev = findPinnedLauncher(start);
  tried.push(`development:${join(start, PINNED_LAUNCHER_PATH)}`);
  return dev ? { path: dev, source: "development", tried } : { path: null, source: null, tried };
}

export type OmpRuntimeAdapterOptions = LauncherResolutionInput & {
  /**
   * Extra runtime arguments, after `--mode rpc-ui`. The desktop passes the
   * gate extension here; the supervisor refuses nothing on its own, so a
   * caller that cannot resolve the gate must not start a runtime at all
   * (see `createOmpSessionBridge`).
   */
  args?: readonly string[];
  /** Product data root; the supervisor owns everything below it. */
  dataRoot: string;
  /** Version this build expects; defaults to the shared pin. */
  expectedRuntimeVersion?: string | null;
  /** Test seams. */
  supervisorFactory?: (options: ConstructorParameters<typeof OmpRuntimeSupervisor>[0]) => OmpRuntimeSupervisor;
};

export type OmpRuntimeAdapter = {
  /** Absolute launcher path, or null when this build has none. */
  readonly launcher: string | null;
  readonly launcherSource: ResolvedLauncher["source"];
  readonly tried: string[];
  status(): EngineRuntimeStatus;
  start(): Promise<EngineRuntimeStatus>;
  stop(options?: { abortBash?: boolean }): Promise<OmpReclaimResult>;
  /** Shutdown path: stop every runtime this process owns. */
  reclaim(): Promise<OmpReclaimResult[]>;
  supervisor(): OmpRuntimeSupervisor;
};

export function createOmpRuntimeAdapter(
  options: OmpRuntimeAdapterOptions,
): OmpRuntimeAdapter {
  const resolved = resolveRuntimeLauncher(options);
  const factory =
    options.supervisorFactory ??
    ((supervisorOptions: ConstructorParameters<typeof OmpRuntimeSupervisor>[0]) =>
      new OmpRuntimeSupervisor(supervisorOptions));

  const supervisor = factory({
    dataRoot: options.dataRoot,
    launcherPath: resolved.path,
    expectedRuntimeVersion: options.expectedRuntimeVersion,
    ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
  });

  return {
    launcher: resolved.path,
    launcherSource: resolved.source,
    tried: resolved.tried,
    status: () => supervisor.status(),
    start: () => supervisor.start(),
    stop: (stopOptions) => supervisor.stop(stopOptions ?? {}),
    reclaim: () => supervisor.reclaimAll(),
    supervisor: () => supervisor,
  };
}
