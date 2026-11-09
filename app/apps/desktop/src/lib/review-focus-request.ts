import { useSyncExternalStore } from "react";

/**
 * A one-shot "show these recorded changes" request from the transcript's
 * per-turn change summary to the Review tab. Review row keys (a PI snapshot id
 * or an OMP message/file key) are unique per change, so the request needs no
 * session key: a Review tab that does not hold the keys simply ignores it.
 * Kept out of the app store because it is transient UI intent, not session or
 * panel state.
 */
export type ReviewFocusRequest = {
  /** Scrolled into view in order; the first one found becomes the anchor. */
  reviewKeys: readonly string[];
  /** Open each named change's diff, or only reveal the rows. */
  expand: boolean;
  seq: number;
};

let current: ReviewFocusRequest | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

export function requestReviewFocus(
  reviewKeys: readonly string[],
  { expand }: { expand: boolean },
): void {
  if (reviewKeys.length === 0) return;
  sequence += 1;
  current = { reviewKeys: [...reviewKeys], expand, seq: sequence };
  for (const listener of listeners) listener();
}

export function currentReviewFocusRequest(): ReviewFocusRequest | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReviewFocusRequest(): ReviewFocusRequest | null {
  return useSyncExternalStore(subscribe, currentReviewFocusRequest, () => null);
}
