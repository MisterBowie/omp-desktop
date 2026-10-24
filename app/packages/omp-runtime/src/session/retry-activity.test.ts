import { describe, expect, it } from "vitest";

import { retryActivityFromFrame } from "./retry-activity.js";

describe("retryActivityFromFrame", () => {
  it("maps an OMP retry announcement onto the renderer's retrying phase", () => {
    expect(retryActivityFromFrame({
      type: "auto_retry_start",
      attempt: 3,
      maxAttempts: 10,
      delayMs: 7755.23,
      errorMessage: "503 No available accounts: no available accounts",
    }, 1000)).toEqual({
      phase: "retrying",
      since: 1000,
      attempt: 3,
      retryDelayMs: 7755,
      error: { code: "PROVIDER_ERROR", message: "503 No available accounts: no available accounts", providerStatus: 503 },
    });
  });

  it("names a 429 as rate limiting and leaves an unnumbered error without a status", () => {
    expect(retryActivityFromFrame({ attempt: 1, errorMessage: "429 Too many requests" }, 0)?.error)
      .toEqual({ code: "PROVIDER_RATE_LIMITED", message: "429 Too many requests", providerStatus: 429 });
    expect(retryActivityFromFrame({ attempt: 1, errorMessage: "socket hang up" }, 0)?.error)
      .toEqual({ code: "PROVIDER_ERROR", message: "socket hang up" });
  });

  it("bounds the error text and drops unusable fields", () => {
    const activity = retryActivityFromFrame({ attempt: 2, delayMs: -1, errorMessage: `500 ${"x".repeat(5000)}` }, 0);
    expect(activity?.retryDelayMs).toBeUndefined();
    expect(activity?.error?.message.length).toBe(2001);
    expect(retryActivityFromFrame({ attempt: 2, errorMessage: "  " }, 0)).toEqual({ phase: "retrying", since: 0, attempt: 2 });
    expect(retryActivityFromFrame({ attempt: 0 }, 0)).toBeNull();
    expect(retryActivityFromFrame({ attempt: "1" }, 0)).toBeNull();
  });
});
