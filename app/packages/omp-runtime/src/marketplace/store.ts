/**
 * The desktop-owned OMP marketplace store and read-only views of its registries
 * (ADR 0333).
 *
 * The store is a persistent OMP home inside the desktop's data root. Only the
 * pinned runtime's own CLI writes it (`cli.ts`); this module reads what that CLI
 * left behind — the marketplaces registry, the normalized catalog copy OMP writes
 * after every add/update, and the installed-plugins registry — and never trusts
 * a recorded path that points outside the store.
 *
 * Layout, mirroring OMP's non-XDG defaults with `HOME = <store>/home` and
 * `PI_CONFIG_DIR = .omp`:
 *
 *   <dataRoot>/omp-marketplace/home/.omp/marketplaces.json
 *   <dataRoot>/omp-marketplace/home/.omp/plugins/installed_plugins.json
 *   <dataRoot>/omp-marketplace/home/.omp/plugins/cache/{marketplaces,plugins}/
 *
 * The CLI's working directory is `home/work`: OMP looks for a project anchor
 * by walking up from its cwd and stops at HOME, so a cwd outside HOME could
 * walk into the operator's real `~/.omp` and treat their own registry as a
 * project-scoped one.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import type { OmpMarketSourceType } from "@pi-desktop/shared";

import { isPathInside, prepareOmpRuntimeHome } from "../isolation.js";

/** Directory under the desktop data root that holds the store. */
export const OMP_MARKETPLACE_DIR = "omp-marketplace";

/** The config root name the CLI runs with; fixed so recorded paths stay valid. */
export const OMP_MARKETPLACE_CONFIG_DIR = ".omp";

/** Largest registry or catalog file this reader accepts. */
export const MAX_MARKETPLACE_FILE_BYTES = 4 * 1024 * 1024;

const NAME_SEGMENT = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const MAX_NAME_SEGMENT = 64;
const MAX_PLUGIN_ID = 128;

export type OmpMarketplaceStore = {
  root: string;
  home: string;
  configRoot: string;
  agentDir: string;
  launchDir: string;
  pluginsDir: string;
  marketplacesRegistry: string;
  installedRegistry: string;
  marketplacesCacheDir: string;
  pluginsCacheDir: string;
  nativesDir: string;
};

export function ompMarketplaceStore(dataRoot: string): OmpMarketplaceStore {
  const root = join(dataRoot, OMP_MARKETPLACE_DIR);
  const home = join(root, "home");
  const configRoot = join(home, OMP_MARKETPLACE_CONFIG_DIR);
  const pluginsDir = join(configRoot, "plugins");
  return {
    root,
    home,
    configRoot,
    agentDir: join(configRoot, "agent"),
    launchDir: join(home, "work"),
    pluginsDir,
    marketplacesRegistry: join(configRoot, "marketplaces.json"),
    installedRegistry: join(pluginsDir, "installed_plugins.json"),
    marketplacesCacheDir: join(pluginsDir, "cache", "marketplaces"),
    pluginsCacheDir: join(pluginsDir, "cache", "plugins"),
    nativesDir: join(configRoot, "natives"),
  };
}

/** Create the store's directories; existing content is left untouched. */
export function ensureOmpMarketplaceStore(store: OmpMarketplaceStore): void {
  prepareOmpRuntimeHome(store.home);
  mkdirSync(store.agentDir, { recursive: true });
  mkdirSync(store.launchDir, { recursive: true });
}

/** OMP's name rule for a marketplace or plugin name segment. */
export function isOmpNameSegment(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_NAME_SEGMENT && NAME_SEGMENT.test(value);
}

/** Parse `name@marketplace`; null for anything OMP itself would refuse. */
export function parseOmpPluginId(id: unknown): { name: string; marketplace: string } | null {
  if (typeof id !== "string" || id.length > MAX_PLUGIN_ID) return null;
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  const name = id.slice(0, at);
  const marketplace = id.slice(at + 1);
  return isOmpNameSegment(name) && isOmpNameSegment(marketplace) ? { name, marketplace } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read one JSON file the store owns. A missing file is `null`; a file that is
 * a symlink, oversized or not JSON is an error the caller reports.
 */
export function readStoreJson(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  if (stat.size > MAX_MARKETPLACE_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_MARKETPLACE_FILE_BYTES} bytes`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

// ── Marketplaces ─────────────────────────────────────────────────────────────

const SOURCE_TYPES: readonly OmpMarketSourceType[] = ["github", "git", "url", "local"];

export type StoreMarketplace = {
  name: string;
  sourceType: OmpMarketSourceType;
  sourceUri: string;
  addedAt: string;
  updatedAt: string;
};

/** Configured marketplaces; malformed entries are dropped with a diagnostic. */
export function readStoreMarketplaces(store: OmpMarketplaceStore): {
  marketplaces: StoreMarketplace[];
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const raw = readStoreJson(store.marketplacesRegistry);
  if (raw === null) return { marketplaces: [], diagnostics };
  if (!isRecord(raw) || !Array.isArray(raw.marketplaces)) {
    return { marketplaces: [], diagnostics: ["marketplaces.json has no marketplaces list"] };
  }
  const marketplaces: StoreMarketplace[] = [];
  for (const entry of raw.marketplaces) {
    if (!isRecord(entry) || !isOmpNameSegment(entry.name)) {
      diagnostics.push("ignored a marketplace entry without a valid name");
      continue;
    }
    const sourceType = SOURCE_TYPES.find((type) => type === entry.sourceType);
    const sourceUri = str(entry.sourceUri);
    if (!sourceType || !sourceUri) {
      diagnostics.push(`ignored marketplace ${entry.name}: missing source`);
      continue;
    }
    marketplaces.push({
      name: entry.name,
      sourceType,
      sourceUri,
      addedAt: str(entry.addedAt) ?? "",
      updatedAt: str(entry.updatedAt) ?? str(entry.addedAt) ?? "",
    });
  }
  return { marketplaces, diagnostics };
}

/** Where OMP writes the normalized catalog for one marketplace. */
export function storeCatalogPath(store: OmpMarketplaceStore, marketplace: string): string {
  return join(store.marketplacesCacheDir, marketplace, "marketplace.json");
}

export type StoreCatalogPlugin = {
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  category?: string;
  keywords: string[];
  /** `relative` for a `./path` string, otherwise the object source's kind. */
  sourceKind: "relative" | "github" | "url" | "git-subdir" | "npm" | "unknown";
  /** Executable component metadata keys the entry declares. */
  declares: { hooks: boolean; mcp: boolean; lsp: boolean; dap: boolean };
};

export type StoreCatalog = {
  name: string;
  ownerName?: string;
  description?: string;
  plugins: StoreCatalogPlugin[];
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function declared(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function sourceKind(source: unknown): StoreCatalogPlugin["sourceKind"] {
  if (typeof source === "string") return source.startsWith("./") ? "relative" : "unknown";
  if (!isRecord(source)) return "unknown";
  switch (source.source) {
    case "github":
    case "url":
    case "git-subdir":
    case "npm":
      return source.source;
    default:
      return "unknown";
  }
}

/**
 * Read the catalog copy OMP wrote for `marketplace`. The registry's own
 * `catalogPath` is ignored: only the store's fixed location is read, so a
 * rewritten registry cannot point this reader at another file.
 */
export function readStoreCatalog(store: OmpMarketplaceStore, marketplace: string): StoreCatalog {
  const raw = readStoreJson(storeCatalogPath(store, marketplace));
  if (raw === null) throw new Error(`catalog for ${marketplace} is missing; update the source`);
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) throw new Error(`catalog for ${marketplace} has no plugin list`);
  const plugins: StoreCatalogPlugin[] = [];
  const seen = new Set<string>();
  for (const entry of raw.plugins) {
    if (!isRecord(entry) || !isOmpNameSegment(entry.name) || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const author = isRecord(entry.author) ? str(entry.author.name) : str(entry.author);
    plugins.push({
      name: entry.name,
      ...(str(entry.description) ? { description: str(entry.description) } : {}),
      ...(str(entry.version) ? { version: str(entry.version) } : {}),
      ...(author ? { authorName: author } : {}),
      ...(str(entry.homepage) ? { homepage: str(entry.homepage) } : {}),
      ...(str(entry.repository) ? { repository: str(entry.repository) } : {}),
      ...(str(entry.license) ? { license: str(entry.license) } : {}),
      ...(str(entry.category) ? { category: str(entry.category) } : {}),
      keywords: [...stringList(entry.keywords), ...stringList(entry.tags)],
      sourceKind: sourceKind(entry.source),
      declares: {
        hooks: declared(entry.hooks),
        mcp: declared(entry.mcpServers),
        lsp: declared(entry.lspServers),
        dap: declared(entry.dapAdapters),
      },
    });
  }
  const owner = isRecord(raw.owner) ? str(raw.owner.name) : undefined;
  const description = isRecord(raw.metadata) ? str(raw.metadata.description) : undefined;
  return {
    name: str(raw.name) ?? marketplace,
    ...(owner ? { ownerName: owner } : {}),
    ...(description ? { description } : {}),
    plugins,
  };
}

// ── Installed plugins ────────────────────────────────────────────────────────

export type StoreInstalledPlugin = {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
  /** Absolute cache directory, or null when the recorded path is unusable. */
  installPath: string | null;
};

/**
 * True when `installPath` is an existing directory inside the store's plugin
 * cache, after resolving symlinks on both sides.
 */
export function isStoreInstallPath(store: OmpMarketplaceStore, installPath: string): boolean {
  try {
    const cache = realpathSync(store.pluginsCacheDir);
    const target = realpathSync(installPath);
    return target !== cache && isPathInside(target, cache) && lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * User-scoped marketplace installs. The desktop never installs project-scoped
 * plugins, so those entries are not part of this view.
 */
export function readStoreInstalled(store: OmpMarketplaceStore): {
  installed: StoreInstalledPlugin[];
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const raw = readStoreJson(store.installedRegistry);
  if (raw === null) return { installed: [], diagnostics };
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return { installed: [], diagnostics: ["installed_plugins.json has no plugins map"] };
  }
  const installed: StoreInstalledPlugin[] = [];
  for (const [id, entries] of Object.entries(raw.plugins)) {
    const parsed = parseOmpPluginId(id);
    if (!parsed || !Array.isArray(entries)) {
      diagnostics.push(`ignored installed entry ${JSON.stringify(id).slice(0, 140)}`);
      continue;
    }
    const entry = entries.find((candidate) => isRecord(candidate) && candidate.scope === "user");
    if (!isRecord(entry)) continue;
    const recorded = str(entry.installPath);
    const usable = recorded !== undefined && isStoreInstallPath(store, recorded);
    if (!usable) diagnostics.push(`${id}: install path is missing or outside the plugin cache`);
    installed.push({
      id,
      ...parsed,
      version: str(entry.version) ?? "0.0.0",
      installedAt: str(entry.installedAt) ?? "",
      lastUpdated: str(entry.lastUpdated) ?? str(entry.installedAt) ?? "",
      enabled: entry.enabled !== false,
      installPath: usable ? recorded : null,
    });
  }
  installed.sort((a, b) => a.id.localeCompare(b.id));
  return { installed, diagnostics };
}
