import { useTranslation } from "react-i18next";
import type { SessionMessageOrigin as SessionMessageOriginData } from "@pi-desktop/shared";
import { IconBranch } from "../../../components/icons";
import { useAppStore } from "../../../stores/app-store";

export function SessionMessageOrigin({ origin }: { origin: SessionMessageOriginData }) {
  const { t } = useTranslation();
  const selectSession = useAppStore((state) => state.selectSession);
  const showToast = useAppStore((state) => state.showToast);
  const name = origin.sourceTitle || origin.sourceSessionId;
  const kindKey = origin.kind === "task" ? "sessionCollaboration.taskMessage"
    : origin.kind === "completion" ? "sessionCollaboration.completionMessage" : "sessionCollaboration.agentMessage";

  return (
    <div className="session-message-origin" data-session-message-kind={origin.kind}>
      <span className="session-message-kind"><IconBranch size={13} aria-hidden />{t(kindKey)}</span>
      <button
        type="button"
        className="session-message-source"
        aria-label={t("sessionCollaboration.openSource", { name })}
        onClick={() => {
          void selectSession(origin.sourceSessionId).catch((error: unknown) => {
            showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
          });
        }}
      >
        {t("sessionCollaboration.receivedFrom", { name })}
      </button>
      <code className="session-message-session-id">{origin.sourceSessionId}</code>
    </div>
  );
}
