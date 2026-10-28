import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionAbsoluteTime, formatSessionCompactAge } from "../src/lib/sidebar-session-date.ts";
import { sidebarProjectActivity } from "../src/lib/sidebar-session-status.ts";

test("compact session age steps at minute, hour, day and month boundaries", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const now = Date.UTC(2026, 9, 28, 12, 0, 0);
  const iso = (elapsedMs) => new Date(now - elapsedMs).toISOString();
  assert.equal(formatSessionCompactAge(iso(0), now), "1m");
  assert.equal(formatSessionCompactAge(iso(59 * MINUTE), now), "59m");
  assert.equal(formatSessionCompactAge(iso(60 * MINUTE), now), "1h");
  assert.equal(formatSessionCompactAge(iso(23 * HOUR), now), "23h");
  assert.equal(formatSessionCompactAge(iso(24 * HOUR), now), "1d");
  assert.equal(formatSessionCompactAge(iso(29 * DAY), now), "29d");
  assert.equal(formatSessionCompactAge(iso(30 * DAY), now), "1mo");
  assert.equal(formatSessionCompactAge(iso(-HOUR), now), "1m");
  assert.equal(formatSessionCompactAge("not a date", now), "");
  assert.equal(formatSessionCompactAge(undefined, now), "");
});
test("absolute session time handles invalid values and locale fallback", () => {
  assert.equal(formatSessionAbsoluteTime("not a date"), "");
  assert.equal(formatSessionAbsoluteTime(undefined), "");
  assert.ok(formatSessionAbsoluteTime(new Date(2026, 9, 28, 12, 0).toISOString(), "invalid_locale"));
});
test("project activity includes folded sessions and prefers pending permissions", () => {
  const sessions = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}` }));
  assert.equal(sidebarProjectActivity(sessions, { s14: true }, {}), "running");
  assert.equal(sidebarProjectActivity(sessions, { s14: true }, { s12: [{}] }), "permission");
  assert.equal(sidebarProjectActivity(sessions, { other: true }, {}), null);
});
