import type { AskToolRequest } from "@pi-desktop/shared";

export type PendingAsk = AskToolRequest;
export type AskQueues = Record<string, PendingAsk[]>;

function withQueue(queues: AskQueues, sessionId: string, queue: PendingAsk[]): AskQueues {
  const next = { ...queues };
  if (queue.length === 0) delete next[sessionId];
  else next[sessionId] = queue;
  return next;
}

export function enqueueAsk(queues: AskQueues, request: PendingAsk): AskQueues {
  const queue = queues[request.sessionId] ?? [];
  if (queue.some((entry) => entry.requestId === request.requestId)) return queues;
  return withQueue(queues, request.sessionId, [...queue, request]);
}

export function headAsk(queues: AskQueues, sessionId?: string): PendingAsk | undefined {
  return sessionId ? queues[sessionId]?.[0] : undefined;
}

export function queuedAskCount(queues: AskQueues, sessionId?: string): number {
  return Math.max(0, (sessionId ? (queues[sessionId]?.length ?? 0) : 0) - 1);
}

export function removeAsk(
  queues: AskQueues,
  sessionId: string,
  requestId: string,
): AskQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((entry) => entry.requestId !== requestId);
  return remaining.length === queue.length
    ? queues
    : withQueue(queues, sessionId, remaining);
}

export function removeAskForToolCall(
  queues: AskQueues,
  sessionId: string,
  toolCallId: string,
): AskQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((entry) => entry.toolCallId !== toolCallId);
  return remaining.length === queue.length
    ? queues
    : withQueue(queues, sessionId, remaining);
}

export function clearSessionAsks(queues: AskQueues, sessionId: string): AskQueues {
  if (!queues[sessionId]) return queues;
  const next = { ...queues };
  delete next[sessionId];
  return next;
}
