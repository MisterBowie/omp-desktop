/**
 * The structured start-refusal wire contract.
 *
 * The desktop gate's `notify` message and the runner's attribution both rest
 * on this parser: it must accept exactly the descriptor this build writes and
 * nothing else — a user notification, a half-written message or a descriptor
 * of another kind/version would otherwise be able to close a turn.
 */
import { describe, expect, it } from "vitest";

import {
  encodeStartRefusal,
  OMP_START_REFUSAL_CODES,
  OMP_START_REFUSAL_KIND,
  OMP_START_REFUSAL_VERSION,
  parseStartRefusalNotice,
  type OmpStartRefusal,
} from "./start-refusal.js";

const refusal: OmpStartRefusal = {
  v: OMP_START_REFUSAL_VERSION,
  kind: OMP_START_REFUSAL_KIND,
  sessionId: "native-1",
  code: "state-missing",
  reason: "the desktop runtime state for this session is missing or unreadable",
  refusalId: "refusal-1",
  at: 1_700_000_000_000,
};

function notice(message: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "extension_ui_request", id: "ui-1", method: "notify", message, ...overrides };
}

/** The wire JSON with one field replaced — bypassing the typed builder on purpose. */
function wire(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...refusal, ...overrides });
}

describe("start refusal wire contract", () => {
  it("round-trips exactly what the gate writes, over the notify frame", () => {
    expect(parseStartRefusalNotice(notice(encodeStartRefusal(refusal)))).toEqual(refusal);
    // A null session id is valid on the wire (the runner then refuses to
    // attribute it) and every refusal code is accepted.
    for (const code of OMP_START_REFUSAL_CODES) {
      const decoded = parseStartRefusalNotice(notice(wire({ code })));
      expect(decoded?.code).toBe(code);
    }
    expect(parseStartRefusalNotice(notice(wire({ sessionId: null })))?.sessionId).toBeNull();
  });

  it("rejects every frame that is not this exact descriptor", () => {
    const cases: unknown[] = [
      null,
      undefined,
      42,
      "notify",
      { type: "extension_ui_request", id: "ui", method: "notify" },
      { type: "extension_ui_request", id: "ui", method: "select", message: encodeStartRefusal(refusal) },
      { type: "extension_ui_request", id: "ui", method: "notify", message: "hello from a plugin" },
      { type: "extension_ui_request", id: "ui", method: "notify", message: "{not json" },
      notice(wire({ kind: "something-else" })),
      notice(wire({ v: 2 })),
      notice(wire({ code: "who-knows" })),
      notice(wire({ sessionId: 42 })),
      notice(wire({ sessionId: "" })),
      notice(wire({ reason: "" })),
      notice(wire({ reason: "x".repeat(2001) })),
      notice(wire({ refusalId: "" })),
      notice(wire({ at: "soon" })),
      notice(JSON.stringify([refusal])),
      notice(JSON.stringify(null)),
      notice("x".repeat(9000)),
    ];
    for (const frame of cases) {
      expect(parseStartRefusalNotice(frame)).toBeNull();
    }
  });

  it("leaves ordinary notifications to the UI-request path", () => {
    expect(parseStartRefusalNotice(notice("build finished"))).toBeNull();
    expect(parseStartRefusalNotice(notice('{"v":1,"kind":"omp-desktop-approval"}'))).toBeNull();
  });
});
