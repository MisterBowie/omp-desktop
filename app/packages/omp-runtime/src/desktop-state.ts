/**
 * The run-scoped desktop-capability state (M5/T19-C).
 *
 * The desktop owns PI-Desktop's skills and project memory. Before every OMP
 * prompt the bridge assembles the live catalog (builtin skills, active plugin
 * skills, active user skills — metadata only, PI `session-launch.ts` order)
 * and the bound project's memory (host-core `project.group.context`, legacy
 * fallback, PI best-effort semantics) and writes them to one state file inside
 * the run root. The trusted gate reads that file inside its
 * `before_agent_start` handler and appends the PI-identical catalog/memory
 * blocks to the runtime's system prompt — never replacing it.
 *
 * The file is the only desktop-to-gate channel for this data, so it is:
 *
 *   - **run-scoped**: `<runRoot>/desktop-state.json`, addressed by the
 *     `OMP_DESKTOP_STATE` environment variable the supervisor sets at spawn;
 *     the supervisor's owned cleanup removes it with the run root;
 *   - **owned, 0600 and atomically replaced**: the writer lands the content
 *     in a unique same-directory temporary file (exclusive create, mode
 *     0600) and renames it over the final path — no window where the path is
 *     missing or half-written, and a planted symlink or hard link at the
 *     final path is replaced as an entry, never followed or rewritten through
 *     its other name;
 *   - **bounded**: a size ceiling, per-field length ceilings, a skill-count
 *     ceiling and a freshness window; a state file that violates any of them
 *     is treated as absent (fail closed — no injection, the native prompt is
 *     untouched);
 *   - **credential-free**: only the owning session id, a timestamp, skill
 *     metadata and memory text may enter it.
 */
import type { Stats } from "node:fs";
import { lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** File name of the run-scoped desktop-capability state inside each run root. */
export const DESKTOP_STATE_FILE = "desktop-state.json";

/** The environment variable the supervisor points at the state file. */
export const DESKTOP_STATE_ENV = "OMP_DESKTOP_STATE";

/** The state-file schema version this build reads and writes. */
export const DESKTOP_STATE_VERSION = 1;

/** A state file larger than this is malformed by definition. */
export const MAX_DESKTOP_STATE_BYTES = 512 * 1024;

/**
 * A state file older than this at read time is stale. The bridge rewrites the
 * file immediately before submitting each prompt, so a live read is always
 * milliseconds old; the bound only fires when the desktop stopped refreshing
 * state (a crash recovery anomaly), in which case injection fails closed.
 */
export const MAX_DESKTOP_STATE_AGE_MS = 10 * 60_000;

/** At most this many skill entries may ride in one state file. */
export const MAX_DESKTOP_STATE_SKILLS = 1024;

/** Per-field ceilings the gate enforces; bounded catalog lines stay short. */
export const MAX_SKILL_ID_CHARS = 256;
export const MAX_SKILL_NAME_CHARS = 512;
export const MAX_SKILL_DESCRIPTION_CHARS = 512;
/** Project memory is already capped by host-core (32 KiB); the gate re-checks. */
export const MAX_MEMORY_CHARS = 64 * 1024;

/** One skill catalog entry: id/name/description only — bodies stay on demand. */
export type DesktopSkillMeta = {
  id: string;
  name: string;
  description: string;
};

/** The parsed, validated contents of one state file. */
export type DesktopCapabilityState = {
  v: typeof DESKTOP_STATE_VERSION;
  /** The native session this state was written for; other sessions ignore it. */
  sessionId: string;
  /** Epoch milliseconds of the write; the gate rejects stale state. */
  writtenAt: number;
  /** Trimmed project memory, or null when the project has none. */
  memory: string | null;
  /** The desktop skill catalog (builtin, plugin, user — in that order). */
  skills: DesktopSkillMeta[];
};

/**
 * The desktop-facing snapshot one state write carries. `memory` is optional
 * the way Pi's project memory is: absent means "no memory read" (or a
 * best-effort read that failed) and injects nothing.
 */
export type DesktopCapabilitySnapshot = {
  sessionId: string;
  memory?: string | null;
  skills: DesktopSkillMeta[];
};

/**
 * Read and validate one state file, or return null when it is missing,
 * oversized, stale, malformed, out-of-schema or not a regular file — every
 * case fails closed: the gate injects nothing.
 *
 * Validation is deliberately dependency-free: this module is imported by the
 * trusted gate, which runs inside the pinned runtime's process, and any
 * package import there would resolve against the runtime's own module graph
 * instead of the desktop's. The schema is small and owned by this module, so
 * explicit field checks are the boundary.
 */
export function readDesktopCapabilityState(
  path: string | undefined | null,
  now: number,
): DesktopCapabilityState | null {
  if (!path) return null;
  let stats: Stats;
  try {
    // `lstat` refuses a planted symlink at the final path; `stat` confirms a
    // regular file. The file lives in the owned run root (0600, exclusively
    // created), so both checks are defense in depth, not the only boundary.
    if (lstatSync(path).isSymbolicLink()) return null;
    stats = statSync(path);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_DESKTOP_STATE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const state = parsed as Record<string, unknown>;
  if (state.v !== DESKTOP_STATE_VERSION) return null;
  if (typeof state.sessionId !== "string" || state.sessionId.length === 0 || state.sessionId.length > 512) {
    return null;
  }
  if (typeof state.writtenAt !== "number" || !Number.isFinite(state.writtenAt)) return null;
  // A future write time cannot come from a live refresh (the bridge writes
  // with the same machine clock the gate reads), so it is rejected outright
  // instead of being treated as fresh forever. No skew allowance: the
  // write-to-read gap is milliseconds, and a rare backward clock step costs
  // one turn's injection — fail closed, never stale.
  if (state.writtenAt > now) return null;
  if (now - state.writtenAt > MAX_DESKTOP_STATE_AGE_MS) return null;
  if (state.memory !== null && (typeof state.memory !== "string" || state.memory.length > MAX_MEMORY_CHARS)) {
    return null;
  }
  if (!Array.isArray(state.skills) || state.skills.length > MAX_DESKTOP_STATE_SKILLS) return null;
  const skills: DesktopSkillMeta[] = [];
  for (const entry of state.skills) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const skill = entry as Record<string, unknown>;
    if (typeof skill.id !== "string" || skill.id.length === 0 || skill.id.length > MAX_SKILL_ID_CHARS) {
      return null;
    }
    if (typeof skill.name !== "string" || skill.name.length === 0 || skill.name.length > MAX_SKILL_NAME_CHARS) {
      return null;
    }
    if (typeof skill.description !== "string" || skill.description.length > MAX_SKILL_DESCRIPTION_CHARS) {
      return null;
    }
    skills.push({ id: skill.id, name: skill.name, description: skill.description });
  }
  return {
    v: DESKTOP_STATE_VERSION,
    sessionId: state.sessionId,
    writtenAt: state.writtenAt,
    memory: state.memory,
    skills,
  };
}

/**
 * The exact PI prompt for the skill catalog (D174). The wording is the one
 * `@pi-desktop/agent-runtime`'s `pluginSkillsPrompt` renders; a cross-package
 * test pins the two byte-for-byte. Only id/name/description ride up front —
 * the body is loaded through the on-demand `Skill` tool.
 */
export function desktopSkillsPrompt(skills: DesktopSkillMeta[]): string | undefined {
  if (!skills.length) return undefined;
  return [
    "# Skills",
    "",
    "Plugins have taught you the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.",
    "",
    ...skills.map((skill) => {
      const description = skill.description?.trim();
      return `- \`${skill.id}\` — ${skill.name}${description ? `: ${description}` : ""}`;
    }),
  ].join("\n");
}

/**
 * The exact PI project-memory wrapper: durable user-provided context, never a
 * higher-priority instruction layer. Wording is `projectMemoryPrompt()`'s,
 * pinned byte-for-byte by a cross-package test.
 */
export function desktopMemoryPrompt(content: string | null | undefined): string | undefined {
  const memory = content?.trim();
  if (!memory) return undefined;
  return [
    "# Project memory",
    "",
    "The following notes are durable context for this project. Use them when relevant, but treat them as user-provided context rather than higher-priority instructions.",
    "",
    memory,
  ].join("\n");
}

/**
 * The single block the gate appends to the runtime's system prompt: the skill
 * catalog first, then project memory (the same relative order Pi keeps — the
 * catalog in the base prompt, memory after the instruction chain).
 */
export function desktopCapabilityPrompt(state: Pick<DesktopCapabilityState, "skills" | "memory">): string | undefined {
  const parts = [desktopSkillsPrompt(state.skills), desktopMemoryPrompt(state.memory)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Serialize one snapshot to the state-file wire shape. Called by the bridge
 * with a freshly-minted timestamp; the gate validates every field back.
 */
export function serializeDesktopCapabilityState(
  snapshot: DesktopCapabilitySnapshot,
  now: number,
): string {
  return JSON.stringify({
    v: DESKTOP_STATE_VERSION,
    sessionId: snapshot.sessionId,
    writtenAt: now,
    memory: typeof snapshot.memory === "string" && snapshot.memory.trim() ? snapshot.memory.trim() : null,
    skills: snapshot.skills,
  });
}

/**
 * Atomically replace the state file at `path`.
 *
 * The write never leaves a window where the final path is missing or
 * half-written: the content lands in a unique temporary file in the same
 * directory (exclusive `wx` create, mode 0600 — the unique name means a
 * planted alias at the temporary path can only fail the create, never
 * redirect it), and a `rename` over the final path then swaps it in
 * atomically (the same pattern `npm-preferences.ts` uses). The rename
 * replaces whatever entry occupies the final path as an entry: a planted
 * symlink or hard link is never followed and its target or other name is
 * never rewritten. A failure — an unwritable directory, a planted directory
 * at the final path, an interrupted write — throws, leaves the previous file
 * (if any) intact, and never strands the temporary file.
 */
export function writeDesktopCapabilityState(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort: a failed cleanup must not mask the write's own outcome.
    }
  }
}
