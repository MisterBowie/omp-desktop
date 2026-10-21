const DAY_MS = 86_400_000;

/** Use calendar days so DST and a late-night reply do not change the label. */
export function formatSessionLastReplyDate(value: string | undefined, now = new Date(), locale?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / DAY_MS);
  try {
    return days >= 0 && days <= 7
      ? new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-days, "day")
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
  } catch { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date); }
}
