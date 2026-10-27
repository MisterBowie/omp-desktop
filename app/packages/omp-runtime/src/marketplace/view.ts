/**
 * Installed marketplace plugins as OMP sessions load them (ADR 0333).
 *
 * OMP discovers a marketplace plugin through the `installed_plugins.json` of
 * the run's config root and loads everything the plugin directory holds:
 * skills, commands, agents and rules, and also MCP servers, hook scripts,
 * custom tool modules, LSP and DAP servers. Each run gets its own registry
 * pointing at the store's install directories; the component report tells the
 * UI which parts run programs.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OmpMarketComponentKind, OmpMarketInstalledComponents } from "@pi-desktop/shared";

import { readStoreInstalled, type OmpMarketplaceStore } from "./store.js";

/** Manifest locations OMP reads. */
const MANIFEST_DIRS = [".claude-plugin", ".omp-plugin"] as const;

const MAX_MANIFEST_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse a small JSON file; `undefined` when absent, `null` when present but unreadable. */
function readSmallJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function pathList(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

// ── Component report ─────────────────────────────────────────────────────────

function countEntries(dir: string, accept: (name: string, path: string) => boolean): number {
  try {
    return readdirSync(dir).filter((name) => accept(name, join(dir, name))).length;
  } catch {
    return 0;
  }
}

function manifestDeclares(installPath: string, key: string): boolean {
  for (const dir of MANIFEST_DIRS) {
    const raw = readSmallJson(join(installPath, dir, "plugin.json"));
    if (!isRecord(raw)) continue;
    const value = raw[key];
    if (typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : isRecord(value) && Object.keys(value).length > 0) {
      return true;
    }
  }
  return false;
}

function packageDeclaresExtensions(installPath: string): boolean {
  const raw = readSmallJson(join(installPath, "package.json"));
  if (!isRecord(raw)) return false;
  return [raw.omp, raw.pi].some(
    (manifest) => isRecord(manifest) && ["extensions", "tools", "hooks"].some((key) => pathList(manifest[key]).length > 0),
  );
}

/** What a session loads from an installed plugin, and which parts run programs. */
export function inspectPluginComponents(installPath: string): OmpMarketInstalledComponents {
  const has = (name: string) => existsSync(join(installPath, name));
  const isDir = (name: string) => {
    try {
      return lstatSync(join(installPath, name)).isDirectory();
    } catch {
      return false;
    }
  };
  const loaded: OmpMarketInstalledComponents["loaded"] = {};
  const skills = countEntries(join(installPath, "skills"), (_name, path) => existsSync(join(path, "SKILL.md")));
  const commands = countEntries(join(installPath, "commands"), (name) => name.endsWith(".md"));
  const agents = countEntries(join(installPath, "agents"), (name) => name.endsWith(".md"));
  const rules = countEntries(join(installPath, "rules"), (name) => name.endsWith(".md") || name.endsWith(".mdc"));
  if (skills) loaded.skills = skills;
  if (commands) loaded.commands = commands;
  if (agents) loaded.agents = agents;
  if (rules) loaded.rules = rules;

  const executable: OmpMarketComponentKind[] = [];
  if (has(".mcp.json") || has("mcp.json") || manifestDeclares(installPath, "mcpServers")) executable.push("mcp");
  if (isDir("hooks") || has("hooks.json") || manifestDeclares(installPath, "hooks")) executable.push("hooks");
  if (isDir("tools")) executable.push("tools");
  if (has(".lsp.json") || manifestDeclares(installPath, "lspServers")) executable.push("lsp");
  if (has(".dap.json") || has(".dap.yaml") || has(".dap.yml") || manifestDeclares(installPath, "dapAdapters")) executable.push("dap");
  if (packageDeclaresExtensions(installPath)) executable.push("extensions");
  return { loaded, executable };
}

// ── Run projection ───────────────────────────────────────────────────────────

export type MarketplaceRunPlugin = {
  id: string;
  name: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
};

export type MarketplaceRunSnapshot = {
  plugins: MarketplaceRunPlugin[];
  /** Changes whenever a session would load a different plugin set. */
  fingerprint: string;
  diagnostics: string[];
};

/** Enabled, intact user installs a new run should load. Never throws. */
export function marketplaceRunSnapshot(store: OmpMarketplaceStore): MarketplaceRunSnapshot {
  let read: ReturnType<typeof readStoreInstalled>;
  try {
    read = readStoreInstalled(store);
  } catch (error) {
    read = { installed: [], diagnostics: [`installed plugins unreadable: ${(error as Error).message}`] };
  }
  const plugins = read.installed
    .filter((plugin) => plugin.enabled && plugin.installPath !== null)
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      installPath: plugin.installPath as string,
      version: plugin.version,
      installedAt: plugin.installedAt,
      lastUpdated: plugin.lastUpdated,
    }));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(plugins.map((plugin) => [plugin.id, plugin.version, plugin.lastUpdated, plugin.installPath])))
    .digest("hex");
  return { plugins, fingerprint, diagnostics: read.diagnostics };
}

/**
 * Give one run its marketplace plugins: a registry under `<configRoot>/plugins`
 * that names each plugin's install directory in the store. With no plugins
 * nothing is written, so the run is identical to one without a store.
 */
export function projectMarketplacePlugins(options: {
  snapshot: MarketplaceRunSnapshot;
  configRoot: string;
}): { projected: string[] } {
  const registry: Record<string, unknown[]> = {};
  for (const plugin of options.snapshot.plugins) {
    registry[plugin.id] = [
      {
        scope: "user",
        installPath: plugin.installPath,
        version: plugin.version,
        installedAt: plugin.installedAt,
        lastUpdated: plugin.lastUpdated,
      },
    ];
  }
  const projected = Object.keys(registry);
  if (projected.length === 0) return { projected };
  const pluginsDir = join(options.configRoot, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    `${JSON.stringify({ version: 2, plugins: registry }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { projected };
}
