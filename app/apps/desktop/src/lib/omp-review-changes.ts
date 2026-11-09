import type { DiffHunk, DiffLine, UiMessage } from "@pi-desktop/shared";

/**
 * Read-only Review entries derived from OMP native `edit` / `write` results.
 *
 * OMP results carry no PI review snapshot, so they are never shaped into one:
 * no snapshot id, no rollback, no host call. Each entry is read from the
 * result's own `details`, which the live `tool_end` and the restored history
 * row carry identically. Tool arguments are not used because restored rows do
 * not have them.
 */
export type OmpReviewStatus = "added" | "modified" | "deleted" | "renamed" | "written";

export type OmpReviewChange = {
  /** Stable per message and file; never a host snapshot id. */
  key: string;
  /** Path OMP reported for the file after the change (absolute in practice). */
  path: string;
  /** Rename source, when the edit moved the file. */
  sourcePath?: string;
  status: OmpReviewStatus;
  /** Exact counts from OMP's own diff; `null` when OMP gave no line evidence. */
  additions: number | null;
  deletions: number | null;
  hunks: DiffHunk[];
  /** Hunk lines were capped for display, or the result itself was cut short. */
  truncated: boolean;
};

/** Rendered diff lines per change; counts are always taken from every row. */
export const OMP_REVIEW_MAX_DIFF_LINES = 400;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The bare native tool name (`edit`, `write`), as the presentation layer reads it. */
function bareToolName(toolName?: string): string {
  return (toolName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type ParsedDiff = { hunks: DiffHunk[]; additions: number; deletions: number };

const NUMBERED_ROW = /^([+\- ])(\d+)\|(.*)$/s;
const UNIFIED_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * OMP's structured `diff` is a numbered row diff (`+N|text`, `-N|text`,
 * ` N|text`, blank rows between regions) for most edit modes and a plain
 * unified diff for `patch` / `apply_patch`. Every change row is present; only
 * context is trimmed, so the counts are exact.
 */
function parseOmpDiff(diff: string): ParsedDiff | null {
  const rows = diff.split("\n");
  return rows.some((row) => UNIFIED_HEADER.test(row))
    ? parseUnifiedDiff(rows)
    : parseNumberedDiff(rows);
}

function parseNumberedDiff(rows: string[]): ParsedDiff | null {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  // Context and removed rows carry old line numbers, added rows new ones; the
  // running offset converts between them for each hunk's header.
  let offset = 0;
  let current: { lines: DiffLine[]; oldStart: number; newStart: number } | null = null;
  const close = () => {
    if (current && current.lines.length > 0) {
      hunks.push({ header: `@@ -${current.oldStart} +${current.newStart} @@`, lines: current.lines });
    }
    current = null;
  };
  for (const row of rows) {
    const match = NUMBERED_ROW.exec(row);
    if (!match) {
      close();
      continue;
    }
    const [, sign, number, text] = match;
    const line = Number(number);
    if (!current) {
      current =
        sign === "+"
          ? { lines: [], oldStart: line - offset, newStart: line }
          : { lines: [], oldStart: line, newStart: line + offset };
    }
    if (sign === "+") {
      additions += 1;
      offset += 1;
      current.lines.push({ type: "add", text });
    } else if (sign === "-") {
      deletions += 1;
      offset -= 1;
      current.lines.push({ type: "del", text });
    } else {
      current.lines.push({ type: "context", text });
    }
  }
  close();
  return additions + deletions > 0 ? { hunks, additions, deletions } : null;
}

function parseUnifiedDiff(rows: string[]): ParsedDiff | null {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;
  for (const row of rows) {
    if (UNIFIED_HEADER.test(row)) {
      current = { header: row, lines: [] };
      hunks.push(current);
      continue;
    }
    // File headers (`--- a/x`, `+++ b/x`, `diff --git`) precede the first hunk.
    if (!current) continue;
    if (row.startsWith("+")) {
      additions += 1;
      current.lines.push({ type: "add", text: row.slice(1) });
    } else if (row.startsWith("-")) {
      deletions += 1;
      current.lines.push({ type: "del", text: row.slice(1) });
    } else if (row.startsWith(" ")) {
      current.lines.push({ type: "context", text: row.slice(1) });
    } else if (row.startsWith("\\")) {
      continue;
    } else {
      current = null;
    }
  }
  return additions + deletions > 0 ? { hunks, additions, deletions } : null;
}

/** A whole-file snapshot as one hunk of only added or only removed lines. */
function snapshotDiff(text: string, type: "add" | "del"): ParsedDiff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const count = lines.length;
  return {
    hunks: count > 0
      ? [{
          header: type === "add" ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`,
          lines: lines.map((text) => ({ type, text })),
        }]
      : [],
    additions: type === "add" ? count : 0,
    deletions: type === "del" ? count : 0,
  };
}

function capHunks(hunks: DiffHunk[]): { hunks: DiffHunk[]; capped: boolean } {
  let budget = OMP_REVIEW_MAX_DIFF_LINES;
  const kept: DiffHunk[] = [];
  for (const hunk of hunks) {
    if (budget <= 0) return { hunks: kept, capped: true };
    if (hunk.lines.length <= budget) {
      kept.push(hunk);
      budget -= hunk.lines.length;
      continue;
    }
    kept.push({ header: hunk.header, lines: hunk.lines.slice(0, budget) });
    return { hunks: kept, capped: true };
  }
  return { hunks: kept, capped: false };
}

/** One file of an OMP edit result, or `null` for a failed or no-op file. */
function editFileChange(
  file: Record<string, unknown>,
  key: string,
  resultTruncated: boolean,
): OmpReviewChange | null {
  if (file.isError === true) return null;
  // OMP reports a moved file's destination as both `path` and `move`.
  const move = nonEmptyString(file.move);
  const path = move ?? nonEmptyString(file.path);
  if (!path) return null;
  const op = file.op;
  const sourcePath = move ? nonEmptyString(file.sourcePath) : null;
  const diff = typeof file.diff === "string" ? file.diff : "";
  const oldText = typeof file.oldText === "string" ? file.oldText : null;
  const newText = typeof file.newText === "string" ? file.newText : null;

  let parsed = diff ? parseOmpDiff(diff) : null;
  if (!parsed && op === "delete" && oldText !== null) parsed = snapshotDiff(oldText, "del");
  if (!parsed && op === "create" && newText !== null) parsed = snapshotDiff(newText, "add");

  const status: OmpReviewStatus =
    op === "create" ? "added"
      : op === "delete" ? "deleted"
        : sourcePath ? "renamed"
          : "modified";
  // An update that neither changed lines nor moved the file is OMP's no-op.
  if (!parsed && status === "modified" && !diff) return null;

  const truncated = resultTruncated || file.truncated === true;
  const capped = capHunks(parsed?.hunks ?? []);
  // A pure rename has no line changes; any other change without parsed rows
  // has no line evidence, so its counts stay unknown rather than zero.
  const countsKnown = !truncated && (parsed !== null || status === "renamed");
  return {
    key,
    path,
    ...(sourcePath ? { sourcePath } : {}),
    status,
    additions: countsKnown ? (parsed?.additions ?? 0) : null,
    deletions: countsKnown ? (parsed?.deletions ?? 0) : null,
    hunks: truncated ? [] : capped.hunks,
    truncated: truncated || capped.capped,
  };
}

/**
 * The read-only changes one successful OMP native `edit` or `write` result
 * reports. Any other message — PI tools, plugins whose names merely end in
 * `edit`, failures — yields none.
 */
export function ompReviewChangesFromMessage(message: UiMessage): OmpReviewChange[] {
  if (message.role !== "tool" || message.toolStatus !== "success") return [];
  const name = bareToolName(message.toolName);
  if (name !== "edit" && name !== "write") return [];
  const details = recordValue(recordValue(message.toolResult)?.details);
  // A PI review snapshot owns its message; it is never read twice.
  if (!details || details.review !== undefined) return [];
  const resultTruncated = details.truncated === true;

  if (name === "write") {
    // OMP reports only where it wrote: no prior content, no created/overwritten
    // flag. A tool-device write (`xd://`) is not a file.
    const path = nonEmptyString(details.resolvedPath);
    if (!path || details.xdev !== undefined) return [];
    return [{
      key: `${message.id}:0`,
      path,
      status: "written",
      additions: null,
      deletions: null,
      hunks: [],
      truncated: resultTruncated,
    }];
  }

  // Native edit only: PI's Edit and plugin `*_edit` tools never carry these.
  const perFile = Array.isArray(details.perFileResults) ? details.perFileResults : null;
  if (!perFile && typeof details.diff !== "string") return [];
  const files = perFile ?? [details];
  return files.flatMap((entry, index) => {
    const file = recordValue(entry);
    const change = file ? editFileChange(file, `${message.id}:${index}`, resultTruncated) : null;
    return change ? [change] : [];
  });
}
