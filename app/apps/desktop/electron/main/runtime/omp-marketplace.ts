/**
 * The desktop's OMP marketplace service (ADR 0333).
 *
 * The runtime owns the marketplace: every mutation is the pinned runtime's own
 * `omp plugin …` command, run against the desktop store under the session
 * environment policy. This module validates what the renderer asks for,
 * serializes mutations so two CLI runs never race on OMP's registries, and
 * answers with the state re-read from disk. Sessions pick up a change at their
 * next prompt: the store's run snapshot is part of the launch fingerprint, so an
 * idle runtime is replaced before it runs with a stale plugin set.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  ErrorCodes,
  OMP_RUNTIME_VERSION,
  proxyEnvAssignments,
  type NetworkProxySettings,
  type OmpMarketState,
} from "@pi-desktop/shared";
import {
  ensureOmpMarketplaceStore,
  isOmpNameSegment,
  marketplaceRunSnapshot,
  ompMarketplaceStore,
  ompPluginCliFailure,
  parseOmpPluginId,
  pruneStaleNatives,
  readOmpMarketState,
  runOmpPluginCli,
  type MarketplaceRunSnapshot,
  type OmpMarketplaceStore,
} from "@pi-desktop/omp-runtime";

/** Error code for a CLI run that OMP itself rejected. */
export const OMP_MARKET_COMMAND_FAILED = "OMP_MARKET_COMMAND_FAILED";

const MAX_SOURCE_CHARS = 2048;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCP_GIT = /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s]+$/;
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

/**
 * Normalize a marketplace source to a form OMP classifies the same way and
 * that cannot be read as a CLI flag. Local paths are made absolute against the
 * operator's home — OMP would expand `~` against the store's HOME instead.
 * Plain `http://` and `file://` sources are refused: a catalog and the plugins
 * it names must not arrive over an unauthenticated channel.
 */
export function normalizeMarketplaceSource(input: unknown, home: string = homedir()): string {
  if (typeof input !== "string") throw invalid("marketplace source must be a string");
  const source = input.trim();
  if (!source || source.length > MAX_SOURCE_CHARS) throw invalid("marketplace source is empty or too long");
  if (CONTROL_CHARS.test(source)) throw invalid("marketplace source contains control characters");
  if (source.startsWith("-")) throw invalid("marketplace source cannot start with '-'");
  if (source === "~" || source.startsWith("~/") || source.startsWith("~\\")) {
    return resolve(home, source.slice(2));
  }
  if (source.startsWith("/") || WINDOWS_PATH.test(source)) return resolve(source);
  if (source.startsWith("./") || source.startsWith("../") || source === "." || source === "..") {
    throw invalid("use an absolute path for a local marketplace");
  }
  if (/^https:\/\//i.test(source) || /^ssh:\/\//i.test(source) || SCP_GIT.test(source) || GITHUB_SHORTHAND.test(source)) {
    return source;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) throw invalid("only https, ssh and git sources are supported");
  throw invalid("unrecognized marketplace source");
}

function pluginIdArg(input: unknown): string {
  if (!parseOmpPluginId(input)) throw invalid("plugin id must be name@marketplace");
  return input as string;
}

function marketplaceArg(input: unknown): string {
  if (!isOmpNameSegment(input)) throw invalid("invalid marketplace name");
  return input;
}

export type OmpMarketplaceLauncher = { path: string | null; error: string | null };

export type OmpMarketplaceServiceDeps = {
  dataRoot: string;
  launcher: () => OmpMarketplaceLauncher;
  /** Chromium proxy list for a URL (`session.resolveProxy`), used in system proxy mode. */
  systemProxy?: (url: string) => Promise<string>;
  networkProxy?: () => NetworkProxySettings;
  log?: (level: "info" | "warn" | "error", message: string, data?: string) => void;
  /** Test seams. */
  runCli?: typeof runOmpPluginCli;
  timeoutMs?: number;
  home?: string;
};

export type OmpMarketplaceService = {
  readonly store: OmpMarketplaceStore;
  state(): Promise<OmpMarketState>;
  addSource(source: unknown): Promise<OmpMarketState>;
  removeSource(name: unknown): Promise<OmpMarketState>;
  updateSources(name?: unknown): Promise<OmpMarketState>;
  install(id: unknown): Promise<OmpMarketState>;
  uninstall(id: unknown): Promise<OmpMarketState>;
  setEnabled(id: unknown, enabled: unknown): Promise<OmpMarketState>;
  upgrade(id: unknown): Promise<OmpMarketState>;
  /** The plugin set a run started now would load. */
  runSnapshot(): MarketplaceRunSnapshot;
  /** Cancel the running command and refuse new ones. */
  dispose(): void;
};

/** Hosts the CLI never sends through a resolved system proxy. */
const SYSTEM_PROXY_BYPASS = "localhost,127.0.0.1,::1";

/**
 * The first usable entry of a Chromium proxy list (`PROXY h:p; DIRECT`) as a
 * URL git and the runtime understand, or null for DIRECT/unsupported.
 */
export function proxyUrlFromChromiumList(list: string): string | null {
  for (const entry of list.split(";")) {
    const [kind, hostPort] = entry.trim().split(/\s+/);
    if (!kind || !hostPort) continue;
    const scheme = { PROXY: "http", HTTP: "http", HTTPS: "https", SOCKS: "socks5", SOCKS5: "socks5" }[kind.toUpperCase()];
    if (scheme) return `${scheme}://${hostPort}`;
  }
  return null;
}

async function proxyFor(deps: OmpMarketplaceServiceDeps): Promise<{ url: string; bypass: string } | undefined> {
  const settings = deps.networkProxy?.();
  if (settings?.mode === "custom") {
    const assignments = proxyEnvAssignments(settings);
    const url = assignments.ALL_PROXY;
    return url ? { url, bypass: assignments.NO_PROXY ?? "" } : undefined;
  }
  if (settings?.mode === "direct") return undefined;
  // System mode: git does not read the OS proxy, so resolve it the way the
  // desktop's own network stack would for a typical source host.
  try {
    const list = await deps.systemProxy?.("https://github.com/");
    const url = list ? proxyUrlFromChromiumList(list) : null;
    return url ? { url, bypass: SYSTEM_PROXY_BYPASS } : undefined;
  } catch (error) {
    deps.log?.("warn", "OMP marketplace system proxy unresolved", (error as Error).message);
    return undefined;
  }
}

export function createOmpMarketplaceService(deps: OmpMarketplaceServiceDeps): OmpMarketplaceService {
  const store = ompMarketplaceStore(deps.dataRoot);
  const runCli = deps.runCli ?? runOmpPluginCli;
  const controller = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();

  const readState = (): OmpMarketState => {
    const launcher = deps.launcher();
    return readOmpMarketState(store, {
      available: launcher.path !== null,
      ...(launcher.path === null ? { unavailableReason: launcher.error ?? "no OMP runtime is configured" } : {}),
      onDiagnostic: (message) => deps.log?.("warn", "OMP marketplace store", message),
    });
  };

  const run = async (args: string[]): Promise<void> => {
    if (controller.signal.aborted) throw Object.assign(new Error("the marketplace service is shut down"), { errorCode: ErrorCodes.AGENT_UNAVAILABLE });
    const launcher = deps.launcher();
    if (!launcher.path) {
      throw Object.assign(new Error(`OMP runtime unavailable: ${launcher.error ?? "not configured"}`), {
        errorCode: ErrorCodes.AGENT_UNAVAILABLE,
      });
    }
    ensureOmpMarketplaceStore(store);
    const proxy = await proxyFor(deps);
    const result = await runCli({
      launcher: launcher.path,
      store,
      args,
      signal: controller.signal,
      ...(proxy ? { proxy } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
    pruneStaleNatives(store, OMP_RUNTIME_VERSION);
    if (result.exitCode !== 0) {
      const message = ompPluginCliFailure(result);
      deps.log?.("warn", "OMP marketplace command failed", `${args[0]} ${args[1] ?? ""}: ${message}`);
      throw Object.assign(new Error(message), { errorCode: OMP_MARKET_COMMAND_FAILED });
    }
    deps.log?.("info", "OMP marketplace command completed", `${args[0]} ${args[1] ?? ""}`);
  };

  /** Validate first (synchronously), then run behind every earlier mutation. */
  const mutate = (build: () => string[]): Promise<OmpMarketState> => {
    let args: string[];
    try {
      args = build();
    } catch (error) {
      return Promise.reject(error);
    }
    const next = queue.then(
      () => run(args),
      () => run(args),
    );
    queue = next.catch(() => undefined);
    return next.then(readState);
  };

  return {
    store,
    state: async () => readState(),
    addSource: (source) => mutate(() => ["marketplace", "add", normalizeMarketplaceSource(source, deps.home)]),
    removeSource: (name) => mutate(() => ["marketplace", "remove", marketplaceArg(name)]),
    updateSources: (name) =>
      mutate(() => (name === undefined || name === null ? ["marketplace", "update"] : ["marketplace", "update", marketplaceArg(name)])),
    install: (id) => mutate(() => ["install", pluginIdArg(id), "--scope", "user"]),
    uninstall: (id) => mutate(() => ["uninstall", pluginIdArg(id), "--scope", "user"]),
    setEnabled: (id, enabled) =>
      mutate(() => {
        if (typeof enabled !== "boolean") throw invalid("enabled must be a boolean");
        return [enabled ? "enable" : "disable", pluginIdArg(id), "--scope", "user"];
      }),
    upgrade: (id) => mutate(() => ["upgrade", pluginIdArg(id), "--scope", "user"]),
    runSnapshot: () => marketplaceRunSnapshot(store),
    dispose: () => controller.abort(),
  };
}
