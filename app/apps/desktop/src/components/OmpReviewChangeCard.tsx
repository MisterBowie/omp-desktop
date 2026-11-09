import { memo, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OmpReviewChange, OmpReviewStatus } from "../lib/omp-review-changes";
import { toWorkspaceRel } from "../lib/chat-links";
import { shortenPath } from "../lib/project-archive";
import { useAppStore } from "../stores/app-store";
import { ReviewDiffHunks } from "./ReviewChangeCard";
import { cx } from "./ui";
import { IconChevronRight } from "./icons";

const STATUS_MARKS: Record<OmpReviewStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  written: "W",
};

function displayPath(path: string, root: string | null | undefined): string {
  return toWorkspaceRel(path, root) ?? shortenPath(path);
}

/**
 * A read-only Review row for one file an OMP native edit/write reported. It
 * shares the PI row's layout but has no rollback: OMP keeps no host snapshot.
 */
export const OmpReviewChangeCard = memo(function OmpReviewChangeCard({
  change,
  reviewKey,
  openRequest,
}: {
  change: OmpReviewChange;
  /** The Review row key a per-turn summary uses to find this row. */
  reviewKey: string;
  /** Each new value expands the diff once; the user can collapse it again. */
  openRequest?: number;
}) {
  const { t } = useTranslation();
  const root = useAppStore((state) => state.workspace?.path);
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openRequest !== undefined) setOpen(true);
  }, [openRequest]);

  const path = displayPath(change.path, root);
  const shownPath = change.sourcePath
    ? `${displayPath(change.sourcePath, root)} → ${path}`
    : path;
  const status = t(`panel.review.status.${change.status}`);
  const { additions, deletions } = change;
  const counts = additions !== null && deletions !== null ? { additions, deletions } : null;
  const accessibleLabel = counts
    ? t(open ? "chat.reviewChangeHide" : "chat.reviewChangeShow", {
        status,
        path: shownPath,
        ...counts,
      })
    : t(open ? "chat.reviewChangeHideNoCounts" : "chat.reviewChangeShowNoCounts", {
        status,
        path: shownPath,
      });

  return (
    <section
      className={cx("review-change-card", "is-compact", open && "open")}
      data-state="active"
      data-status={change.status}
      data-source="omp"
      data-review-key={reviewKey}
    >
      <button
        type="button"
        className="review-change-card-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="review-change-card-caret" aria-hidden>
          <IconChevronRight size={11} />
        </span>
        <span className={cx("review-change-card-mark", `is-${change.status}`)} aria-hidden>
          {STATUS_MARKS[change.status]}
        </span>
        <span className="review-change-card-path" title={shownPath}>
          {shownPath}
        </span>
        {counts ? (
          <span
            className="review-change-card-counts diff-counts"
            aria-label={t("chat.reviewChangeCounts", counts)}
          >
            {counts.additions > 0 && (
              <span className="diff-count-add">+{counts.additions}</span>
            )}
            {counts.deletions > 0 && (
              <span className="diff-count-del">−{counts.deletions}</span>
            )}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <div className="review-change-card-body-content">
            {change.status === "written" ? (
              <div className="review-change-note">{t("panel.review.ompWriteNoDiff")}</div>
            ) : change.hunks.length > 0 ? (
              <ReviewDiffHunks hunks={change.hunks} />
            ) : (
              <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
            )}
            {change.truncated ? (
              <div className="review-change-note">{t("panel.review.tooLarge")}</div>
            ) : null}
            <div className="review-change-card-actions is-compact">
              <span className="review-change-rollback-note">
                {t("panel.review.ompReadOnly")}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
});
