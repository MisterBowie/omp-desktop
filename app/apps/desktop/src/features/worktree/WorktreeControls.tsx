import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary, WorktreeProbeResult } from "@pi-desktop/shared";
import { IconBranch, IconFolder, IconRefresh } from "../../components/icons";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { createIsolatedSession, syncIsolatedSession, worktreeErrorMessage } from "./worktree-actions";
import { WorktreeMergeDialog } from "./WorktreeMergeDialog";
import { useWorktreeUi } from "./worktree-ui-store";
export function WorktreeProjectAction({ projectPath, onDone }: {
    projectPath: string;
    onDone: () => void;
}) {
    const { t } = useTranslation();
    const [probe, setProbe] = useState<{
        path: string;
        result: WorktreeProbeResult;
    } | null>(null);
    useEffect(() => {
        let current = true;
        void api.probeWorktree(projectPath).then((result) => {
            if (current)
                setProbe({ path: projectPath, result });
        }).catch((error) => {
            if (current)
                setProbe({ path: projectPath, result: { available: false, errorCode: "WORKTREE_GIT_FAILED", message: String(error) } });
        });
        return () => { current = false; };
    }, [projectPath]);
    const result = probe?.path === projectPath ? probe.result : null;
    return <button type="button" role="menuitem" data-action="new-isolated-session" disabled={!result?.available} title={result && !result.available ? worktreeErrorMessage({ code: result.errorCode, message: result.message }, t) : undefined} onClick={() => { onDone(); void createIsolatedSession(projectPath, t); }}>
    <IconBranch size={14}/>{t("worktree.newIsolatedSession")}
  </button>;
}
export function WorktreeBadge({ session }: {
    session: SessionSummary;
}) {
    const { t } = useTranslation();
    if (!session.worktree)
        return null;
    const status = session.worktree.status;
    return <span className="thread-item-worktree" data-worktree-status={status} title={t("worktree.badge.title", { branch: session.worktree.branch })}>
    <IconBranch size={11}/>{t(status === "missing" ? "worktree.badge.missing" : status === "conflict" ? "worktree.badge.conflict" : "worktree.badge.isolated")}
  </span>;
}
export function WorktreeSessionActions({ session, running, onDone }: {
    session: SessionSummary;
    running: boolean;
    onDone: () => void;
}) {
    const { t } = useTranslation();
    if (!session.worktree)
        return null;
    const disabled = running || session.worktree.status === "missing" || session.worktree.status === "creating";
    return <>
    <button type="button" role="menuitem" data-action="worktree-merge" disabled={disabled} onClick={() => {
            onDone();
            useWorktreeUi.getState().open({ kind: "merge", sessionId: session.id, title: session.title });
        }}><IconBranch size={14}/>{t("worktree.merge.menu")}</button>
    <button type="button" role="menuitem" data-action="worktree-sync" disabled={disabled || session.worktree.status === "conflict"} onClick={() => {
            onDone();
            void syncIsolatedSession(session.id, t);
        }}><IconRefresh size={14}/>{t("worktree.sync.menu")}</button>
    <button type="button" role="menuitem" data-action="worktree-reveal" disabled={session.worktree.status === "missing"} onClick={() => {
            onDone();
            void api.revealWorktree(session.id).catch((error) => useAppStore.getState().showToast(worktreeErrorMessage(error, t), { variant: "error" }));
        }}><IconFolder size={14}/>{t("worktree.reveal")}</button>
  </>;
}
export function WorktreeDialogs() {
    const dialog = useWorktreeUi((s) => s.dialog);
    const close = useWorktreeUi((s) => s.close);
    return dialog?.kind === "merge" ? <WorktreeMergeDialog key={dialog.sessionId} sessionId={dialog.sessionId} title={dialog.title} onClose={close}/> : null;
}
