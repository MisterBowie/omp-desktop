import { describe, expect, it } from "vitest";

import { ErrorCodes } from "./errors.js";
import {
  DEFAULT_ENGINE_ID,
  ENGINE_ADAPTER_VERSION,
  ENGINE_CAPABILITY_KEYS,
  ENGINE_CAPABILITIES,
  ENGINE_IDS,
  OMP_ENGINE_CAPABILITIES,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_PROTOCOL_VERSION,
  OMP_RUNTIME_VERSION,
  PI_ENGINE_CAPABILITIES,
  closedEngineCapabilities,
  engineCapabilities,
  engineCapabilityRefusal,
  engineSupports,
  isEngineId,
  isSessionEngineRef,
  liveEngineCapabilities,
  normalizeEngineId,
  sessionEngineRef,
  type EngineCapabilities,
} from "./engine.js";
import type { SessionSource } from "./types/sessions.js";

describe("engine identity", () => {
  it("resolves every unknown or absent value to Pi, never to a newer engine", () => {
    for (const value of [undefined, null, "", "PI", "OMP", "pi-native", "remote", "claude", 7, {}]) {
      expect(normalizeEngineId(value)).toBe("pi");
    }
    expect(normalizeEngineId("pi")).toBe("pi");
    expect(normalizeEngineId("omp")).toBe("omp");
  });

  it("validates ids without normalizing", () => {
    expect(isEngineId("pi")).toBe(true);
    expect(isEngineId("omp")).toBe(true);
    expect(isEngineId("PI")).toBe(false);
    expect(isEngineId(undefined)).toBe(false);
  });

  it("keeps the engine axis separate from the transcript-source axis", () => {
    const sources: SessionSource[] = ["desktop", "pi-native", "remote"];
    // A source names who owns a transcript; it must never be read as an engine.
    for (const source of sources) {
      expect(isEngineId(source)).toBe(false);
      expect(normalizeEngineId(source)).toBe(DEFAULT_ENGINE_ID);
    }
    for (const engine of ENGINE_IDS) {
      expect(sources.includes(engine as SessionSource)).toBe(false);
    }
  });
});

describe("engine capabilities", () => {
  it("declares every capability for every engine", () => {
    for (const engine of ENGINE_IDS) {
      const declared = engineCapabilities(engine);
      for (const key of ENGINE_CAPABILITY_KEYS) {
        expect(typeof declared[key], `${engine}.${key}`).toBe("boolean");
      }
      expect(Object.keys(declared).sort()).toEqual([...ENGINE_CAPABILITY_KEYS].sort());
    }
  });

  it("opens exactly the OMP capabilities this release ships", () => {
    // M3 ships prompting, stopping, approval and questions. Everything else
    // stays closed until its behaviour exists: an open capability is a promise
    // that there is an implementation behind the entry point.
    const shipped = new Set(["prompt", "stop", "structuredQuestions", "toolApproval"]);
    for (const key of ENGINE_CAPABILITY_KEYS) {
      expect(PI_ENGINE_CAPABILITIES[key], `pi.${key}`).toBe(true);
      expect(OMP_ENGINE_CAPABILITIES[key], `omp.${key}`).toBe(shipped.has(key));
    }
  });

  it("refuses a closed capability with a typed, attributable refusal", () => {
    expect(engineSupports("omp", "prompt")).toBe(true);
    expect(engineSupports("omp", "toolApproval")).toBe(true);
    expect(engineSupports("omp", "resume")).toBe(false);
    expect(engineSupports("omp", "steer")).toBe(false);
    const refusal = engineCapabilityRefusal("omp", "resume");
    expect(refusal.errorCode).toBe(ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE);
    expect(refusal.engine).toBe("omp");
    expect(refusal.capability).toBe("resume");
    expect(refusal.message).toContain("omp");
    expect(refusal.message).toContain("resume");
  });

  it("closes capabilities whenever the runtime is not up", () => {
    const idle = liveEngineCapabilities("pi", "idle");
    expect(idle.prompt).toBe(true);
    for (const phase of ["stopped", "starting", "failed"] as const) {
      const closed = liveEngineCapabilities("pi", phase);
      for (const key of ENGINE_CAPABILITY_KEYS) {
        expect(closed[key], `${phase}.${key}`).toBe(false);
      }
    }
    const closedAll: EngineCapabilities = closedEngineCapabilities();
    expect(closedAll).toEqual(liveEngineCapabilities("pi", "stopped"));
  });
});

describe("session engine references", () => {
  it("builds a complete reference from partial input", () => {
    expect(sessionEngineRef()).toEqual({
      engine: "pi",
      adapterVersion: ENGINE_ADAPTER_VERSION,
      runtimeVersion: null,
      nativeSessionId: null,
      nativeSessionPath: null,
    });
  });

  it("treats a legacy record as Pi and keeps native handles", () => {
    const ref = sessionEngineRef({
      runtimeVersion: "18.2.7",
      nativeSessionId: "abc",
      nativeSessionPath: "/tmp/abc.jsonl",
    });
    expect(ref.engine).toBe("pi");
    expect(ref.runtimeVersion).toBe("18.2.7");
    expect(ref.nativeSessionId).toBe("abc");
    expect(ref.nativeSessionPath).toBe("/tmp/abc.jsonl");
  });

  it("ignores malformed fields instead of persisting them", () => {
    const ref = sessionEngineRef({
      engine: "claude",
      adapterVersion: 0,
      runtimeVersion: 42,
      nativeSessionId: "",
    });
    expect(ref).toEqual(sessionEngineRef());
  });

  it("accepts what it built and rejects what it cannot interpret", () => {
    expect(isSessionEngineRef(sessionEngineRef({ engine: "omp" }))).toBe(true);
    expect(isSessionEngineRef({ engine: "omp" })).toBe(false);
    expect(isSessionEngineRef({ engine: "claude", adapterVersion: 1 })).toBe(false);
    expect(isSessionEngineRef({ engine: "omp", adapterVersion: 1.5 })).toBe(false);
    // A reference written by a newer adapter is not silently downgraded.
    expect(isSessionEngineRef({ engine: "omp", adapterVersion: ENGINE_ADAPTER_VERSION + 1 })).toBe(false);
    expect(isSessionEngineRef(null)).toBe(false);
  });

  it("exposes the protocol and version pins the runtime must match", () => {
    expect(OMP_PROTOCOL_VERSION).toBe(2);
    expect(OMP_RUNTIME_VERSION).toBe("18.2.7");
    expect(OMP_MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(OMP_MAX_REASSEMBLED_FRAME_BYTES).toBe(64 * 1024 * 1024);
    expect(OMP_MAX_REASSEMBLED_FRAME_BYTES).toBeGreaterThan(OMP_MAX_FRAME_BYTES);
    expect(Object.keys(ENGINE_CAPABILITIES)).toEqual([...ENGINE_IDS]);
  });
});
