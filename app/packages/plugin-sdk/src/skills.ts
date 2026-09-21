export type ParsedSkillDoc = {
  name?: string;
  description?: string;
  /** Document body with the front matter block removed. */
  body: string;
};

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * Parse the optional `---` front matter of a skill document.
 *
 * Only flat `key: value` lines are understood; anything else is ignored so a
 * richer document still loads with its body intact.
 */
export function parseSkillFrontmatter(raw: string): ParsedSkillDoc {
  const text = raw.replace(/^﻿/, "");
  const match = FRONT_MATTER.exec(text);
  if (!match) return { body: text.trim() };

  const body = text.slice(match[0].length).trim();
  const result: ParsedSkillDoc = { body };
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = unquote(line.slice(sep + 1));
    if (!value) continue;
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
  }
  return result;
}

/** Derive a plugin-local skill id from a contributed relative path. */
export function skillIdFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const withoutExt = base.replace(/\.[^.]+$/, "");
  const slug = withoutExt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}
