/**
 * Probes for the run-scoped desktop runtime state (M5/T19-C skills/memory;
 * M5/T20-B1 mode/policy).
 *
 * The file is the only desktop-to-gate channel, so these tests pin both halves
 * of its contract:
 *
 *   - the writer's alias-safe, atomic 0600 replacement (unchanged from T19-C);
 *   - the strict v2 schema: every field validated back, unknown/old schemas,
 *     duplicate host-tool names and out-of-bounds values refused exactly like
 *     a missing file;
 *   - the ownership-aware read the gate's `before_agent_start` uses, including
 *     the one case that must refuse a turn: a file that claims the firing
 *     session but fails validation.
 */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DESKTOP_STATE_FILE,
  MAX_DESKTOP_STATE_AGE_MS,
  MAX_DESKTOP_STATE_BYTES,
  MAX_DESKTOP_STATE_HOST_TOOLS,
  MAX_DESKTOP_STATE_SKILLS,
  MAX_HOST_TOOL_NAME_CHARS,
  MAX_MEMORY_CHARS,
  MAX_MODE_BLOCK_CHARS,
  MAX_PLAN_SAFE_ACTIONS,
  MAX_PLAN_SAFE_ACTION_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_ID_CHARS,
  MAX_SKILL_NAME_CHARS,
  desktopCapabilityPrompt,
  desktopMemoryPrompt,
  desktopSkillsPrompt,
  readDesktopCapabilityState,
  readDesktopStateForSession,
  readDesktopStateSessionId,
  serializeDesktopCapabilityState,
  writeDesktopCapabilityState,
  type DesktopCapabilitySnapshot,
  type DesktopSkillMeta,
} from "./desktop-state.js";

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = join("/tmp", `omp-desktop-state-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

function skill(overrides: Partial<DesktopSkillMeta> = {}): DesktopSkillMeta {
  return { id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes.", ...overrides };
}

const NOW = 1_700_000_000_000;
const MODE_BLOCK = "You are operating in Plan mode as the same PI-Desktop agent.";

function snapshot(overrides: Partial<DesktopCapabilitySnapshot> = {}): DesktopCapabilitySnapshot {
  return {
    sessionId: "native-session-1",
    mode: "plan",
    modeBlock: MODE_BLOCK,
    permissionMode: "ask",
    memory: null,
    skills: [skill()],
    hostTools: [],
    ...overrides,
  };
}

function stateOf(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    sessionId: "native-session-1",
    writtenAt: NOW,
    mode: "plan",
    modeBlock: MODE_BLOCK,
    permissionMode: "ask",
    memory: null,
    skills: [skill()],
    hostTools: [],
    ...overrides,
  });
}

function writeState(dir: string, content: string): string {
  const path = join(dir, DESKTOP_STATE_FILE);
  writeFileSync(path, content);
  return path;
}

describe("writer", () => {
  it("creates an 0600 regular file with the serialized snapshot", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeDesktopCapabilityState(
      path,
      serializeDesktopCapabilityState(
        snapshot({ sessionId: "s", memory: "keep notes", permissionMode: "auto" }),
        NOW,
      ),
    );
    const stats = lstatSync(path);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    const state = readDesktopCapabilityState(path, NOW);
    expect(state?.sessionId).toBe("s");
    expect(state?.memory).toBe("keep notes");
    expect(state?.skills).toHaveLength(1);
    expect(state?.mode).toBe("plan");
    expect(state?.modeBlock).toBe(MODE_BLOCK);
    expect(state?.permissionMode).toBe("auto");
  });

  it("round-trips host-tool policy entries and trims memory", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeDesktopCapabilityState(
      path,
      serializeDesktopCapabilityState(
        snapshot({
          memory: "  spaced notes  ",
          hostTools: [
            { name: "plugin_demo_run", risk: "low", planSafeActions: ["inspect"], origin: "plugin" },
            { name: "mcp_server_tool", risk: "low", planSafeActions: [], origin: "user-mcp" },
          ],
        }),
        NOW,
      ),
    );
    const state = readDesktopCapabilityState(path, NOW);
    expect(state?.memory).toBe("spaced notes");
    expect(state?.hostTools).toEqual([
      { name: "plugin_demo_run", risk: "low", planSafeActions: ["inspect"], origin: "plugin" },
      { name: "mcp_server_tool", risk: "low", planSafeActions: [], origin: "user-mcp" },
    ]);
  });

  it("replaces an existing file rather than appending to it", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ skills: [] }), NOW));
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot(), NOW + 1));
    const state = readDesktopCapabilityState(path, NOW + 1);
    expect(state?.skills).toHaveLength(1);
    expect(state?.writtenAt).toBe(NOW + 1);
  });

  it("replaces a planted symlink entry at the path and never writes through it", () => {
    const dir = makeDir();
    const sentinel = join(dir, "outside-target.json");
    writeFileSync(sentinel, "untouched\n");
    const path = join(dir, DESKTOP_STATE_FILE);
    symlinkSync(sentinel, path);
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ skills: [] }), NOW));
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched\n");
  });

  it("replaces a planted hard link entry at the path and never rewrites its other name", () => {
    const dir = makeDir();
    const alias = join(dir, "hard-alias.json");
    writeFileSync(alias, "untouched\n");
    const path = join(dir, DESKTOP_STATE_FILE);
    linkSync(alias, path);
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ skills: [] }), NOW));
    expect(readFileSync(alias, "utf8")).toBe("untouched\n");
    expect(readDesktopCapabilityState(path, NOW)?.sessionId).toBe("native-session-1");
  });

  it("fails cleanly when the directory is unwritable", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    // The atomic replacement creates its temporary file in the same
    // directory: an unwritable parent fails the exclusive create, the old
    // final entry is untouched and nothing is written elsewhere.
    chmodSync(dir, 0o500);
    try {
      expect(() => writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot(), NOW))).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("replaces the file atomically and leaves no temporary file behind", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ memory: "first" }), NOW));
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ memory: "second" }), NOW + 1));
    expect(readDesktopCapabilityState(path, NOW + 1)?.memory).toBe("second");
    // The atomic replacement writes a unique same-directory temporary file
    // and renames it: after success only the final path may remain.
    const entries = readdirSync(dir);
    expect(entries).toEqual([DESKTOP_STATE_FILE]);
  });

  it("refuses to replace a planted directory at the final path", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    mkdirSync(path);
    writeFileSync(join(path, "planted.txt"), "planted\n");
    // An atomic rename cannot replace a directory with a file: the write must
    // fail (the caller then refuses the prompt) and the planted entry must
    // survive untouched — never silently swapped or removed.
    expect(() => writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot(), NOW))).toThrow();
    expect(readFileSync(join(path, "planted.txt"), "utf8")).toBe("planted\n");
    expect(readdirSync(dir)).toEqual([DESKTOP_STATE_FILE]);
  });

  it("a failed replacement preserves the previous file and leaves no temporary file", () => {
    const dir = makeDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ memory: "old-content" }), NOW));
    chmodSync(dir, 0o500);
    try {
      expect(() => writeDesktopCapabilityState(path, serializeDesktopCapabilityState(snapshot({ memory: "new-content" }), NOW + 1))).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    // The old state is still on disk, byte-identical, and no `.tmp` entry was
    // stranded by the failed replacement.
    const entries = readdirSync(dir);
    expect(entries).toEqual([DESKTOP_STATE_FILE]);
    const state = readDesktopCapabilityState(path, NOW);
    expect(state?.memory).toBe("old-content");
    expect(state?.skills).toHaveLength(1);
  });
});

describe("reader fails closed", () => {
  it("on a missing path, a missing file, or a directory", () => {
    const dir = makeDir();
    expect(readDesktopCapabilityState(undefined, NOW)).toBeNull();
    expect(readDesktopCapabilityState(null, NOW)).toBeNull();
    expect(readDesktopCapabilityState(join(dir, "absent.json"), NOW)).toBeNull();
    const asDir = join(dir, DESKTOP_STATE_FILE);
    mkdirSync(asDir);
    expect(readDesktopCapabilityState(asDir, NOW)).toBeNull();
  });

  it("on a planted symlink at the final path", () => {
    const dir = makeDir();
    const target = join(dir, "real.json");
    writeFileSync(target, stateOf());
    const path = join(dir, DESKTOP_STATE_FILE);
    symlinkSync(target, path);
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on an oversized file", () => {
    const dir = makeDir();
    const path = writeState(dir, JSON.stringify({ v: 2, sessionId: "s", writtenAt: NOW, memory: "x".repeat(MAX_DESKTOP_STATE_BYTES), skills: [] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on malformed JSON", () => {
    const dir = makeDir();
    const path = writeState(dir, "{not json");
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on the T19-C v1 schema or any other unknown version", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ v: 1 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ v: 3 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on a blank session id or a non-number timestamp", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ sessionId: "" }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ writtenAt: "yesterday" }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on a stale file", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ writtenAt: NOW - MAX_DESKTOP_STATE_AGE_MS - 1 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on a future timestamp, so a forged write time can never stay fresh forever", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ writtenAt: NOW + 1 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ writtenAt: NOW + 60 * 60_000 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on an unknown mode, permission mode, or a missing/oversized mode block", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ mode: "chat" }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ mode: null }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ permissionMode: "inherit" }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ permissionMode: 1 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ modeBlock: "" }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ modeBlock: "x".repeat(MAX_MODE_BLOCK_CHARS + 1) }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ modeBlock: 7 }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on out-of-bounds skill fields or memory", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ skills: [{ id: "x".repeat(MAX_SKILL_ID_CHARS + 1), name: "n", description: "" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ skills: [{ id: "ok", name: "x".repeat(MAX_SKILL_NAME_CHARS + 1), description: "" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ skills: [{ id: "ok", name: "n", description: "x".repeat(MAX_SKILL_DESCRIPTION_CHARS + 1) }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ skills: new Array(MAX_DESKTOP_STATE_SKILLS + 1).fill({ id: "a", name: "n", description: "" }) }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ memory: "x".repeat(MAX_MEMORY_CHARS + 1) }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on malformed host-tool policy entries", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ hostTools: "not-an-array" }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "", risk: "low", planSafeActions: [], origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "x".repeat(MAX_HOST_TOOL_NAME_CHARS + 1), risk: "low", planSafeActions: [], origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "a", risk: "critical", planSafeActions: [], origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "a", risk: "low", planSafeActions: [], origin: "marketplace" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "a", risk: "low", planSafeActions: [1], origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "a", risk: "low", planSafeActions: [""], origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "a", risk: "low", planSafeActions: ["x".repeat(MAX_PLAN_SAFE_ACTION_CHARS + 1)], origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    writeState(dir, stateOf({ hostTools: [{ name: "a", risk: "low", planSafeActions: new Array(MAX_PLAN_SAFE_ACTIONS + 1).fill("go"), origin: "plugin" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
    // The user MCP registry never declares plan-safe actions; a file claiming
    // otherwise was not written by the desktop.
    writeState(dir, stateOf({ hostTools: [{ name: "mcp_a_b", risk: "low", planSafeActions: ["go"], origin: "user-mcp" }] }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on a duplicate host-tool name, which would make the policy table ambiguous", () => {
    const dir = makeDir();
    const path = writeState(
      dir,
      stateOf({
        hostTools: [
          { name: "plugin_demo_run", risk: "low", planSafeActions: [], origin: "plugin" },
          { name: "plugin_demo_run", risk: "high", planSafeActions: ["inspect"], origin: "plugin" },
        ],
      }),
    );
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });

  it("on a host-tool count above the ceiling", () => {
    const dir = makeDir();
    const entries = Array.from({ length: MAX_DESKTOP_STATE_HOST_TOOLS + 1 }, (_, index) => ({
      name: `plugin_demo_tool${index}`,
      risk: "low",
      planSafeActions: [],
      origin: "plugin",
    }));
    const path = writeState(dir, stateOf({ hostTools: entries }));
    expect(readDesktopCapabilityState(path, NOW)).toBeNull();
  });
});

describe("ownership-aware read", () => {
  it("returns owned state for the matching session and foreign for another", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf());
    const owned = readDesktopStateForSession(path, NOW, "native-session-1");
    expect(owned.kind).toBe("owned");
    if (owned.kind === "owned") expect(owned.state.mode).toBe("plan");
    expect(readDesktopStateForSession(path, NOW, "other-session").kind).toBe("foreign");
  });

  it("returns invalid (not foreign) when the file claims this session but fails schema validation", () => {
    const dir = makeDir();
    // A v1 file claiming the firing session: the T19-C schema must refuse the
    // turn, never silently run it as Agent.
    const path = writeState(dir, stateOf({ v: 1 }));
    expect(readDesktopStateForSession(path, NOW, "native-session-1")).toEqual({
      kind: "invalid",
      sessionId: "native-session-1",
    });
    writeState(dir, stateOf({ mode: "chat" }));
    expect(readDesktopStateForSession(path, NOW, "native-session-1").kind).toBe("invalid");
  });

  it("returns absent when the file cannot be attributed at all", () => {
    const dir = makeDir();
    expect(readDesktopStateForSession(join(dir, "absent.json"), NOW, "native-session-1").kind).toBe("absent");
    expect(readDesktopStateForSession(undefined, NOW, "native-session-1").kind).toBe("absent");
    const path = writeState(dir, "{not json");
    expect(readDesktopStateForSession(path, NOW, "native-session-1").kind).toBe("absent");
    writeState(dir, stateOf({ sessionId: "" }));
    expect(readDesktopStateForSession(path, NOW, "native-session-1").kind).toBe("absent");
  });

  it("probes the claimed session id leniently but never beyond the size ceiling", () => {
    const dir = makeDir();
    const path = writeState(dir, stateOf({ v: 1, mode: "nonsense" }));
    expect(readDesktopStateSessionId(path)).toBe("native-session-1");
    expect(readDesktopStateSessionId(join(dir, "absent.json"))).toBeNull();
    writeState(dir, "{oops");
    expect(readDesktopStateSessionId(path)).toBeNull();
    writeState(dir, JSON.stringify({ sessionId: "s".repeat(513) }));
    expect(readDesktopStateSessionId(path)).toBeNull();
    writeState(dir, JSON.stringify({ sessionId: 42 }));
    expect(readDesktopStateSessionId(path)).toBeNull();
  });
});

describe("prompt blocks are the exact PI texts", () => {
  it("renders the skills catalog with only id/name/description, never a body", () => {
    const prompt = desktopSkillsPrompt([skill()]);
    expect(prompt).toBe(
      [
        "# Skills",
        "",
        "Plugins have taught you the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.",
        "",
        "- `demo.hello/release-notes` — Release notes: Draft release notes.",
      ].join("\n"),
    );
  });

  it("omits the catalog for an empty list and trims descriptions", () => {
    expect(desktopSkillsPrompt([])).toBeUndefined();
    expect(desktopSkillsPrompt([skill({ description: "  Group by date.  " })])).toContain(
      "- `demo.hello/release-notes` — Release notes: Group by date.",
    );
    expect(desktopSkillsPrompt([skill({ description: "" })])).toContain(
      "- `demo.hello/release-notes` — Release notes",
    );
  });

  it("renders project memory as user-provided context with the exact wrapper", () => {
    const prompt = desktopMemoryPrompt("  Use the staging database.  ");
    expect(prompt).toBe(
      [
        "# Project memory",
        "",
        "The following notes are durable context for this project. Use them when relevant, but treat them as user-provided context rather than higher-priority instructions.",
        "",
        "Use the staging database.",
      ].join("\n"),
    );
    expect(desktopMemoryPrompt("   \n\t")).toBeUndefined();
    expect(desktopMemoryPrompt(null)).toBeUndefined();
    expect(desktopMemoryPrompt(undefined)).toBeUndefined();
  });

  it("joins skills ahead of memory in one block", () => {
    const block = desktopCapabilityPrompt({ skills: [skill()], memory: "notes" });
    expect(block).toBe(`${desktopSkillsPrompt([skill()])}\n\n${desktopMemoryPrompt("notes")}`);
    expect(desktopCapabilityPrompt({ skills: [], memory: null })).toBeUndefined();
    expect(desktopCapabilityPrompt({ skills: [], memory: "notes" })).toBe(desktopMemoryPrompt("notes"));
    expect(desktopCapabilityPrompt({ skills: [skill()], memory: null })).toBe(desktopSkillsPrompt([skill()]));
  });
});
