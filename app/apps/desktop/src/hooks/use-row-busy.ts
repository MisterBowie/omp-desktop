import { useCallback, useRef, useState } from "react";

/**
 * Busy tracking for list rows. Each row is identified by its key, so one row's
 * pending action neither blocks nor relabels another row, while a second action
 * on the same row is refused until the first one settles.
 *
 * `begin` reads a ref rather than the rendered state: two actions fired in the
 * same tick would both see the stale set and both start otherwise.
 */
export function useRowBusy() {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Set<string>());

  /** Marks the row busy. Returns false when that row already has an action in flight. */
  const begin = useCallback((key: string): boolean => {
    if (pending.current.has(key)) return false;
    pending.current.add(key);
    setBusyKeys(new Set(pending.current));
    return true;
  }, []);

  const end = useCallback((key: string) => {
    if (!pending.current.delete(key)) return;
    setBusyKeys(new Set(pending.current));
  }, []);

  return { busyKeys, begin, end };
}
