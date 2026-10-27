/**
 * Declarative plugin views: what an OMP session may load from an installed
 * marketplace plugin (ADR 0333).
 *
 * OMP discovers a marketplace plugin through the `installed_plugins.json` of
 * the run's config root and then reads everything the plugin directory holds:
 * skills, commands, agents and rules, but also MCP servers, hook scripts,
 * custom tool modules (imported at session start even with
 * `--trusted-extension`), LSP and DAP servers. OMP Desktop only opens the
 * declarative part, and it does so structurally rather than by settings: each
 * run gets its own `installed_plugins.json` whose entries point at a view
 * directory built here, and the view contains nothing but
 *
 *   - links to the plugin's `skills/`, `commands/`, `agents/` and `rules/`,
 *   - links or copies of skill/command paths its manifest declares inside the
 *     plugin root (never under a withheld top-level name), and
 *   - sanitized manifests that keep only identity fields and those paths.
 *
 * Whatever is not linked does not exist for the runtime, so `.mcp.json`,
 * `hooks/`, `tools/`, `.lsp.json`, `.dap.*`, `package.json` extension entries
 * and manifest-inline servers cannot load. The view lives in the run root and
 * is removed with it.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OmpMarketComponentKind, OmpMarketInstalledComponents, OmpMarketLoadedComponent } from "@pi-desktop/shared";

import { isPathInside } from "../isolation.js";
import { readStoreInstalled, type OmpMarketplaceStore } from "./store.js";

/** Top-level directories a view may link, in OMP's conventional layout. */
export const VIEW_CONVENTIONAL_DIRS: readonly OmpMarketLoadedComponent[] = ["skills", "commands", "agents", "rules"];

/** Manifest locations OMP reads; mirrored (sanitized) so the model dialect stays the same. */
const MANIFEST_DIRS = [".claude-plugin", ".omp-plugin"] as const;

/** Root catalogs OMP consults for a plugin whose source is its marketplace root. */
const ROOT_CATALOGS = ["marketplace.json", join(".omp-plugin", "marketplace.json"), join(".claude-plugin", "marketplace.json")];

const MANIFEST_IDENTITY_KEYS = ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"];
const MANIFEST_PATH_KEYS = ["skills", "commands", "slash-commands"] as const;

/** Top-level names a declared path may never reach into. */
const WITHHELD_TOP_LEVEL = new Set(["hooks", "tools", "node_modules", "extensions"]);

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_COPIED_FILE_BYTES = 1024 * 1024;

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

/** Real path of `target` when it exists strictly inside `root` (both resolved). */
function containedRealpath(root: string, target: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    return realTarget !== realRoot && isPathInside(realTarget, realRoot) ? realTarget : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a manifest-declared path to a safe relative path inside the
 * plugin root, or null when it escapes, names the root itself, or reaches into
 * a dot-entry or a withheld top-level directory.
 */
export function safeDeclaredPath(root: string, declared: string): string | null {
  if (isAbsolute(declared)) return null;
  const resolved = resolve(root, declared);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  const top = segments[0] ?? "";
  if (top.startsWith(".") || WITHHELD_TOP_LEVEL.has(top)) return null;
  if (segments.some((segment) => segment === "" || segment === "..")) return null;
  return rel;
}

function sanitizeManifest(root: string, raw: unknown): { manifest: Record<string, unknown>; paths: string[] } {
  if (!isRecord(raw)) return { manifest: {}, paths: [] };
  const manifest: Record<string, unknown> = {};
  for (const key of MANIFEST_IDENTITY_KEYS) {
    const value = raw[key];
    if (typeof value === "string") manifest[key] = value;
    else if (key === "keywords" && Array.isArray(value)) manifest[key] = value.filter((item) => typeof item === "string");
    else if (key === "author" && isRecord(value)) {
      manifest[key] = Object.fromEntries(
        Object.entries(value).filter(([field, item]) => ["name", "email", "url"].includes(field) && typeof item === "string"),
      );
    }
  }
  const paths: string[] = [];
  for (const key of MANIFEST_PATH_KEYS) {
    const safe = pathList(raw[key])
      .map((declared) => safeDeclaredPath(root, declared))
      .filter((rel): rel is string => rel !== null);
    if (safe.length === 0) continue;
    manifest[key] = safe.map((rel) => `./${rel.split(sep).join("/")}`);
    paths.push(...safe);
  }
  return { manifest, paths };
}

function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** Whether `rel` is already provided by a projected ancestor (or itself). */
function covered(projected: Set<string>, rel: string): boolean {
  const segments = rel.split(sep);
  for (let length = 1; length <= segments.length; length += 1) {
    if (projected.has(segments.slice(0, length).join(sep))) return true;
  }
  return false;
}

/**
 * Build the declarative view of one installed plugin at `viewDir`.
 *
 * Throws only for a failure to create the view itself; individual components
 * that are absent or unsafe are skipped.
 */
export function buildDeclarativeView(installPath: string, viewDir: string, pluginName: string): void {
  mkdirSync(viewDir, { recursive: true });
  const declared: string[] = [];

  for (const dir of MANIFEST_DIRS) {
    const raw = readSmallJson(join(installPath, dir, "plugin.json"));
    if (raw === undefined) continue;
    // OMP keys the agent model dialect on the manifest's presence, so an
    // unreadable manifest is mirrored as an empty one rather than dropped.
    const { manifest, paths } = sanitizeManifest(installPath, raw);
    mkdirSync(join(viewDir, dir), { recursive: true });
    writeFileSync(join(viewDir, dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    declared.push(...paths);
  }

  for (const catalog of ROOT_CATALOGS) {
    const raw = readSmallJson(join(installPath, catalog));
    if (!isRecord(raw) || !Array.isArray(raw.plugins)) continue;
    const entry = raw.plugins.find((item) => isRecord(item) && item.name === pluginName && item.source === "./");
    if (!isRecord(entry)) continue;
    const skills = pathList(entry.skills)
      .map((path) => safeDeclaredPath(installPath, path))
      .filter((rel): rel is string => rel !== null);
    const sanitized = { plugins: [{ name: pluginName, source: "./", ...(skills.length ? { skills: skills.map((rel) => `./${rel.split(sep).join("/")}`) } : {}) }] };
    mkdirSync(dirname(join(viewDir, catalog)), { recursive: true });
    writeFileSync(join(viewDir, catalog), `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
    declared.push(...skills);
    break;
  }

  const projected = new Set<string>();
  for (const dir of VIEW_CONVENTIONAL_DIRS) {
    const target = join(installPath, dir);
    const real = containedRealpath(installPath, target);
    if (!real || !statSync(real).isDirectory()) continue;
    linkDirectory(target, join(viewDir, dir));
    projected.add(dir);
  }

  const unique = [...new Set(declared)].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b));
  for (const rel of unique) {
    if (covered(projected, rel)) continue;
    const target = join(installPath, rel);
    const real = containedRealpath(installPath, target);
    if (!real) continue;
    const destination = join(viewDir, rel);
    mkdirSync(dirname(destination), { recursive: true });
    const stat = statSync(real);
    if (stat.isDirectory()) {
      linkDirectory(target, destination);
    } else if (stat.isFile() && stat.size <= MAX_COPIED_FILE_BYTES) {
      // File links need elevated rights on Windows; a declared command file is small.
      copyFileSync(real, destination);
    } else {
      continue;
    }
    projected.add(rel);
  }
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

/** What a session loads from an installed plugin, and what stays withheld. */
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

  const withheld: OmpMarketComponentKind[] = [];
  if (has(".mcp.json") || has("mcp.json") || manifestDeclares(installPath, "mcpServers")) withheld.push("mcp");
  if (isDir("hooks") || has("hooks.json") || manifestDeclares(installPath, "hooks")) withheld.push("hooks");
  if (isDir("tools")) withheld.push("tools");
  if (has(".lsp.json") || manifestDeclares(installPath, "lspServers")) withheld.push("lsp");
  if (has(".dap.json") || has(".dap.yaml") || has(".dap.yml") || manifestDeclares(installPath, "dapAdapters")) withheld.push("dap");
  if (packageDeclaresExtensions(installPath)) withheld.push("extensions");
  return { loaded, withheld };
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

/** Directory inside a run root that holds that run's plugin views. */
export const MARKETPLACE_VIEW_DIR = "marketplace-plugins";

/**
 * Give one run its marketplace plugins: a view per plugin under `viewRoot` and
 * a registry under `<configRoot>/plugins` that names only those views. With no
 * plugins nothing is written, so the run is identical to one without a store.
 * A plugin whose view cannot be built is skipped and reported, never fatal.
 */
export function projectMarketplacePlugins(options: {
  snapshot: MarketplaceRunSnapshot;
  configRoot: string;
  viewRoot: string;
}): { projected: string[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const registry: Record<string, unknown[]> = {};
  options.snapshot.plugins.forEach((plugin, index) => {
    const viewDir = join(options.viewRoot, `${index}-${plugin.name}`);
    try {
      buildDeclarativeView(plugin.installPath, viewDir, plugin.name);
      registry[plugin.id] = [
        {
          scope: "user",
          installPath: viewDir,
          version: plugin.version,
          installedAt: plugin.installedAt,
          lastUpdated: plugin.lastUpdated,
        },
      ];
    } catch (error) {
      diagnostics.push(`${plugin.id}: view not built: ${(error as Error).message}`);
    }
  });
  const projected = Object.keys(registry);
  if (projected.length === 0) return { projected, diagnostics };
  const pluginsDir = join(options.configRoot, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    `${JSON.stringify({ version: 2, plugins: registry }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { projected, diagnostics };
}
