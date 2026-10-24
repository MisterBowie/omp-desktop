import { useSyncExternalStore } from "react";
import type { UiMessage } from "@pi-desktop/shared";

/**
 * Transcript error cards the user closed during this app run.
 *
 * A closed card is a view preference, not a transcript edit: the row stays in
 * the store and the host, so turn-outcome checks and error de-duplication
 * still see the failure the user acknowledged. Keys live in memory only; a
 * renderer-local refusal row is never persisted and cannot come back, while a
 * durable error is shown again after a restart.
 *
 * A card is matched by its row id and by its failure signature (timestamp,
 * code and text). A live OMP row and the durable row a later transcript read
 * returns carry different ids but the same signature, so closing one closes
 * its twin; a new failure has a new timestamp and stays visible.
 */
const MAX_DISMISSED_ERRORS = 500;

let dismissed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dismissalKeys(message: UiMessage): string[] {
  const keys = [`id:${message.id}`];
  if (message.error) {
    keys.push(
      `failure:${message.createdAt}\u0000${message.error.code}\u0000${message.error.message}`,
    );
  }
  return keys;
}

/** The closed keys; a new set on every change, so it doubles as a snapshot. */
export function dismissedTranscriptErrors(): ReadonlySet<string> {
  return dismissed;
}

/** Hide one error card; the oldest closes fall out past the bound. */
export function dismissTranscriptError(message: UiMessage): void {
  const keys = dismissalKeys(message).filter((key) => !dismissed.has(key));
  if (!message.id || keys.length === 0) return;
  const next = [...dismissed, ...keys];
  dismissed = new Set(next.slice(-MAX_DISMISSED_ERRORS * 2));
  for (const listener of listeners) listener();
}

export function useDismissedTranscriptErrors(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    dismissedTranscriptErrors,
    dismissedTranscriptErrors,
  );
}

/**
 * Project the rows the transcript renders. A closed error that carried no
 * answer drops out; one attached to streamed text keeps the text and loses
 * only the card. The input array is returned unchanged when nothing applies.
 */
export function withoutDismissedErrors(
  messages: UiMessage[],
  closed: ReadonlySet<string>,
): UiMessage[] {
  if (closed.size === 0) return messages;
  let changed = false;
  const visible: UiMessage[] = [];
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !message.error ||
      !dismissalKeys(message).some((key) => closed.has(key))
    ) {
      visible.push(message);
      continue;
    }
    changed = true;
    if (message.content.trim() || (message.thinking ?? "").trim()) {
      const answer = { ...message };
      delete answer.error;
      visible.push(answer);
    }
  }
  return changed ? visible : messages;
}
