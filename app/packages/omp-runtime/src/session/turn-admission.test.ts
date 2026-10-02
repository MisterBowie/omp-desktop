/**
 * The turn-admission codec (M5/T20-C review repair).
 *
 * This payload is the *policy* half of the desktop's per-prompt state: the
 * gate decides every call of the turn from it, so a partial, out-of-schema,
 * over-long or garbled payload must decode to `null` rather than become a
 * policy. The encoded form rides a runtime prompt message, so the ceiling is
 * enforced before anything is sent.
 */
import { describe, expect, it } from "vitest";

import {
  admissionDigest,
  decodeTurnAdmission,
  encodeTurnAdmission,
  MAX_TURN_ADMISSION_CHARS,
  MAX_TURN_ADMISSION_GRANTS,
  OMP_TURN_ADMISSION_VERSION,
  type OmpTurnAdmission,
} from "./turn-admission.js";

function admission(overrides: Partial<OmpTurnAdmission> = {}): OmpTurnAdmission {
  return {
    v: OMP_TURN_ADMISSION_VERSION,
    nativeSessionId: "native-1",
    mode: "plan",
    permissionMode: "ask",
    hostTools: [
      { name: "plugin_demo_run", risk: "low", planSafeActions: ["inspect"], origin: "plugin" },
      { name: "mcp_alpha_lookup", risk: "low", planSafeActions: [], origin: "user-mcp" },
    ],
    grants: ["bash"],
    ...overrides,
  };
}

/** The wire record one valid payload encodes to. */
const BASE_RECORD = {
  v: OMP_TURN_ADMISSION_VERSION,
  nativeSessionId: "native-1",
  mode: "plan",
  permissionMode: "ask",
  hostTools: [{ name: "plugin_demo_run", risk: "low", planSafeActions: ["inspect"], origin: "plugin" }],
  grants: ["bash"],
};

/** Re-encode one mutation of a valid payload, the way a defect would ship it. */
function mutated(mutate: (record: Record<string, unknown>) => void): string {
  const record = structuredClone(BASE_RECORD) as Record<string, unknown>;
  mutate(record);
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
}

describe("turn admission codec", () => {
  it("round-trips a full admission byte-for-byte", () => {
    const value = admission();
    const encoded = encodeTurnAdmission(value);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTurnAdmission(encoded)).toEqual(value);
  });

  it("decodes only this version with the complete, consistent field set", () => {
    for (const candidate of [
      undefined,
      null,
      42,
      "",
      "not-base64-json",
      Buffer.from("{", "utf8").toString("base64url"),
      "x".repeat(MAX_TURN_ADMISSION_CHARS + 1),
      mutated((record) => {
        delete record.v;
      }),
      mutated((record) => {
        record.v = 2;
      }),
      mutated((record) => {
        record.nativeSessionId = "";
      }),
      mutated((record) => {
        record.nativeSessionId = 42;
      }),
      mutated((record) => {
        record.mode = "chat";
      }),
      mutated((record) => {
        record.permissionMode = "inherit";
      }),
      mutated((record) => {
        record.hostTools = "none";
      }),
      // A user-MCP entry may not declare plan-safe actions (the state schema
      // refuses that shape; the admission reuses the same validator).
      mutated((record) => {
        record.hostTools = [{ name: "mcp_a", risk: "low", planSafeActions: ["run"], origin: "user-mcp" }];
      }),
      mutated((record) => {
        record.hostTools = [
          { name: "plugin_x", risk: "low", planSafeActions: [], origin: "plugin" },
          { name: "plugin_x", risk: "low", planSafeActions: [], origin: "plugin" },
        ];
      }),
      mutated((record) => {
        record.grants = ["bash", 42];
      }),
      mutated((record) => {
        record.grants = ["bash", "bash"];
      }),
      mutated((record) => {
        record.grants = Array.from({ length: MAX_TURN_ADMISSION_GRANTS + 1 }, (_, index) => `tool_${index}`);
      }),
    ]) {
      expect(decodeTurnAdmission(candidate)).toBeNull();
    }
  });

  it("accepts an empty grant list and an empty host-tool table", () => {
    const empty = admission({ hostTools: [], grants: [] });
    expect(decodeTurnAdmission(encodeTurnAdmission(empty))).toEqual(empty);
  });

  it("refuses to encode an admission past the handshake ceiling", () => {
    const huge = admission({
      hostTools: Array.from({ length: 1024 }, (_, index) => ({
        name: `plugin_${index}_${"y".repeat(400)}`,
        risk: "medium" as const,
        planSafeActions: [],
        origin: "plugin" as const,
      })),
    });
    expect(() => encodeTurnAdmission(huge)).toThrow(/ceiling/);
  });

  it("digests the exact encoded argument", () => {
    const first = encodeTurnAdmission(admission());
    const second = encodeTurnAdmission(admission({ grants: [] }));
    expect(admissionDigest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(admissionDigest(first)).toBe(admissionDigest(first));
    expect(admissionDigest(first)).not.toBe(admissionDigest(second));
  });
});
