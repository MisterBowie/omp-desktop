import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReviewFocusRequest } from "../../lib/review-focus-request";
import { reviewTabEntriesFromMessages, summarizeReviewTabEntries } from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { OmpReviewChangeCard } from "../OmpReviewChangeCard";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

/* Module-level like the Files tab's request dedup: a remounted tab must not
   re-apply a focus request it already honored. */
let handledFocusSeq = 0;

type AppliedFocus = {
  reviewKeys: ReadonlySet<string>;
  /** The earliest focused change in the list, scrolled to the top. */
  anchor: string;
  expand: boolean;
  seq: number;
};

export function ReviewTab() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const entries = useMemo(() => reviewTabEntriesFromMessages(messages), [messages]);
  const summary = useMemo(() => summarizeReviewTabEntries(entries), [entries]);
  const focusRequest = useReviewFocusRequest();
  const [focus, setFocus] = useState<AppliedFocus | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // A request names rows of one session; it waits until this tab shows that
  // session's changes, then applies once.
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === handledFocusSeq) return;
    const wanted = new Set(focusRequest.reviewKeys);
    const anchor = entries.find((entry) => wanted.has(entry.key));
    if (!anchor) return;
    handledFocusSeq = focusRequest.seq;
    setFocus({
      reviewKeys: wanted,
      anchor: anchor.key,
      expand: focusRequest.expand,
      seq: focusRequest.seq,
    });
  }, [focusRequest, entries]);

  useEffect(() => {
    if (!focus) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-review-key="${CSS.escape(focus.anchor)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [focus]);

  if (entries.length === 0) {
    return (
      <WorkTabEmpty
        icon={IconDiff}
        title={t("panel.review.noChanges")}
      />
    );
  }

  return (
    <div className="review-tab">
      <div className="review-toolbar">
        <span className="review-summary">
          {t("panel.review.changes", { count: summary.changeCount })}
        </span>
        <span className="review-toolbar-counts diff-counts">
          <span className="diff-count-add">+{summary.additions}</span>
          <span className="diff-count-del">−{summary.deletions}</span>
        </span>
      </div>
      <div className="review-scroll" ref={scrollRef}>
        {entries.map((entry) => {
          const openRequest =
            focus?.expand && focus.reviewKeys.has(entry.key) ? focus.seq : undefined;
          return entry.kind === "snapshot" ? (
            <ReviewChangeCard
              key={entry.key}
              message={entry.message}
              compact
              openRequest={openRequest}
            />
          ) : (
            <OmpReviewChangeCard
              key={entry.key}
              change={entry.change}
              reviewKey={entry.key}
              openRequest={openRequest}
            />
          );
        })}
      </div>
    </div>
  );
}
