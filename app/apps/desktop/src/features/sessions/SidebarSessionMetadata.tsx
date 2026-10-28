import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatSessionAbsoluteTime, formatSessionCompactAge } from "../../lib/sidebar-session-date";
import { IconCopy } from "../../components/icons";

export function SidebarSessionDate({ updatedAt }: { updatedAt?: string }) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const text = formatSessionCompactAge(updatedAt, now);
  if (!text) return null;
  const absolute = formatSessionAbsoluteTime(updatedAt, i18n.resolvedLanguage ?? i18n.language);
  return <time className="thread-item-date" dateTime={updatedAt} title={absolute}
    aria-label={t("nav.lastReplyDate", { date: absolute })}>{text}</time>;
}

export function SessionCopyActions({ onCopy, projectPath }: { onCopy: (kind: "title" | "projectPath" | "id") => void; projectPath?: string }) {
  const { t } = useTranslation();
  return <>{(["title", "projectPath", "id"] as const).filter((kind) => kind !== "projectPath" || projectPath?.trim()).map((kind) => (
    <button key={kind} type="button" role="menuitem" data-action={`copy-session-${kind}`} onClick={() => onCopy(kind)}>
      <IconCopy size={14} />{t(`nav.copySession.${kind}`)}
    </button>
  ))}</>;
}
