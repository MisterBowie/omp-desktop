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
  BUNDLED_RUNTIME_DIR,
  OmpRuntimeSupervisor,
  PINNED_LAUNCHER_RELATIVE_PATH,
  bundledBinaryFilename,
  findPinnedLauncher,
  isExecutableAt,
  verifyBundledRuntime,
  type BundledSidecarProvenance,
  type OmpReclaimResult,
  type OmpRunPaths,
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

export type LauncherResolutionInput = {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  /** Directory to start the development walk-up from (Electron's app path). */
  appPath?: string | null;
  /** `process.resourcesPath` for a packaged build. */
  resourcesPath?: string | null;
  /** Host platform and architecture; parameters so fixtures can vary them. */
  platform?: NodeJS.Platform;
  arch?: string;
};

export type ResolvedLauncher = {
  path: string | null;
  source: "explicit" | "bundled" | "development" | null;
  /** Every location that was tried, for diagnostics. */
  tried: string[];
  /** Why no runtime was accepted; a stable, secret-free reason or null. */
  error?: string | null;
  /** Build identity of the verified bundled runtime, when one was accepted. */
  provenance?: BundledSidecarProvenance | null;
};

/**
 * Resolve the runtime executable, without starting anything.
 *
 * A packaged build and a development checkout answer this differently, and the
 * difference is enforced here rather than by convention (ADR 0307):
 *
 *   - **Packaged**: exactly one candidate, `resourcesPath/omp-runtime/<omp>`,
 *     admitted only if its provenance manifest verifies against this build's
 *     pins (`verifyBundledRuntime`). `OMP_DESKTOP_RUNTIME`, a resource tree
 *     scanned upward, and anything on `PATH` are not candidates at all — the
 *     old behaviour let an environment variable or a stray directory choose the
 *     executable of a shipped application.
 *   - **Development**: an explicit `OMP_DESKTOP_RUNTIME`, else the launcher in
 *     the pinned reference checkout found by walking up from the app path.
 *     No `PATH` lookup in either case.
 *
 * `null` is a legitimate answer: a build with no usable runtime must surface as
 * an unavailable engine rather than as a silent fallback.
 */
export function resolveRuntimeLauncher(input: LauncherResolutionInput): ResolvedLauncher {
  const tried: string[] = [];

  if (input.isPackaged) {
    if (!input.resourcesPath) {
      return {
        path: null,
        source: null,
        tried,
        error: "a packaged build must provide process.resourcesPath",
      };
    }
    const platform = input.platform ?? process.platform;
    tried.push(
      `bundled:${join(input.resourcesPath, BUNDLED_RUNTIME_DIR, bundledBinaryFilename(platform))}`,
    );
    try {
      const verified = verifyBundledRuntime({
        resourcesPath: input.resourcesPath,
        platform,
        arch: input.arch ?? process.arch,
      });
      return { path: verified.path, source: "bundled", tried, provenance: verified.provenance };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const detail = (error as { detail?: unknown })?.detail;
      const reason = `${typeof code === "string" ? code : "error"}: ${(error as Error)?.message ?? error}`;
      return {
        path: null,
        source: null,
        tried,
        error: typeof detail === "string" && detail.length > 0 ? `${reason} (${detail})` : reason,
      };
    }
  }

  const explicit = input.env?.OMP_DESKTOP_RUNTIME?.trim();
  if (explicit) {
    tried.push(`explicit:${explicit}`);
    if (isExecutableAt(explicit)) return { path: explicit, source: "explicit", tried };
    // An explicit path that is unusable is an operator error, not a reason to
    // go looking elsewhere: report it and let the engine show why.
    return { path: null, source: null, tried, error: `explicit:${explicit} is not executable` };
  }

  const start = input.appPath ?? process.cwd();
  const dev = findPinnedLauncher(start);
  tried.push(`development:${join(start, PINNED_LAUNCHER_PATH)}`);
  return dev
    ? { path: dev, source: "development", tried }
    : { path: null, source: null, tried, error: "no pinned development launcher found" };
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
  /**
   * Why resolution refused every candidate, or null when one was accepted.
   *
   * Kept verbatim (never re-worded) so the engine status and the operator see
   * the same reason the verification produced.
   */
  readonly launcherError: string | null;
  readonly tried: string[];
  status(): EngineRuntimeStatus;
  start(): Promise<EngineRuntimeStatus>;
  stop(options?: { abortBash?: boolean }): Promise<OmpReclaimResult>;
  /** Shutdown path: stop every runtime this process owns. */
  reclaim(): Promise<OmpReclaimResult[]>;
  supervisor(): OmpRuntimeSupervisor;
  /**
   * Create a fresh supervisor for one session's runtime (M4/T14-T16).
   *
   * Each session gets its own process, isolated home, run root and persistent
   * native-session directory. `prepareRun` is where the caller projects the
   * session's model configuration before the child starts; nothing from the
   * user's real directories is copied.
   */
  createSupervisor(options?: {
    sessionDir?: string | null;
    prepareRun?: (paths: OmpRunPaths) => void | Promise<void>;
    extraEnv?: NodeJS.ProcessEnv;
    /** `provider/model` to pass as `--model`; subagent event forwarding requires it. */
    modelSelector?: string | null;
    /**
     * Whether this session's runtime must carry the mandatory mode/policy
     * channel (M5/T20-B1). The wired bridge always passes `true`; a fixture
     * that never writes a run-scoped state opts out with `false`. The switch
     * becomes `OMP_DESKTOP_STATE_REQUIRED` in the child and is fixed for the
     * runtime's lifetime (see `OmpRuntimeSupervisorOptions`).
     */
    desktopStateRequired?: boolean;
  }): OmpRuntimeSupervisor;
};

export function createOmpRuntimeAdapter(
  options: OmpRuntimeAdapterOptions,
): OmpRuntimeAdapter {
  const resolved = resolveRuntimeLauncher(options);
  const factory =
    options.supervisorFactory ??
    ((supervisorOptions: ConstructorParameters<typeof OmpRuntimeSupervisor>[0]) =>
      new OmpRuntimeSupervisor(supervisorOptions));

  const resolutionError = resolved.path === null ? (resolved.error ?? null) : null;

  const supervisor = factory({
    dataRoot: options.dataRoot,
    launcherPath: resolved.path,
    expectedRuntimeVersion: options.expectedRuntimeVersion,
    ...(resolutionError ? { launcherResolutionError: resolutionError } : {}),
    ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
  });

  const createSupervisor: OmpRuntimeAdapter["createSupervisor"] = (createOptions = {}) => {
    const baseArgs = options.args && options.args.length > 0 ? [...options.args] : [];
    const args = createOptions.modelSelector
      ? [...baseArgs, "--model", createOptions.modelSelector]
      : baseArgs;
    return factory({
      dataRoot: options.dataRoot,
      launcherPath: resolved.path,
      expectedRuntimeVersion: options.expectedRuntimeVersion,
      ...(resolutionError ? { launcherResolutionError: resolutionError } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(createOptions.sessionDir ? { sessionDir: createOptions.sessionDir } : {}),
      ...(createOptions.prepareRun ? { prepareRun: createOptions.prepareRun } : {}),
      ...(createOptions.extraEnv ? { extraEnv: createOptions.extraEnv } : {}),
      ...(createOptions.desktopStateRequired !== undefined
        ? { desktopStateRequired: createOptions.desktopStateRequired }
        : {}),
    });
  };

  return {
    launcher: resolved.path,
    launcherSource: resolved.source,
    launcherError: resolutionError,
    tried: resolved.tried,
    status: () => supervisor.status(),
    start: () => supervisor.start(),
    stop: (stopOptions) => supervisor.stop(stopOptions ?? {}),
    reclaim: () => supervisor.reclaimAll(),
    supervisor: () => supervisor,
    createSupervisor,
  };
}
