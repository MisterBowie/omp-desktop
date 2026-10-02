/**
 * The turn-fence wire contract (M5/T20-B1 second repair).
 *
 * The runner's handshake and the gate's acknowledgment both rest on these
 * helpers: a wrong token must never compare equal, and only the exact
 * acknowledgment descriptor may settle a fence — an ordinary user
 * notification or a start-refusal descriptor must not.
 */
import { describe, expect, it } from "vitest";

import {
  encodeStartRefusal,
  OMP_START_REFUSAL_KIND,
  OMP_START_REFUSAL_VERSION,
} from "./start-refusal.js";
import { admissionDigest, encodeTurnAdmission } from "./turn-admission.js";
import {
  encodeTurnAck,
  isTurnToken,
  mintTurnToken,
  OMP_TURN_ACK_KIND,
  OMP_TURN_ACK_VERSION,
  OMP_TURN_COMMAND,
  parseTurnAckNotice,
  parseTurnCommand,
  turnCommandMessage,
  turnCommandToken,
} from "./turn-fence.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function notice(message: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "extension_ui_request", id: "ui-1", method: "notify", message, ...overrides };
}

describe("turn tokens", () => {
  it("mints unique 32-hex tokens", () => {
    const tokens = new Set([mintTurnToken(), mintTurnToken(), mintTurnToken()]);
    expect(tokens.size).toBe(3);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(isTurnToken(token)).toBe(true);
    }
  });

  it("accepts exactly a lowercase 32-hex string", () => {
    for (const value of [TOKEN, "f".repeat(32), "0".repeat(32)]) {
      expect(isTurnToken(value)).toBe(true);
    }
    for (const value of [
      TOKEN.toUpperCase(),
      TOKEN.slice(0, 31),
      `${TOKEN}0`,
      ` ${TOKEN}`,
      `${TOKEN} `,
      "not-a-token",
      "",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isTurnToken(value)).toBe(false);
    }
  });

  it("round-trips the handshake message and rejects every near miss", () => {
    expect(turnCommandToken(turnCommandMessage(TOKEN))).toBe(TOKEN);
    expect(turnCommandMessage(TOKEN)).toBe(`/${OMP_TURN_COMMAND} ${TOKEN}`);
    expect(parseTurnCommand(turnCommandMessage(TOKEN))).toEqual({ token: TOKEN, admission: null });
    for (const message of [
      `/${OMP_TURN_COMMAND}`,
      `/${OMP_TURN_COMMAND} `,
      `/${OMP_TURN_COMMAND}  ${TOKEN}`,
      `/${OMP_TURN_COMMAND} ${TOKEN.toUpperCase()}`,
      `/${OMP_TURN_COMMAND}-other ${TOKEN}`,
      `/other-command ${TOKEN}`,
      `${OMP_TURN_COMMAND} ${TOKEN}`,
      TOKEN,
      "",
      42,
      null,
      undefined,
    ]) {
      expect(turnCommandToken(message)).toBeNull();
    }
  });

  it("carries the encoded admission verbatim after the token, and never a malformed argument", () => {
    const admission = encodeTurnAdmission({
      v: 1,
      nativeSessionId: "native-1",
      mode: "plan",
      permissionMode: "ask",
      hostTools: [],
      grants: ["bash"],
    });
    const message = turnCommandMessage(TOKEN, admission);
    expect(message).toBe(`/${OMP_TURN_COMMAND} ${TOKEN} ${admission}`);
    expect(parseTurnCommand(message)).toEqual({ token: TOKEN, admission });
    // The argument is one whitespace-free base64url word: an embedded space or
    // empty tail is a malformed handshake, never a token with an ignored rest.
    // (A garbled single word is well-formed *shape* — the codec rejects it, not
    // the fence parser.)
    for (const near of [
      `/${OMP_TURN_COMMAND} ${TOKEN} `,
      `/${OMP_TURN_COMMAND} ${TOKEN} ${admission} extra`,
    ]) {
      expect(parseTurnCommand(near)).toBeNull();
    }
    expect(admissionDigest(admission)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("turn acknowledgment", () => {
  it("round-trips exactly the descriptor the gate writes", () => {
    expect(parseTurnAckNotice(notice(encodeTurnAck(TOKEN)))).toEqual({
      v: OMP_TURN_ACK_VERSION,
      kind: OMP_TURN_ACK_KIND,
      token: TOKEN,
      admissionDigest: null,
    });
    const digest = "a".repeat(64);
    expect(parseTurnAckNotice(notice(encodeTurnAck(TOKEN, digest)))).toEqual({
      v: OMP_TURN_ACK_VERSION,
      kind: OMP_TURN_ACK_KIND,
      token: TOKEN,
      admissionDigest: digest,
    });
  });

  it("rejects every frame that is not this exact acknowledgment", () => {
    const ack = encodeTurnAck(TOKEN);
    const cases: unknown[] = [
      null,
      undefined,
      42,
      "notify",
      { type: "extension_ui_request", id: "ui", method: "notify" },
      { type: "extension_ui_request", id: "ui", method: "select", message: ack },
      { type: "extension_ui_request", id: "ui", method: "notify", message: "hello from a plugin" },
      { type: "extension_ui_request", id: "ui", method: "notify", message: "{not json" },
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: "something-else", token: TOKEN, admissionDigest: null })),
      notice(JSON.stringify({ v: 3, kind: OMP_TURN_ACK_KIND, token: TOKEN, admissionDigest: null })),
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND })),
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: "nope", admissionDigest: null })),
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: TOKEN.toUpperCase(), admissionDigest: null })),
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: 42, admissionDigest: null })),
      notice(JSON.stringify([{ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: TOKEN }])),
      notice(JSON.stringify(null)),
      notice("x".repeat(9000)),
      // v1 (no digest) no longer parses: an unbound acknowledgment must not
      // arm a prompt against a policy nobody installed.
      notice(JSON.stringify({ v: 1, kind: OMP_TURN_ACK_KIND, token: TOKEN })),
      // A malformed digest is a malformed acknowledgment, never "no digest".
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: TOKEN, admissionDigest: "nope" })),
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: TOKEN, admissionDigest: "a".repeat(63) })),
      notice(JSON.stringify({ v: OMP_TURN_ACK_VERSION, kind: OMP_TURN_ACK_KIND, token: TOKEN, admissionDigest: "A".repeat(64) })),
    ];
    for (const frame of cases) {
      expect(parseTurnAckNotice(frame)).toBeNull();
    }
  });

  it("never confuses a start-refusal descriptor with an acknowledgment", () => {
    const refusalMessage = encodeStartRefusal({
      v: OMP_START_REFUSAL_VERSION,
      kind: OMP_START_REFUSAL_KIND,
      sessionId: "native-1",
      turnToken: TOKEN,
      code: "state-missing",
      reason: "missing",
      refusalId: "refusal-1",
      at: 1_700_000_000_000,
    });
    expect(parseTurnAckNotice(notice(refusalMessage))).toBeNull();
    // And the acknowledgment is not a refusal either — the refusal parser is
    // exercised in `start-refusal.test.ts`, so here only the reverse direction
    // of the cross-parser isolation is asserted.
    expect(parseTurnAckNotice({ ...notice(encodeTurnAck(TOKEN)), method: "notify" })).not.toBeNull();
  });
});
