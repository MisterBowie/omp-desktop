/** Controlled release stages; adding another stage requires its own gates. */
export function testReleaseMilestone(tag) {
  const match = typeof tag === "string" && tag.match(/^m([56])-test-[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (!match) {
    const error = new Error(`expected a controlled m5-test-* or m6-test-* tag, got ${String(tag)}`);
    error.exitCode = 2;
    throw error;
  }
  return Number(match[1]);
}
