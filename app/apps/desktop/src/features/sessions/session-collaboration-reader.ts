import type { SessionCollaborationSummary } from "@pi-desktop/shared";

/** A visible card refreshes this often; an idle one only checks back later. */
const REFRESH_MS = 4_000;
const IDLE_MS = 10_000;
/** Beyond this the read is already too slow to keep claiming a live status. */
const SLOW_READ_MS = 5_000;
/** A read that never settles is abandoned here so the card cannot freeze. */
const HARD_READ_MS = 15_000;

/**
 * One card owns one serial read loop. Disposal never schedules another read, and
 * an abandoned read (deadline or disposal) can never report its late outcome.
 */
export function observeSessionCollaboration({
  sessionId,
  read,
  onSummary,
  onUnavailable,
  isVisible = () => true,
}: {
  sessionId: string;
  read: (sessionId: string) => Promise<SessionCollaborationSummary>;
  onSummary: (summary: SessionCollaborationSummary) => void;
  onUnavailable: () => void;
  isVisible?: () => boolean;
}) {
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !disposed && isVisible();

  const schedule = (delay: number) => {
    if (disposed) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, delay);
  };

  const clearReadTimers = () => {
    clearTimeout(slowTimer);
    clearTimeout(hardTimer);
    slowTimer = undefined;
    hardTimer = undefined;
  };

  const refresh = async () => {
    if (disposed) return;
    // A hidden or detached card keeps its loop alive at the idle interval, so a
    // later focus or visibility change is picked up without polling hot.
    if (!active()) {
      schedule(IDLE_MS);
      return;
    }
    // One iteration owns exactly one outcome. `settled` makes every late result
    // of an abandoned iteration a no-op instead of an overlapping read.
    let settled = false;
    let reportedUnavailable = false;
    const reportUnavailable = () => {
      if (reportedUnavailable || !active()) return;
      reportedUnavailable = true;
      onUnavailable();
    };
    const settle = () => {
      settled = true;
      clearReadTimers();
      schedule(active() ? REFRESH_MS : IDLE_MS);
    };
    slowTimer = setTimeout(reportUnavailable, SLOW_READ_MS);
    hardTimer = setTimeout(() => {
      if (settled) return;
      settle();
      reportUnavailable();
    }, HARD_READ_MS);
    try {
      const summary = await read(sessionId);
      if (settled) return;
      if (!active()) {
        settle();
        return;
      }
      if (summary.sessionId === sessionId) onSummary(summary);
      else reportUnavailable();
      settle();
    } catch {
      if (settled) return;
      reportUnavailable();
      settle();
    }
  };

  void refresh();
  return () => {
    disposed = true;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    clearReadTimers();
  };
}
