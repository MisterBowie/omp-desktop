import { memo, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiffHunk,
  ReviewChangeStatus,
  ReviewRollbackStatus,
  UiMessage,
} from "@pi-desktop/shared";
import { reviewChangeFromMessage } from "../lib/workspace-review";
import { useAppStore } from "../stores/app-store";
import { cx } from "./ui";
import { IconCheck, IconChevronRight, IconSnapshot } from "./icons";

/* Git-status letters carry the status without relying on color alone; the
   localized word stays in the row's accessible name. */
const STATUS_MARKS: Record<ReviewChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

/** The recorded hunks of one change, shared by PI snapshots and OMP results. */
export function ReviewDiffHunks({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="review-change-diff">
      {hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
          <div className="diff-line hunk">
            <span className="diff-line-text">{hunk.header}</span>
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div className={cx("diff-line", line.type)} key={lineIndex}>
              <span className="diff-line-sign" aria-hidden>
                {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
              </span>
              <span className="diff-line-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DiffBody({ message, compact }: { message: UiMessage; compact: boolean }) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const rollback = useAppStore((state) => state.rollbackWorkspaceChange);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackStatus, setRollbackStatus] = useState<ReviewRollbackStatus | null>(
    null,
  );

  if (!change) return null;

  const runRollback = async () => {
    if (!change.reversible || change.state === "rolledBack" || rollingBack) return;
    setRollingBack(true);
    setRollbackStatus(null);
    const result = await rollback(message.id, change.snapshotId);
    setRollingBack(false);
    if (result) setRollbackStatus(result.status);
  };

  return (
    <div className="review-change-card-body-content">
      {change.binary ? (
        <div className="review-change-note">{t("panel.review.binary")}</div>
      ) : change.truncated ? (
        <div className="review-change-note">{t("panel.review.tooLarge")}</div>
      ) : change.hunks.length > 0 ? (
        <ReviewDiffHunks hunks={change.hunks} />
      ) : (
        <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
      )}

      <div className={cx("review-change-card-actions", compact && "is-compact")}>
        {rollbackStatus === "conflict" ? (
          <div className="review-change-rollback-note is-warning">
            {t("panel.review.rollbackConflict")}
          </div>
        ) : rollbackStatus === "unavailable" ? (
          <div className="review-change-rollback-note">
            {t("panel.review.rollbackUnavailable")}
          </div>
        ) : null}
        {change.state === "rolledBack" ? (
          <span className="review-change-state is-rolled-back">
            <IconCheck size={13} />
            {t("panel.review.rolledBack")}
          </span>
        ) : change.reversible ? (
          <button
            type="button"
            className="review-change-rollback"
            onClick={() => void runRollback()}
            disabled={rollingBack}
          >
            <IconSnapshot size={13} />
            {rollingBack
              ? t("panel.review.rollingBack")
              : t("panel.review.rollback")}
          </button>
        ) : (
          <span className="review-change-rollback-note">
            {t("panel.review.rollbackUnavailable")}
          </span>
        )}
      </div>
    </div>
  );
}

export const ReviewChangeCard = memo(function ReviewChangeCard({
  message,
  compact = false,
  openRequest,
}: {
  message: UiMessage;
  compact?: boolean;
  /** Each new value expands the diff once; the user can collapse it again. */
  openRequest?: number;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openRequest !== undefined) setOpen(true);
  }, [openRequest]);

  if (!change) return null;

  const statusLabel = t(`panel.review.status.${change.status}`);
  const baseLabel = t(open ? "chat.reviewChangeHide" : "chat.reviewChangeShow", {
    status: statusLabel,
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
  });
  // The collapsed row shows a rolled-back change struck through, so the state
  // has to reach the accessible name too.
  const accessibleLabel =
    change.state === "rolledBack"
      ? `${baseLabel} · ${t("panel.review.rolledBack")}`
      : baseLabel;

  return (
    <section
      className={cx("review-change-card", compact && "is-compact", open && "open")}
      data-state={change.state}
      data-status={change.status}
      data-review-key={change.snapshotId}
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
        <span
          className={cx("review-change-card-mark", `is-${change.status}`)}
          aria-hidden
        >
          {STATUS_MARKS[change.status]}
        </span>
        <span className="review-change-card-path" title={change.path}>
          {change.path}
        </span>
        <span
          className="review-change-card-counts diff-counts"
          aria-label={t("chat.reviewChangeCounts", change)}
        >
          {change.additions > 0 && (
            <span className="diff-count-add">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="diff-count-del">−{change.deletions}</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <DiffBody message={message} compact={compact} />
        </div>
      ) : null}
    </section>
  );
});
