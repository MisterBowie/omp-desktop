import type { UiMessage } from "@pi-desktop/shared";
import type { OmpReviewStatus } from "./omp-review-changes.ts";
import { reviewTabEntriesFromMessages } from "./workspace-review.ts";

/** Rows shown before the per-turn summary folds the rest into `+N more`. */
export const TURN_CHANGES_VISIBLE_LIMIT = 12;
/** Above this many files the summary switches to its dense row metrics. */
export const TURN_CHANGES_RELAXED_LIMIT = 4;

/** PI snapshot statuses are a subset of the OMP row statuses. */
export type TurnChangeStatus = OmpReviewStatus;

/** One file touched by a turn, merged across all of its recorded changes. */
export type TurnChangedFile = {
  path: string;
  /** Rename source, when the turn moved the file here. */
  sourcePath?: string;
  status: TurnChangeStatus;
  /** Summed counts; `null` once any change of the file has no line evidence. */
  additions: number | null;
  deletions: number | null;
  /** Every recorded change of this file in the turn was rolled back (PI only). */
  rolledBack: boolean;
  /** The Review rows of this file, in chronological order. */
  reviewKeys: string[];
};

export type TurnChangesSummary = {
  files: TurnChangedFile[];
  directoryCount: number;
  /** Totals of the lines the rows prove; files with unknown counts add nothing. */
  additions: number;
  deletions: number;
};

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function addCount(total: number | null, next: number | null): number | null {
  return total === null || next === null ? null : total + next;
}

/**
 * Aggregate one turn's recorded changes — PI snapshots and OMP native
 * edit/write results alike — by path. A file the turn ends by deleting is `D`;
 * otherwise any creation makes it `A`, any whole-file write `W`, any rename
 * `R`, and everything else `M`.
 */
export function summarizeTurnChanges(tools: readonly UiMessage[]): TurnChangesSummary {
  const byPath = new Map<string, TurnChangedFile & { seen: Set<TurnChangeStatus> }>();
  for (const entry of reviewTabEntriesFromMessages([...tools])) {
    const change = entry.change;
    const rolledBack = entry.kind === "snapshot" && entry.change.state === "rolledBack";
    const sourcePath = entry.kind === "omp" ? entry.change.sourcePath : undefined;
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, {
        path: change.path,
        ...(sourcePath ? { sourcePath } : {}),
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        rolledBack,
        reviewKeys: [entry.key],
        seen: new Set([change.status]),
      });
      continue;
    }
    existing.additions = addCount(existing.additions, change.additions);
    existing.deletions = addCount(existing.deletions, change.deletions);
    existing.rolledBack &&= rolledBack;
    existing.reviewKeys.push(entry.key);
    existing.seen.add(change.status);
    if (sourcePath && !existing.sourcePath) existing.sourcePath = sourcePath;
    existing.status = change.status === "deleted"
      ? "deleted"
      : existing.seen.has("added") ? "added"
        : existing.seen.has("written") ? "written"
          : existing.seen.has("renamed") ? "renamed"
            : "modified";
  }
  const files = [...byPath.values()].map(({ seen: _seen, ...file }) => file);
  return {
    files,
    directoryCount: new Set(files.map((file) => directoryOf(file.path))).size,
    additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
  };
}
