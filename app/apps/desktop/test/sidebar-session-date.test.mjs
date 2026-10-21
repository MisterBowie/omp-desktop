import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionLastReplyDate } from "../src/lib/sidebar-session-date.ts";
import { sidebarProjectActivity } from "../src/lib/sidebar-session-status.ts";

test("session date uses local calendar days, handles invalid values and locale fallback", () => {
  const now = new Date(2026, 9, 18, 0, 5);
  assert.match(formatSessionLastReplyDate(new Date(2026, 9, 17, 23, 59).toISOString(), now, "en"), /1 day ago/);
  assert.match(formatSessionLastReplyDate(now.toISOString(), now, "en"), /0 days ago/);
  assert.equal(formatSessionLastReplyDate("not a date", now), "");
  assert.equal(formatSessionLastReplyDate(undefined, now), "");
  assert.match(formatSessionLastReplyDate("2020-01-01", now, "en"), /2020/);
  assert.ok(formatSessionLastReplyDate(now.toISOString(), now, "invalid_locale"));
});
test("project activity includes folded sessions and prefers pending permissions", () => {
  const sessions = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}` }));
  assert.equal(sidebarProjectActivity(sessions, { s14: true }, {}), "running");
  assert.equal(sidebarProjectActivity(sessions, { s14: true }, { s12: [{}] }), "permission");
  assert.equal(sidebarProjectActivity(sessions, { other: true }, {}), null);
});
