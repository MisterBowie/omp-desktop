/**
 * PI's host-core path resolution, ported for the trusted gate (M5/T20-C).
 *
 * The gate runs inside the pinned runtime's process and cannot call host-core,
 * so the exact semantics that decide "is this tool path outside the session
 * workspace?" are reproduced here from `crates/host-core/src/workspace.rs`:
 *
 *   - `normalizeLexical` — `normalize_lexical`: resolve `.` / `..` without the
 *     filesystem; `..` at a root clamps (it never climbs above the root).
 *   - `pathIsWithin` — `path_is_within`: component-wise prefix comparison
 *     (case-insensitive on Windows).
 *   - `resolveWithExistingAncestor` — `resolve_with_existing_ancestor`:
 *     canonicalize the deepest existing ancestor (symlinks resolved) and
 *     re-append the not-yet-existing tail; a dangling symlink is read and
 *     resolution restarts from its target so containment sees the real
 *     destination.
 *   - `resolveInWorkspace` — `resolve_in_workspace`: lexical check first, then
 *     the symlink-aware check, both against the canonicalized root.
 *   - `resolveToolPath` — `resolve_tool_path`: workspace first, then the
 *     session scratch root (absolute inputs only, plus the literal
 *     scratch-prefix rewrite for a spelling that differs from the canonical
 *     one, e.g. macOS `/var` vs `/private/var`).
 *   - `requiresExternalPathPermission` — `requires_external_path_permission`:
 *     the permission decision for Read/Glob/Grep/Write/Edit paths outside
 *     workspace and scratch. The OMP path has no scratch root (the desktop's
 *     scratch directory is a Pi-sidecar concept), so the gate passes `null`;
 *     the helper keeps the parameter so the semantics stay identical to PI and
 *     testable with a scratch root.
 *
 * No caching: every call reads live filesystem metadata, exactly as the Rust
 * resolver does, so a directory created or a symlink swapped between two calls
 * is observed by the second one.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";

/** The error the PI resolver reports for a path outside the workspace root. */
export const PATH_OUTSIDE_WORKSPACE = "PATH_OUTSIDE_WORKSPACE";

/** Upper bound on dangling-symlink hops (`MAX_DANGLING_LINK_HOPS`). */
const MAX_DANGLING_LINK_HOPS = 32;

const WINDOWS = process.platform === "win32";

/** `simple_canonicalize`: realpath, with Windows' `\\?\` drive prefix stripped. */
export function simpleCanonicalize(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    if (WINDOWS && canonical.startsWith("\\\\?\\")) {
      const rest = canonical.slice(4);
      if (rest.length >= 3 && rest[1] === ":" && (rest[2] === "\\" || rest[2] === "/")) return rest;
    }
    return canonical;
  } catch {
    return null;
  }
}

/** `normalize_lexical`: purely lexical `.` / `..` resolution; roots clamp. */
export function normalizeLexical(input: string): string {
  const { root } = parse(input);
  const rest = input.slice(root.length);
  const out: string[] = [];
  for (const part of rest.split(sep)) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      // Like `PathBuf::pop()` on an empty buffer: a `..` that cannot climb is
      // dropped, so normalization never produces a leading `..` above a root.
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  if (root.length > 0) return out.length > 0 ? root + out.join(sep) : root;
  return out.length > 0 ? out.join(sep) : ".";
}

/** `path_is_within`: component-wise prefix comparison. */
export function pathIsWithin(root: string, candidate: string): boolean {
  const split = (path: string): string[] =>
    normalizeLexical(path)
      .split(WINDOWS ? /[\\/]+/ : sep)
      .filter((part) => part.length > 0);
  const rootParts = split(root);
  const candidateParts = split(candidate);
  if (rootParts.length > candidateParts.length) return false;
  return rootParts.every((part, index) =>
    WINDOWS ? part.toLowerCase() === candidateParts[index].toLowerCase() : part === candidateParts[index],
  );
}

export type PathResolution = { ok: true; path: string } | { ok: false; error: string };

/**
 * `resolve_with_existing_ancestor`: canonicalize the deepest existing ancestor
 * and re-append the tail. A dangling symlink at the deepest existing position
 * is followed (one hop at a time, bounded) instead of being treated as a
 * not-yet-created leaf, so a later write cannot escape through it.
 */
export function resolveWithExistingAncestor(normalized: string): PathResolution {
  let current = normalized;
  for (let hop = 0; hop < MAX_DANGLING_LINK_HOPS; hop += 1) {
    let existing = current;
    const tail: string[] = [];
    for (;;) {
      let stats: Stats | null = null;
      try {
        stats = lstatSync(existing);
      } catch {
        stats = null;
      }
      if (stats) break;
      const parent = dirname(existing);
      const name = basename(existing);
      if (parent === existing || name.length === 0) break;
      tail.push(name);
      existing = parent;
    }
    let dangling = false;
    try {
      dangling = lstatSync(existing).isSymbolicLink() && !existsSync(existing);
    } catch {
      dangling = false;
    }
    if (dangling) {
      let target: string;
      try {
        target = readlinkSync(existing);
      } catch (error) {
        return { ok: false, error: `path canonicalize failed: ${String(error)}` };
      }
      const base = dirname(existing);
      let next = isAbsolute(target) ? target : join(base, target);
      for (const part of tail.reverse()) next = join(next, part);
      current = normalizeLexical(next);
      continue;
    }
    const canonical = simpleCanonicalize(existing);
    if (canonical === null) return { ok: false, error: "path canonicalize failed" };
    let resolved = canonical;
    for (const part of tail.reverse()) resolved = join(resolved, part);
    return { ok: true, path: resolved };
  }
  return { ok: false, error: "path canonicalize failed: too many symlink hops" };
}

/** `resolve_in_workspace`: lexical then symlink-aware containment. */
export function resolveInWorkspace(workspaceRoot: string, input: string): PathResolution {
  const root = simpleCanonicalize(workspaceRoot);
  if (root === null) return { ok: false, error: "workspace canonicalize failed" };
  const candidate = isAbsolute(input) ? input : join(root, input);
  const normalized = normalizeLexical(candidate);
  if (!pathIsWithin(root, normalized)) return { ok: false, error: PATH_OUTSIDE_WORKSPACE };
  const resolved = resolveWithExistingAncestor(normalized);
  if (!resolved.ok) return resolved;
  if (!pathIsWithin(root, resolved.path)) return { ok: false, error: PATH_OUTSIDE_WORKSPACE };
  return resolved;
}

/**
 * `resolve_external_path`: resolve an explicitly approved path without
 * workspace containment (relative paths still use the workspace as base).
 */
export function resolveExternalPath(workspaceRoot: string, input: string): PathResolution {
  const root = simpleCanonicalize(workspaceRoot);
  if (root === null) return { ok: false, error: "workspace canonicalize failed" };
  const candidate = isAbsolute(input) ? input : join(root, input);
  return resolveWithExistingAncestor(normalizeLexical(candidate));
}

/** Strip a normalized root prefix component-wise (`strip_prefix`). */
function stripNormalizedPrefix(path: string, root: string): string | null {
  const split = (value: string): string[] =>
    normalizeLexical(value)
      .split(WINDOWS ? /[\\/]+/ : sep)
      .filter((part) => part.length > 0);
  const pathParts = split(path);
  const rootParts = split(root);
  if (rootParts.length > pathParts.length) return null;
  for (let index = 0; index < rootParts.length; index += 1) {
    const equal = WINDOWS
      ? rootParts[index].toLowerCase() === pathParts[index].toLowerCase()
      : rootParts[index] === pathParts[index];
    if (!equal) return null;
  }
  return pathParts.slice(rootParts.length).join(sep);
}

export type ToolPathResolution =
  | { ok: true; path: string; root: "workspace" | "scratch" }
  | { ok: false; error: string };

/**
 * `resolve_tool_path`: workspace first, then the session scratch root for
 * absolute inputs (both the input as spelled and a literal scratch-prefix
 * rewrite, because the advertised spelling may differ from the canonical one).
 */
export function resolveToolPath(
  workspaceRoot: string,
  scratchRoot: string | null | undefined,
  input: string,
): ToolPathResolution {
  const workspace = resolveInWorkspace(workspaceRoot, input);
  if (workspace.ok) return { ok: true, path: workspace.path, root: "workspace" };
  if (isAbsolute(input) && scratchRoot) {
    const direct = resolveInWorkspace(scratchRoot, input);
    if (direct.ok) return { ok: true, path: direct.path, root: "scratch" };
    const relative = stripNormalizedPrefix(normalizeLexical(input), normalizeLexical(scratchRoot));
    if (relative !== null) {
      const rewritten = resolveInWorkspace(scratchRoot, relative);
      if (rewritten.ok) return { ok: true, path: rewritten.path, root: "scratch" };
    }
  }
  return { ok: false, error: workspace.error };
}

/** `lexically_inside`: absolute-path containment with no filesystem access. */
export function lexicallyInside(root: string, input: string): boolean {
  if (!isAbsolute(input)) return false;
  return pathIsWithin(normalizeLexical(root), normalizeLexical(input));
}

/** The PI tools whose explicit path can be outside the workspace. */
export const PATH_TOOL_NAMES: Record<string, true> = {
  read: true,
  glob: true,
  grep: true,
  write: true,
  edit: true,
};

/**
 * `requires_external_path_permission` (PI rpc/mod.rs):
 * `Read|Glob|Grep|Write|Edit` with an explicit `path` outside both the
 * workspace and the scratch root needs the external-path permission step.
 * Scratch paths are recognized lexically before the lazy scratch directory
 * exists.
 *
 * A relative path is joined to the workspace before containment is decided —
 * exactly as PI's resolver does — so a relative path is *not* automatically
 * internal: `../outside/file` resolves outside and takes the external branch,
 * while `inside/file` resolves inside and does not. (An earlier comment here
 * claimed relative paths can never be external; that was wrong and this
 * behavior is pinned by `tool-paths.test.ts`.)
 */
export function requiresExternalPathPermission(
  workspacePath: string | null | undefined,
  scratchPath: string | null | undefined,
  toolName: string,
  args: unknown,
): boolean {
  if (PATH_TOOL_NAMES[toolName.toLowerCase()] !== true) return false;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  const path = (args as Record<string, unknown>).path;
  if (typeof path !== "string" || path.length === 0) return false;
  if (scratchPath && lexicallyInside(scratchPath, path)) return false;
  if (!workspacePath) return false;
  const resolved = resolveToolPath(workspacePath, scratchPath, path);
  return !resolved.ok && resolved.error === PATH_OUTSIDE_WORKSPACE;
}
