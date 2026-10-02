/**
 * M5/T20-C: parity tests for the ported PI path resolver
 * (`crates/host-core/src/workspace.rs`). The gate decides external-path
 * permission from these helpers, so every escape the Rust tests pin is pinned
 * here too.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  lexicallyInside,
  normalizeLexical,
  pathIsWithin,
  requiresExternalPathPermission,
  resolveExternalPath,
  resolveInWorkspace,
  resolveToolPath,
  type PathResolution,
  type ToolPathResolution,
} from "./tool-paths.js";

const scratch = [];

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** Narrow a failed resolution to its error, or fail the test. */
function errorOf(result: PathResolution | ToolPathResolution): string {
  if (result.ok) throw new Error(`expected a refused path, got ${result.path}`);
  return result.error;
}

/** Narrow a successful resolution to its path, or fail the test. */
function pathOf(result: PathResolution | ToolPathResolution): string {
  if (!result.ok) throw new Error(`expected a resolved path, got ${result.error}`);
  return result.path;
}

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("blocks lexical and nonexistent-parent escapes", () => {
    const root = makeDir("t20c-paths-");
    expect(errorOf(resolveInWorkspace(root, "../outside.txt"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(errorOf(resolveInWorkspace(root, "sub/../../evil/new.txt"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(errorOf(resolveInWorkspace(root, "a/b/../../../evil.txt"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(errorOf(resolveInWorkspace(root, "/etc/hosts"))).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("allows an existing file and a new nested path", () => {
    const root = makeDir("t20c-paths-");
    writeFileSync(join(root, "a.txt"), "x");
    expect(resolveInWorkspace(root, "a.txt").ok).toBe(true);
    const nested = pathOf(resolveInWorkspace(root, "newdir/sub/file.txt"));
    expect(nested.endsWith(join("newdir", "sub", "file.txt"))).toBe(true);
    expect(nested.startsWith(realpathSync(root))).toBe(true);
  });

  it("blocks a symlink escape and a dangling-symlink escape", () => {
    const root = makeDir("t20c-paths-");
    const outside = makeDir("t20c-paths-out-");
    symlinkSync(outside, join(root, "link"));
    expect(errorOf(resolveInWorkspace(root, "link/new.txt"))).toBe("PATH_OUTSIDE_WORKSPACE");
    const target = join(outside, "planted.txt");
    symlinkSync(target, join(root, "dangling"));
    expect(errorOf(resolveInWorkspace(root, "dangling"))).toBe("PATH_OUTSIDE_WORKSPACE");
    symlinkSync(join(outside, "dir"), join(root, "dangling-dir"));
    expect(errorOf(resolveInWorkspace(root, "dangling-dir/new.txt"))).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("resolves a dangling symlink to its target when that target stays inside", () => {
    const root = makeDir("t20c-paths-");
    symlinkSync(join(root, "not-yet.txt"), join(root, "dangling"));
    expect(pathOf(resolveInWorkspace(root, "dangling"))).toBe(join(realpathSync(root), "not-yet.txt"));
    mkdirSync(join(root, "sub"));
    symlinkSync("../elsewhere.txt", join(root, "sub", "rel"));
    expect(pathOf(resolveInWorkspace(root, "sub/rel"))).toBe(join(realpathSync(root), "elsewhere.txt"));
  });

  it("rejects a dangling symlink loop", () => {
    const root = makeDir("t20c-paths-");
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(errorOf(resolveInWorkspace(root, "a"))).toMatch(/too many symlink hops/);
  });
});

describe("resolveToolPath", () => {
  it("resolves relative paths to the workspace and absolute scratch paths to scratch", () => {
    const workspace = makeDir("t20c-paths-ws-");
    const scratchRoot = makeDir("t20c-paths-scratch-");
    const relative = resolveToolPath(workspace, scratchRoot, "notes.txt");
    if (!relative.ok) throw new Error(relative.error);
    expect(relative.root).toBe("workspace");
    expect(relative.path.startsWith(realpathSync(workspace))).toBe(true);
    const absolute = resolveToolPath(workspace, scratchRoot, join(scratchRoot, "tmp.json"));
    if (!absolute.ok) throw new Error(absolute.error);
    expect(absolute.root).toBe("scratch");
    expect(absolute.path.startsWith(realpathSync(scratchRoot))).toBe(true);
  });

  it("blocks escapes from scratch and paths outside both roots", () => {
    const workspace = makeDir("t20c-paths-ws-");
    const scratchRoot = makeDir("t20c-paths-scratch-");
    expect(errorOf(resolveToolPath(workspace, scratchRoot, join(scratchRoot, "a/../../evil.txt")))).toBe(
      "PATH_OUTSIDE_WORKSPACE",
    );
    const outside = makeDir("t20c-paths-out-");
    symlinkSync(outside, join(scratchRoot, "link"));
    expect(errorOf(resolveToolPath(workspace, scratchRoot, join(scratchRoot, "link/new.txt")))).toBe(
      "PATH_OUTSIDE_WORKSPACE",
    );
    expect(errorOf(resolveToolPath(workspace, scratchRoot, "/etc/hosts"))).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("rewrites the advertised scratch spelling to the canonical one", () => {
    const workspace = makeDir("t20c-paths-ws-");
    const root = makeDir("t20c-paths-alias-");
    mkdirSync(join(root, "private", "var", "x"), { recursive: true });
    symlinkSync(join(root, "private", "var"), join(root, "var"));
    // The scratch root keeps the non-canonical spelling; the input uses the
    // same spelling. Containment must still land in scratch.
    const advertised = join(root, "var", "x");
    const resolved = resolveToolPath(workspace, advertised, join(advertised, "f.txt"));
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.root).toBe("scratch");
    expect(resolved.path).toBe(join(root, "private", "var", "x", "f.txt"));
  });

  it("keeps an approved external path absolute and canonical", () => {
    const workspace = makeDir("t20c-paths-ws-");
    const outside = makeDir("t20c-paths-out-");
    const file = join(outside, "outside.txt");
    writeFileSync(file, "outside");
    expect(pathOf(resolveExternalPath(workspace, file))).toBe(realpathSync(file));
  });
});

describe("lexical helpers", () => {
  it("normalizes . and .. without the filesystem", () => {
    expect(normalizeLexical("/a/b/../c/./d/")).toBe("/a/c/d");
    expect(normalizeLexical("/../a")).toBe("/a");
    expect(normalizeLexical("/a/..")).toBe("/");
  });

  it("compares containment component-wise", () => {
    expect(pathIsWithin("/a/b", "/a/b/c")).toBe(true);
    expect(pathIsWithin("/a/b", "/a/bc")).toBe(false);
    expect(pathIsWithin("/a/b", "/a")).toBe(false);
  });

  it("checks lexical scratch containment like PI", () => {
    const dir = makeDir("t20c-paths-");
    const root = join(dir, "data", "scratch", "s1");
    expect(lexicallyInside(root, join(root, "a.txt"))).toBe(true);
    expect(lexicallyInside(root, join(root, "sub", ".", "b.txt"))).toBe(true);
    expect(lexicallyInside(root, join(root, "..", "s2", "a.txt"))).toBe(false);
    expect(lexicallyInside(root, join(dir, "data", "other", "a.txt"))).toBe(false);
    expect(lexicallyInside(root, "relative/a.txt")).toBe(false);
  });
});

describe("requiresExternalPathPermission", () => {
  it("applies to PI's path tools only, with an explicit path", () => {
    const workspace = makeDir("t20c-paths-ws-");
    const outside = makeDir("t20c-paths-out-");
    const externalPath = join(outside, "secret.txt");
    expect(requiresExternalPathPermission(workspace, null, "read", { path: externalPath })).toBe(true);
    expect(requiresExternalPathPermission(workspace, null, "Write", { path: externalPath })).toBe(true);
    expect(requiresExternalPathPermission(workspace, null, "bash", { command: "cat x" })).toBe(false);
    expect(requiresExternalPathPermission(workspace, null, "bash", { path: externalPath })).toBe(false);
    expect(requiresExternalPathPermission(workspace, null, "apply_patch", { path: externalPath })).toBe(false);
    expect(requiresExternalPathPermission(workspace, null, "read", {})).toBe(false);
    expect(requiresExternalPathPermission(workspace, null, "read", { path: "" })).toBe(false);
    expect(requiresExternalPathPermission(null, null, "read", { path: externalPath })).toBe(false);
    // Inside the workspace, or under the scratch root: no external step.
    writeFileSync(join(workspace, "inside.txt"), "x");
    expect(requiresExternalPathPermission(workspace, null, "read", { path: join(workspace, "inside.txt") })).toBe(false);
    expect(requiresExternalPathPermission(workspace, null, "read", { path: "inside.txt" })).toBe(false);
    const scratchRoot = makeDir("t20c-paths-scratch-");
    expect(
      requiresExternalPathPermission(workspace, scratchRoot, "read", { path: join(scratchRoot, "new.txt") }),
    ).toBe(false);
  });

  it("treats a relative escape as external and a plain relative path as internal", () => {
    // PI joins relative paths to the workspace before containment, so
    // `../outside` is an external path and needs the permission step; the
    // former "a relative path can never be external" claim was wrong.
    const workspace = makeDir("t20c-paths-relws-");
    const outside = makeDir("t20c-paths-relout-");
    writeFileSync(join(outside, "secret.txt"), "x");
    const escape = join("..", outside.split(sep).pop(), "secret.txt");
    expect(requiresExternalPathPermission(workspace, null, "read", { path: escape })).toBe(true);
    expect(requiresExternalPathPermission(workspace, null, "write", { path: "../escape.txt" })).toBe(true);
    writeFileSync(join(workspace, "local.txt"), "x");
    expect(requiresExternalPathPermission(workspace, null, "read", { path: join("sub", "..", "local.txt") })).toBe(false);
  });
});
