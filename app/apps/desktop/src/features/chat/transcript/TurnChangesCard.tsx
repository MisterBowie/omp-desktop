import { memo, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "../../../components/ContextMenu";
import {
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolderOpen,
} from "../../../components/icons";
import { Button, cx } from "../../../components/ui";
import { useChatNativeFilesAllowed } from "../../../hooks/use-chat-session-capability";
import { useOpenChatFileRef, useRevealChatFileRef } from "../../../hooks/use-preview-target";
import { toWorkspaceRel } from "../../../lib/chat-links";
import { shortenPath } from "../../../lib/project-archive";
import { requestReviewFocus } from "../../../lib/review-focus-request";
import {
  summarizeTurnChanges,
  TURN_CHANGES_RELAXED_LIMIT,
  TURN_CHANGES_VISIBLE_LIMIT,
  type TurnChangeStatus,
  type TurnChangedFile,
} from "../../../lib/turn-changed-files";
import { toolWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useAppStore } from "../../../stores/app-store";
import { disclosureKey, useAutomaticDisclosure } from "./disclosure";
import "../../../styles/turn-changes.css";

/* Same Git-style letters as the Review rows, so status never relies on color
   alone. `W` is an OMP whole-file write whose previous content is unknown. */
const STATUS_MARKS: Record<TurnChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  written: "W",
};

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null || deletions === null) return null;
  return (
    <span className="turn-changes-counts diff-counts" aria-hidden>
      {additions > 0 && <span className="diff-count-add">+{additions}</span>}
      {deletions > 0 && <span className="diff-count-del">−{deletions}</span>}
    </span>
  );
}

/**
 * The right-click actions of one changed-file row. Both act on the file's
 * current contents through the host resolver, so a deleted file offers neither,
 * and a file outside the session's allowed roots is reported, not opened.
 */
export function turnChangedFileMenuItems({
  t,
  file,
  nativeFilesAllowed,
  openFile,
  revealFile,
}: {
  t: TFunction;
  file: TurnChangedFile;
  nativeFilesAllowed: boolean;
  openFile: (path: string) => void;
  revealFile: (path: string) => void;
}): ContextMenuItem[] {
  const unavailable = !nativeFilesAllowed || file.status === "deleted";
  return [
    {
      id: "open-file",
      label: t("chat.turnChangesOpenFile"),
      icon: <IconFileText size={14} />,
      disabled: unavailable,
      onSelect: () => openFile(file.path),
    },
    {
      id: "reveal-file",
      label: t("chat.turnChangesRevealFile"),
      icon: <IconFolderOpen size={14} />,
      disabled: unavailable,
      onSelect: () => revealFile(file.path),
    },
  ];
}

/**
 * The read-only "what did this turn change" summary under a completed reply.
 * Each row opens the existing Review tab on that file's recorded changes; the
 * card has no diff body and no rollback of its own.
 */
export const TurnChangesCard = memo(function TurnChangesCard({
  turnId,
  tools,
}: {
  turnId: string;
  tools: readonly UiMessage[];
}) {
  const { t } = useTranslation();
  const openTab = useAppStore((state) => state.openWorkPanelTab);
  const root = useAppStore((state) => state.workspace?.path);
  const summary = useMemo(() => summarizeTurnChanges(tools), [tools]);
  const bodyId = useId();
  const disclosure = useAutomaticDisclosure(false, undefined, disclosureKey("turn-changes", turnId));
  const nativeFilesAllowed = useChatNativeFilesAllowed();
  const openFileRef = useOpenChatFileRef();
  const revealFileRef = useRevealChatFileRef();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const { files } = summary;
  if (files.length === 0) return null;

  const dense = files.length > TURN_CHANGES_RELAXED_LIMIT;
  const visible = files.slice(0, TURN_CHANGES_VISIBLE_LIMIT);
  const hidden = files.length - visible.length;
  const displayPath = (path: string) => toWorkspaceRel(path, root) ?? shortenPath(path);
  const shownPath = (file: TurnChangedFile) =>
    file.sourcePath && file.status === "renamed"
      ? `${displayPath(file.sourcePath)} → ${displayPath(file.path)}`
      : displayPath(file.path);

  const openReview = (reviewKeys: readonly string[], expand: boolean) => {
    requestReviewFocus(reviewKeys, { expand });
    openTab(toolWorkPanelTab("review"));
  };

  const rowLabel = (file: TurnChangedFile) => {
    const status = t(`panel.review.status.${file.status}`);
    const path = shownPath(file);
    const label = file.additions !== null && file.deletions !== null
      ? t("chat.turnChangesOpen", { status, path, additions: file.additions, deletions: file.deletions })
      : t("chat.turnChangesOpenNoCounts", { status, path });
    return file.rolledBack ? `${label} · ${t("panel.review.rolledBack")}` : label;
  };

  return (
    <section className="turn-changes-card" aria-label={t("chat.turnChangesLabel")}>
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
      <Button
        ref={disclosure.titleRef}
        type="button"
        variant="ghost"
        className="turn-changes-head"
        aria-expanded={disclosure.open}
        aria-controls={bodyId}
        onClick={disclosure.toggle}
      >
        <span className="turn-changes-chevron" aria-hidden>
          {disclosure.open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
        <span className="turn-changes-title">{t("chat.turnChangesTitle")}</span>
        <span className="turn-changes-meta">
          {t("chat.toolChipFiles", { count: files.length })}
          {dense ? ` · ${t("chat.turnChangesDirs", { count: summary.directoryCount })}` : null}
        </span>
        <span
          className="turn-changes-total"
          aria-label={t("chat.reviewChangeCounts", summary)}
        >
          <Counts additions={summary.additions} deletions={summary.deletions} />
        </span>
      </Button>
      <div ref={disclosure.bodyRef} id={bodyId} hidden={!disclosure.open} {...disclosure.bodyEvents}>
        <ul className={cx("turn-changes-body", dense && "is-dense")}>
          {visible.map((file) => {
            const label = rowLabel(file);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="turn-changes-row"
                  data-status={file.status}
                  data-rolled-back={file.rolledBack || undefined}
                  aria-label={label}
                  title={label}
                  onClick={() => openReview(file.reviewKeys, true)}
                  onContextMenu={(event) =>
                    openContextMenu(event, {
                      label: t("chat.turnChangesFileActions", { path: shownPath(file) }),
                      items: turnChangedFileMenuItems({
                        t,
                        file,
                        nativeFilesAllowed,
                        openFile: (path) => openFileRef(path, undefined, undefined, { exact: true }),
                        revealFile: (path) => revealFileRef(path, { exact: true }),
                      }),
                    })
                  }
                >
                  <span className="turn-changes-mark" aria-hidden>
                    {STATUS_MARKS[file.status]}
                  </span>
                  <span className="turn-changes-path">{shownPath(file)}</span>
                  <Counts additions={file.additions} deletions={file.deletions} />
                </button>
              </li>
            );
          })}
          {hidden > 0 ? (
            <li className="turn-changes-more">
              <span aria-hidden>···</span>
              {t("chat.turnChangesMore", { count: hidden })}
            </li>
          ) : null}
        </ul>
        {hidden > 0 ? (
          <div className="turn-changes-foot">
            <button
              type="button"
              className="turn-changes-view-all"
              onClick={() => openReview(files.flatMap((file) => file.reviewKeys), false)}
            >
              {t("chat.turnChangesViewAll", { count: files.length })}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
});
