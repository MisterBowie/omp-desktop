import type {
  PluginCapability,
  PluginFsPolicy,
  PluginSummary,
} from "@pi-desktop/shared";

export type TabId = "installed" | "market";

/**
 * Always-visible sections of the installed index. Broken plugins come first, so
 * the state that needs a decision is never buried under the plugins that are
 * simply working.
 */
export type GroupId = "attention" | "active" | "disabled";

export const GROUP_ORDER: GroupId[] = ["attention", "active", "disabled"];

export const GROUP_LABEL_KEYS: Record<GroupId, string> = {
  attention: "plugins.groupAttention",
  active: "plugins.groupActive",
  disabled: "plugins.groupDisabled",
};

/** Mirrors TEMPLATE_NAMES in @pi-desktop/plugin-devkit; main rejects anything else. */
export const TEMPLATE_IDS = [
  "panel-basic",
  "agent-tool-basic",
  "skill-pack",
  "full-demo",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type RiskTier = "high" | "medium" | "low";

/** Mirrors the risk column of docs/spec/07-plugins/13-plugin-permissions-matrix.md. */
export const PERMISSION_RISK: Record<string, RiskTier> = {
  "net.fetch": "high",
  "fs.write": "high",
  "fs.delete": "high",
  "fs.write.workspace": "high",
  "fs.delete.workspace": "high",
  "agent.prompt.inject": "high",
  "agent.tool.register": "high",
  "agent.complete": "high",
  "agent.extension": "high",
  "desktop.control": "high",
  "session.read": "high",
  "browser.cdp": "high",
  // Reading is a tier below writing because what makes a read dangerous is
  // where the data can go, and outbound requests are declared separately.
  "fs.read": "medium",
  "fs.read.workspace": "medium",
  "models.list": "medium",
  "clipboard.read": "medium",
  "clipboard.write": "medium",
  "shell.openExternal": "medium",
  "mcp.server.local": "high",
  "mcp.server.remote": "high",
  "background.service": "high",
  // Per-turn counters and session titles only, per the usage.read matrix row.
  "usage.read": "medium",
  // Two capabilities that reach outside PI-Desktop's own window or read its
  // live audio stream sit at the top tier with the other outbound paths.
  "net.websocket": "high",
  "audio.capture.background": "high",
  "speech.adapter.register": "high",
  "audio.playback.background": "medium",
  "keyboard.globalShortcut": "medium",
  "bus.publish": "medium",
  "bus.subscribe": "medium",
  "ui.panel": "low",
  "ui.microphone": "medium",
  "ui.theme": "low",
  notify: "low",
};

/** Display order for capability badges: what it adds before what it runs. */
export const CAPABILITY_ORDER: PluginCapability[] = [
  "panel",
  "views",
  "commands",
  "tools",
  "agentExtension",
  "skills",
  "themes",
  "mcp",
  "services",
  "bus",
];

/** File modes in escalating order, so a row reads read → write → delete. */
export const FS_MODES = ["read", "write", "delete"] as const;

/** Permission names that predate scopes; the host cuts these back on load. */
export const LEGACY_FS_PERMISSIONS = [
  "fs.read.workspace",
  "fs.write.workspace",
  "fs.delete.workspace",
];

export const RISK_TIERS: RiskTier[] = ["high", "medium", "low"];

export const RISK_WEIGHT: Record<RiskTier, number> = { high: 0, medium: 1, low: 2 };

export const RISK_LABEL_KEYS: Record<RiskTier, string> = {
  high: "plugins.riskHigh",
  medium: "plugins.riskMedium",
  low: "plugins.riskLow",
};

/** Chips rendered in row details or cards before collapsing into a "+N" counter. */
export const INLINE_PERMISSION_LIMIT = 3;

/**
 * An unrecognized permission counts as high risk: a capability the matrix does
 * not classify must never read as safer than one it does.
 */
export function permissionRisk(key: string): RiskTier {
  return PERMISSION_RISK[key] ?? "high";
}

export function permissionLabel(key: string, t: (k: string, o?: any) => string): string {
  return t(`plugins.permissions.${key}`, { defaultValue: key });
}

/** Deduplicates permissions and orders them by descending risk, then by label. */
export function orderPermissions(permissions: readonly string[] | undefined): string[] {
  return [...new Set(permissions ?? [])].sort(
    (a, b) =>
      RISK_WEIGHT[permissionRisk(a)] - RISK_WEIGHT[permissionRisk(b)] ||
      a.localeCompare(b),
  );
}

export function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(parsed);
  } catch {
    return parsed.toLocaleDateString();
  }
}

/** Single-glyph stand-in for a marketplace icon we deliberately do not fetch. */
export function monogram(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

export function groupOf(plugin: PluginSummary): GroupId {
  if (plugin.status === "error" || plugin.status === "load_error") return "attention";
  return plugin.enabled ? "active" : "disabled";
}
