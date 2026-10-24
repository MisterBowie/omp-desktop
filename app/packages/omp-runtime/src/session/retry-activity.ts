/**
 * The desktop's `retrying` activity for one OMP `auto_retry_start` frame.
 *
 * OMP owns provider retries: after a failed attempt it announces the next one
 * with the attempt number, the backoff it is about to sleep, and the error it
 * is recovering from. The renderer already renders this phase for the Pi
 * runtime (ADR 0206) as a countdown, the attempt within the budget, and a
 * bounded error plate, so the OMP adapter only has to fill the same shape.
 */
import type { AgentActivity, AgentActivityError } from "@pi-desktop/shared";

export type RetryActivity = Extract<AgentActivity, { phase: "retrying" }>;

/** Error text kept on the activity; the full message stays in the transcript. */
const MAX_ERROR_MESSAGE_CHARS = 2000;

/** Parse one `auto_retry_start` frame; null when it carries no usable attempt. */
export function retryActivityFromFrame(frame: Record<string, unknown>, now: number): RetryActivity | null {
  const attempt = frame.attempt;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return null;
  const delayMs = frame.delayMs;
  const error = retryErrorOf(frame.errorMessage);
  return {
    phase: "retrying",
    since: now,
    attempt,
    ...(typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs >= 0
      ? { retryDelayMs: Math.round(delayMs) }
      : {}),
    ...(error ? { error } : {}),
  };
}

function retryErrorOf(value: unknown): AgentActivityError | null {
  if (typeof value !== "string") return null;
  const message = value.trim();
  if (!message) return null;
  // OMP's provider errors lead with the HTTP status ("503 No available …").
  const status = /^(\d{3})\b/.exec(message);
  const providerStatus = status ? Number(status[1]) : undefined;
  return {
    code: providerStatus === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_ERROR",
    message: message.length > MAX_ERROR_MESSAGE_CHARS
      ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : message,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
  };
}
