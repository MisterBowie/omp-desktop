/**
 * Activation scope: where an extension is allowed to run.
 *
 * Plugins, user MCP servers and user skills all answer the same two questions —
 * is it on at all, and does it apply to the project in front of me. Keeping one
 * shape for both answers means the three kinds share a single control in the UI,
 * a single filter in Electron main and a single serialized form in host-core.
 *
 * `enabled` is the master switch and lives next to the scope on each record, so
 * turning an extension off never loses the project list it was scoped to.
 */

export type ActivationMode = "global" | "projects";

export type ActivationScope = {
  mode: ActivationMode;
  /**
   * Absolute project paths this extension is limited to. Only read when
   * `mode === "projects"`; kept when the mode changes so toggling back restores
   * the previous selection.
   */
  projects: string[];
};

/** What the UI shows on the three-state control. */
export type ActivationState = "off" | "projects" | "global";

/** Default for anything installed before scopes existed, and for new installs. */
export const GLOBAL_SCOPE: ActivationScope = { mode: "global", projects: [] };

/** Anything carrying an activation decision: plugin, MCP server, user skill. */
export type Activatable = {
  enabled: boolean;
  scope?: ActivationScope;
};

/**
 * Storage spelling of a project path: forward slashes, no trailing separator.
 *
 * Mirrors `normalize_project_path` in host-core's `db.rs` so a path chosen in
 * the scope picker compares equal to the one recorded in the `projects` table.
 */
export function normalizeProjectPath(path: string | null | undefined): string {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return "";
  let normalized = trimmed.replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !normalized.endsWith(":/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Compare two project paths case-insensitively.
 *
 * macOS and Windows both hand us case-varying spellings of the same directory,
 * and a scope that silently stops matching because the user typed `Project`
 * instead of `project` reads as a bug. On a case-sensitive filesystem this can
 * only over-match sibling directories that differ by case alone, which does not
 * happen in practice.
 */
function samePath(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * True when `child` is `parent` or sits underneath it.
 *
 * Scoping a plugin to a monorepo root should cover sessions opened on a package
 * inside it — the alternative is asking the user to list every subdirectory.
 */
export function projectPathMatches(entry: string, projectPath: string): boolean {
  const scoped = normalizeProjectPath(entry);
  const target = normalizeProjectPath(projectPath);
  if (!scoped || !target) return false;
  if (samePath(scoped, target)) return true;
  const prefix = scoped.endsWith("/") ? scoped : `${scoped}/`;
  return target.length > prefix.length && samePath(target.slice(0, prefix.length), prefix);
}

/** Normalize a possibly-missing scope from storage into a usable one. */
export function resolveScope(scope: ActivationScope | undefined | null): ActivationScope {
  if (!scope || (scope.mode !== "global" && scope.mode !== "projects")) return GLOBAL_SCOPE;
  const projects = Array.isArray(scope.projects) ? scope.projects : [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of projects) {
    const path = normalizeProjectPath(typeof raw === "string" ? raw : "");
    if (!path) continue;
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(path);
  }
  return { mode: scope.mode, projects: cleaned };
}

/**
 * Whether the extension applies to a session opened on `projectPath`.
 *
 * A project-scoped extension is inactive in a session with no project at all:
 * "these projects" is a statement about projects, and a chat with no workspace
 * is not one of them.
 */
export function isActiveInProject(
  item: Activatable,
  projectPath: string | null | undefined,
): boolean {
  if (!item.enabled) return false;
  const scope = resolveScope(item.scope);
  if (scope.mode === "global") return true;
  const target = normalizeProjectPath(projectPath);
  if (!target) return false;
  return scope.projects.some((entry) => projectPathMatches(entry, target));
}

/** Collapse `enabled` + scope into the value the three-state control renders. */
export function activationState(item: Activatable): ActivationState {
  if (!item.enabled) return "off";
  return resolveScope(item.scope).mode === "projects" ? "projects" : "global";
}

/**
 * Add a project to a scope, switching it to project mode.
 *
 * Returns the same array identity semantics as `resolveScope`: always a fresh
 * object, so callers can compare before writing.
 */
export function withProject(
  scope: ActivationScope | undefined,
  projectPath: string,
): ActivationScope {
  const current = resolveScope(scope);
  const path = normalizeProjectPath(projectPath);
  if (!path) return { mode: "projects", projects: current.projects };
  const exists = current.projects.some((entry) => samePath(entry, path));
  return {
    mode: "projects",
    projects: exists ? current.projects : [...current.projects, path],
  };
}

/** Remove a project from a scope, leaving the mode alone. */
export function withoutProject(
  scope: ActivationScope | undefined,
  projectPath: string,
): ActivationScope {
  const current = resolveScope(scope);
  const path = normalizeProjectPath(projectPath);
  return {
    mode: current.mode,
    projects: current.projects.filter((entry) => !samePath(entry, path)),
  };
}
