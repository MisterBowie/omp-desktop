import { pinyin } from "pinyin-pro";
import type { PluginSummary } from "@pi-desktop/shared";

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function pinyinTokens(value: string): { full: string; initials: string } {
  return {
    full: normalizeSearchText(
      pinyin(value, { toneType: "none", type: "array" }).join(""),
    ),
    initials: normalizeSearchText(
      pinyin(value, {
        pattern: "first",
        toneType: "none",
        type: "array",
      }).join(""),
    ),
  };
}

export function isLaunchablePlugin(plugin: PluginSummary): boolean {
  return Boolean(plugin.enabled && plugin.status === "ready" && plugin.ui?.panel);
}

export function searchLaunchablePlugins(
  plugins: readonly PluginSummary[],
  query: string,
  recentIds?: readonly string[],
): PluginSummary[] {
  const normalizedQuery = normalizeSearchText(query);
  const recencyRank = new Map(recentIds?.map((id, index) => [id, index]) ?? []);
  return plugins
    .filter(isLaunchablePlugin)
    .map((plugin, index) => {
      const name = normalizeSearchText(plugin.name);
      const id = normalizeSearchText(plugin.id);
      const description = normalizeSearchText(plugin.description ?? "");
      const romanized = pinyinTokens(plugin.name);
      const score = !normalizedQuery
        ? 0
        : name === normalizedQuery || id === normalizedQuery
          ? 1
          : name.startsWith(normalizedQuery) || id.startsWith(normalizedQuery)
            ? 2
            : romanized.full.startsWith(normalizedQuery)
              ? 3
              : romanized.initials.startsWith(normalizedQuery)
                ? 4
                : name.includes(normalizedQuery) || id.includes(normalizedQuery)
                  ? 5
                  : romanized.full.includes(normalizedQuery) ||
                      romanized.initials.includes(normalizedQuery)
                    ? 6
                    : description.includes(normalizedQuery)
                      ? 7
                      : Number.POSITIVE_INFINITY;
      return {
        plugin,
        score,
        index,
        recentRank: recencyRank.get(plugin.id) ?? recencyRank.size,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.recentRank - right.recentRank ||
        left.plugin.name.localeCompare(right.plugin.name) ||
        left.index - right.index,
    )
    .map(({ plugin }) => plugin);
}
