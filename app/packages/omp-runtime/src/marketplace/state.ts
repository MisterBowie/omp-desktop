/**
 * The marketplace state the desktop renders, assembled from the store's
 * registries (ADR 0333). Pure reads: nothing here runs OMP or touches the
 * network.
 */
import type {
  OmpMarketComponentKind,
  OmpMarketInstalledPlugin,
  OmpMarketPlugin,
  OmpMarketSource,
  OmpMarketState,
} from "@pi-desktop/shared";

import {
  readStoreCatalog,
  readStoreInstalled,
  readStoreMarketplaces,
  type OmpMarketplaceStore,
  type StoreCatalog,
  type StoreCatalogPlugin,
} from "./store.js";
import { inspectPluginComponents } from "./view.js";

const MAX_TEXT = 2_000;
const MAX_SHORT = 200;

function bounded(value: string | undefined, limit = MAX_SHORT): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** Only absolute http(s) URLs are offered as links. */
function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * OMP's upgrade rule (`marketplace.md`): only a catalog entry that declares a
 * version can be newer; semver must compare greater, any other unequal string
 * counts as changed.
 */
export function isNewerCatalogVersion(installed: string, catalog: string | undefined): boolean {
  if (!catalog || catalog === installed) return false;
  const a = SEMVER.exec(installed);
  const b = SEMVER.exec(catalog);
  if (!a || !b) return true;
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(b[index]) - Number(a[index]);
    if (diff !== 0) return diff > 0;
  }
  if (a[4] && !b[4]) return true;
  if (!a[4] || !b[4]) return false;
  return b[4].localeCompare(a[4], "en", { numeric: true }) > 0;
}

function pluginFromCatalog(marketplace: string, sourceType: string, entry: StoreCatalogPlugin): OmpMarketPlugin {
  const unavailableReason =
    entry.sourceKind === "npm"
      ? "npm-source"
      : entry.sourceKind === "unknown"
        ? "unknown-source"
        : entry.sourceKind === "relative" && sourceType === "url"
          ? "relative-source-in-url-catalog"
          : undefined;
  const declaresWithheld: OmpMarketComponentKind[] = [];
  if (entry.declares.mcp) declaresWithheld.push("mcp");
  if (entry.declares.hooks) declaresWithheld.push("hooks");
  if (entry.declares.lsp) declaresWithheld.push("lsp");
  if (entry.declares.dap) declaresWithheld.push("dap");
  const description = bounded(entry.description, MAX_TEXT);
  const version = bounded(entry.version, 64);
  const authorName = bounded(entry.authorName);
  const homepage = webUrl(entry.homepage);
  const repository = webUrl(entry.repository);
  const license = bounded(entry.license, 64);
  const category = bounded(entry.category, 64);
  return {
    id: `${entry.name}@${marketplace}`,
    name: entry.name,
    marketplace,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(authorName ? { authorName } : {}),
    ...(homepage ? { homepage } : {}),
    ...(repository ? { repository } : {}),
    ...(license ? { license } : {}),
    ...(category ? { category } : {}),
    keywords: entry.keywords.slice(0, 20).map((word) => word.slice(0, 64)),
    installable: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
    declaresWithheld,
  };
}

export type OmpMarketStateOptions = {
  available: boolean;
  unavailableReason?: string;
  onDiagnostic?: (message: string) => void;
};

/** Read the whole marketplace state; a damaged file degrades, never throws. */
export function readOmpMarketState(store: OmpMarketplaceStore, options: OmpMarketStateOptions): OmpMarketState {
  const report = (message: string) => options.onDiagnostic?.(message);
  let marketplaces: ReturnType<typeof readStoreMarketplaces>["marketplaces"] = [];
  try {
    const read = readStoreMarketplaces(store);
    marketplaces = read.marketplaces;
    read.diagnostics.forEach(report);
  } catch (error) {
    report(`marketplaces registry unreadable: ${(error as Error).message}`);
  }

  const sources: OmpMarketSource[] = [];
  const plugins: OmpMarketPlugin[] = [];
  const catalogVersions = new Map<string, string | undefined>();
  for (const marketplace of marketplaces) {
    let catalog: StoreCatalog | null = null;
    let error: string | undefined;
    try {
      catalog = readStoreCatalog(store, marketplace.name);
    } catch (cause) {
      error = bounded((cause as Error).message, 300);
    }
    const description = bounded(catalog?.description, MAX_TEXT);
    const ownerName = bounded(catalog?.ownerName);
    sources.push({
      name: marketplace.name,
      sourceType: marketplace.sourceType,
      sourceUri: marketplace.sourceUri,
      updatedAt: marketplace.updatedAt,
      ...(description ? { description } : {}),
      ...(ownerName ? { ownerName } : {}),
      pluginCount: catalog?.plugins.length ?? 0,
      ...(error ? { error } : {}),
    });
    for (const entry of catalog?.plugins ?? []) {
      const plugin = pluginFromCatalog(marketplace.name, marketplace.sourceType, entry);
      plugins.push(plugin);
      catalogVersions.set(plugin.id, plugin.version);
    }
  }

  const installed: OmpMarketInstalledPlugin[] = [];
  try {
    const read = readStoreInstalled(store);
    read.diagnostics.forEach(report);
    for (const plugin of read.installed) {
      const catalogVersion = catalogVersions.get(plugin.id);
      installed.push({
        id: plugin.id,
        name: plugin.name,
        marketplace: plugin.marketplace,
        version: plugin.version,
        installedAt: plugin.installedAt,
        lastUpdated: plugin.lastUpdated,
        enabled: plugin.enabled,
        components: plugin.installPath ? inspectPluginComponents(plugin.installPath) : { loaded: {}, withheld: [] },
        ...(catalogVersion && isNewerCatalogVersion(plugin.version, catalogVersion) ? { updateVersion: catalogVersion } : {}),
        ...(plugin.installPath ? {} : { broken: true }),
      });
    }
  } catch (error) {
    report(`installed plugins unreadable: ${(error as Error).message}`);
  }

  return {
    available: options.available,
    ...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {}),
    sources,
    plugins,
    installed,
  };
}
