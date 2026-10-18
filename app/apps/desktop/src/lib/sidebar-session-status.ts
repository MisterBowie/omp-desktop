export type SidebarSessionStatus =
  | "running"
  | "selected"
  | "completed"
  | "failed"
  | "permission";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@pi-desktop/shared";

/** Summarize every session, including those hidden by the group's row limit. */
export function sidebarProjectActivity(
  sessions: readonly { id: string }[],
  running: Record<string, boolean>,
  pending: Record<string, readonly unknown[]>,
): "permission" | "running" | null {
  if (sessions.some(({ id }) => pending[id]?.length)) return "permission";
  return sessions.some(({ id }) => running[id]) ? "running" : null;
}

export function sidebarSessionStatus({
  running,
  selected,
  outcome,
  hasPendingPermission,
}: {
  running: boolean;
  selected: boolean;
  outcome?: "completed" | "failed";
  hasPendingPermission?: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  if (running) return "running";
  if (selected) return "selected";
  return outcome ?? null;
}
