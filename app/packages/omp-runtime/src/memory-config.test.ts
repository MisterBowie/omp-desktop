import { describe, expect, it } from "vitest";
import { sourceIsolationOverlayYaml } from "./config-overlay.js";
import { ompMemoryDirectory } from "./memory-config.js";
import { memoryToolRefusal } from "./memory-policy.js";
import { parseOmpMemorySettings } from "@pi-desktop/shared";

describe("desktop memory source boundary", () => {
  it("keeps memory and Auto-Learn off by default", () => {
    expect(sourceIsolationOverlayYaml()).toContain("backend: off");
    expect(sourceIsolationOverlayYaml()).toContain("autolearn:\n  enabled: false");
  });
  it("isolates projects/worktrees and keeps the database outside transient run roots", () => {
    const a = ompMemoryDirectory("/desktop-data", "/project/a");
    expect(a).toBe(ompMemoryDirectory("/desktop-data", "/project/a"));
    expect(a).not.toBe(ompMemoryDirectory("/desktop-data", "/project/a-worktree"));
    expect(a).toMatch(/^\/desktop-data\/omp-memory\/[a-f0-9]{64}$/);
    expect(() => ompMemoryDirectory("relative", "/project")).toThrow();
  });
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])("projects independent choices (%s, %s)", (autoSave, autoRead) => {
    const yaml = sourceIsolationOverlayYaml({
      dbPath: "/desktop-data/memory.db",
      autoSave,
      autoRead,
      modelSelector: "local/model",
    });
    expect(yaml).toContain(`autoRetain: ${autoSave}`);
    expect(yaml).toContain(`autoRecall: ${autoRead}`);
    expect(yaml).toContain("retainFromSessionStart: true");
    expect(yaml).toContain("backend: mnemopi");
    expect(yaml).toContain('memory: "local/model"');
    expect(yaml).toContain("enableProjectConfig: false");
  });
  it("rejects non-boolean and unknown preferences", () => {
    expect(() => parseOmpMemorySettings({ autoSave: "yes", autoRead: false })).toThrow();
    expect(() => parseOmpMemorySettings({ autoSave: false, autoRead: false, dbPath: "/etc" })).toThrow();
  });
  it("enforces disabled choices at the native tool gate, including child calls", () => {
    for (const tool of ["retain", "learn", "memory_edit", "recall", "reflect"])
      expect(memoryToolRefusal(tool, {}, {})).not.toBeNull();
    expect(memoryToolRefusal("read", { path: "memory://fact" }, {})).not.toBeNull();
    expect(memoryToolRefusal("read", { path: "MEMORY://fact" }, {})).not.toBeNull();
    expect(memoryToolRefusal("read", { path: "README.md" }, {})).toBeNull();
    expect(memoryToolRefusal("retain", {}, { OMP_DESKTOP_MEMORY_AUTO_SAVE: "1" })).toBeNull();
    expect(memoryToolRefusal("recall", {}, { OMP_DESKTOP_MEMORY_AUTO_READ: "1" })).toBeNull();
  });
});
