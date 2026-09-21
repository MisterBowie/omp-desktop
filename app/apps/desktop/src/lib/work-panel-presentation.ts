export async function commitWorkPanelPresentation({
  reservation,
  isCurrent,
  commit,
}: {
  reservation: Promise<unknown>;
  isCurrent: () => boolean;
  commit: () => void;
}): Promise<boolean> {
  try {
    await reservation;
  } catch {
    return false;
  }

  if (!isCurrent()) return false;
  commit();
  return true;
}
