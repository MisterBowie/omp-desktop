export const BUS_TOPIC_MAX_LENGTH = 128;
export const BUS_TOPIC_MAX_SEGMENTS = 8;

const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** A concrete topic: dot-separated segments, no wildcards. */
export function isValidBusTopic(topic: string): boolean {
  if (!topic || topic.length > BUS_TOPIC_MAX_LENGTH) return false;
  const segments = topic.split(".");
  if (segments.length > BUS_TOPIC_MAX_SEGMENTS) return false;
  return segments.every((segment) => SEGMENT.test(segment));
}

/**
 * A subscription pattern. `*` matches exactly one segment; `**` matches one or
 * more trailing segments and is only allowed as the final segment.
 */
export function isValidBusTopicPattern(pattern: string): boolean {
  if (!pattern || pattern.length > BUS_TOPIC_MAX_LENGTH) return false;
  const segments = pattern.split(".");
  if (segments.length > BUS_TOPIC_MAX_SEGMENTS) return false;
  return segments.every((segment, index) => {
    if (segment === "*") return true;
    if (segment === "**") return index === segments.length - 1;
    return SEGMENT.test(segment);
  });
}

/** Test a concrete topic against a subscription (or declaration) pattern. */
export function matchesBusTopic(pattern: string, topic: string): boolean {
  if (!isValidBusTopicPattern(pattern) || !isValidBusTopic(topic)) return false;
  const patternSegments = pattern.split(".");
  const topicSegments = topic.split(".");
  for (let i = 0; i < patternSegments.length; i += 1) {
    const expected = patternSegments[i];
    if (expected === "**") return topicSegments.length > i;
    const actual = topicSegments[i];
    if (actual === undefined) return false;
    if (expected === "*") continue;
    if (expected !== actual) return false;
  }
  return topicSegments.length === patternSegments.length;
}

/** True when any declared pattern covers the topic. */
export function busTopicAllowed(patterns: string[] | undefined, topic: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesBusTopic(pattern, topic));
}
