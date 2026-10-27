import type {
  OmpMarketComponentKind,
  OmpMarketInstalledPlugin,
  OmpMarketPlugin,
  OmpMarketState,
} from "@pi-desktop/shared";
import { matchesQuery } from "./model";

/** One card: a catalog entry, an install, or both. */
export type OmpMarketItem = {
  id: string;
  name: string;
  marketplace: string;
  plugin?: OmpMarketPlugin;
  installed?: OmpMarketInstalledPlugin;
};

export type OmpMarketFilter = {
  query: string;
  installedOnly: boolean;
  marketplace: string;
  category: string;
};

/**
 * Catalog entries first, in catalog order, then installs whose catalog entry
 * is gone (its source was removed or no longer lists it), so an install can
 * always be found and removed.
 */
export function ompMarketItems(state: OmpMarketState | null): OmpMarketItem[] {
  if (!state) return [];
  const installed = new Map(state.installed.map((plugin) => [plugin.id, plugin]));
  const items: OmpMarketItem[] = state.plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    marketplace: plugin.marketplace,
    plugin,
    ...(installed.has(plugin.id) ? { installed: installed.get(plugin.id) } : {}),
  }));
  const listed = new Set(items.map((item) => item.id));
  for (const plugin of state.installed) {
    if (!listed.has(plugin.id)) items.push({ id: plugin.id, name: plugin.name, marketplace: plugin.marketplace, installed: plugin });
  }
  return items;
}

export function filterOmpMarketItems(items: readonly OmpMarketItem[], filter: OmpMarketFilter): OmpMarketItem[] {
  return items.filter((item) => {
    if (filter.installedOnly && !item.installed) return false;
    if (filter.marketplace && item.marketplace !== filter.marketplace) return false;
    if (filter.category && item.plugin?.category !== filter.category) return false;
    return matchesQuery(
      filter.query,
      item.name,
      item.id,
      item.plugin?.description,
      item.plugin?.authorName,
      item.plugin?.category,
      ...(item.plugin?.keywords ?? []),
    );
  });
}

export function ompMarketCategories(items: readonly OmpMarketItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) if (item.plugin?.category) seen.add(item.plugin.category);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Withheld kinds to flag on a card: the install's real report wins over catalog metadata. */
export function ompWithheldKinds(item: OmpMarketItem): OmpMarketComponentKind[] {
  return item.installed ? item.installed.components.withheld : (item.plugin?.declaresWithheld ?? []);
}

export const OMP_COMPONENT_LABEL_KEYS: Record<OmpMarketComponentKind, string> = {
  skills: "plugins.ompMarket.component.skills",
  commands: "plugins.ompMarket.component.commands",
  agents: "plugins.ompMarket.component.agents",
  rules: "plugins.ompMarket.component.rules",
  mcp: "plugins.ompMarket.component.mcp",
  hooks: "plugins.ompMarket.component.hooks",
  tools: "plugins.ompMarket.component.tools",
  lsp: "plugins.ompMarket.component.lsp",
  dap: "plugins.ompMarket.component.dap",
  extensions: "plugins.ompMarket.component.extensions",
};

export const OMP_UNAVAILABLE_KEYS = {
  "npm-source": "plugins.ompMarket.unavailableNpm",
  "relative-source-in-url-catalog": "plugins.ompMarket.unavailableRelative",
  "unknown-source": "plugins.ompMarket.unavailableUnknown",
} as const;
