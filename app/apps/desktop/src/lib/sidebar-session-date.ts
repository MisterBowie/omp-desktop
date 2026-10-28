const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_DAYS = 30;

/**
 * Compact time since a session's last activity: `1m`…`59m`, `1h`…`23h`,
 * `1d`…`29d`, then `1mo`. Under a minute reads `1m`; a future timestamp clamps
 * to now; an unparseable timestamp yields "".
 */
export function formatSessionCompactAge(value: string | undefined, now = Date.now()): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(elapsed / HOUR_MS);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days < MONTH_DAYS) return `${days}d`;
  return `${Math.floor(days / MONTH_DAYS)}mo`;
}

/** Absolute local date-time for hover and assistive labels; "" when unparseable. */
export function formatSessionAbsoluteTime(value: string | undefined, locale?: string): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "";
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat(locale, options).format(timestamp);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(timestamp);
  }
}
