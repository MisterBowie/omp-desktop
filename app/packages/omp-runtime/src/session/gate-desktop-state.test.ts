/**
 * Probes for the gate's `before_agent_start` half of the desktop-capability
 * state (M5/T19-C).
 *
 * The trusted gate is the single place desktop skill metadata and project
 * memory may enter the provider-visible system prompt. Its handler must:
 *
 *   - append one PI-identical block to the runtime's existing system prompt
 *     parts, never replace or drop them;
 *   - inject only for the owning session (a subagent session with a different
 *     id gets nothing);
 *   - fail closed on a missing, malformed, stale or out-of-schema state file —
 *     no override at all, so the native prompt ships untouched;
 *   - return no override when the state carries neither skills nor memory;
 *   - register on the real event, so the pinned runtime actually calls it.
 *
 * On the T19-C baseline (`df49b84`) the gate has no such handler and none of
 * these exports exist: the import fails and every test is red.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DESKTOP_STATE_FILE,
  MAX_DESKTOP_STATE_AGE_MS,
  serializeDesktopCapabilityState,
} from "../desktop-state.js";
import ompDesktopGate, {
  beforeAgentStartInjection,
  type ExtensionAPI,
} from "../../extensions/omp-desktop-gate.ts";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const dir = join("/tmp", `omp-gate-state-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

const NOW = 1_700_000_000_000;
const BASE_PROMPT = ["native part one", "native part two"];
const OWNING_SESSION = "native-session-1";

function validStatePath(): string {
  const dir = stateDir();
  const path = join(dir, DESKTOP_STATE_FILE);
  writeFileSync(
    path,
    serializeDesktopCapabilityState(
      {
        sessionId: OWNING_SESSION,
        skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }],
        memory: "Use the staging database.",
      },
      NOW,
    ),
  );
  return path;
}

function context(sessionId = OWNING_SESSION) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

describe("before_agent_start injection", () => {
  it("appends the PI-identical block to the existing system prompt parts", () => {
    const path = validStatePath();
    const result = beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    expect(result).toBeDefined();
    expect(result!.systemPrompt.slice(0, 2)).toEqual(BASE_PROMPT);
    const block = result!.systemPrompt[2]!;
    expect(block).toContain("# Skills");
    expect(block).toContain("- `demo.hello/release-notes` — Release notes: Draft release notes.");
    expect(block).toContain("# Project memory");
    expect(block).toContain("Use the staging database.");
    expect(block).toContain("user-provided context");
  });

  it("injects nothing for a session other than the owning one", () => {
    const path = validStatePath();
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context("other-session"), path, NOW)).toBeUndefined();
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, { sessionManager: undefined }, path, NOW)).toBeUndefined();
  });

  it("fails closed on a missing, malformed, oversized or stale file", () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW)).toBeUndefined();
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), null, NOW)).toBeUndefined();

    writeFileSync(path, "{not json");
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW)).toBeUndefined();

    writeFileSync(
      path,
      serializeDesktopCapabilityState(
        { sessionId: OWNING_SESSION, skills: [], memory: "m" },
        NOW - MAX_DESKTOP_STATE_AGE_MS - 1,
      ),
    );
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ v: 1, sessionId: OWNING_SESSION, writtenAt: NOW, memory: "m", skills: [{ id: "", name: "", description: "" }] }));
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW)).toBeUndefined();
  });

  it("returns no override when the state carries neither skills nor memory", () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeFileSync(path, serializeDesktopCapabilityState({ sessionId: OWNING_SESSION, skills: [], memory: null }, NOW));
    expect(beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW)).toBeUndefined();
  });

  it("injects skills alone or memory alone", () => {
    const dir = stateDir();
    const path = join(dir, DESKTOP_STATE_FILE);
    writeFileSync(
      path,
      serializeDesktopCapabilityState(
        { sessionId: OWNING_SESSION, skills: [{ id: "a", name: "A", description: "" }], memory: null },
        NOW,
      ),
    );
    const skillsOnly = beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    expect(skillsOnly!.systemPrompt[2]).toContain("# Skills");
    expect(skillsOnly!.systemPrompt[2]).not.toContain("# Project memory");

    writeFileSync(path, serializeDesktopCapabilityState({ sessionId: OWNING_SESSION, skills: [], memory: "notes" }, NOW));
    const memoryOnly = beforeAgentStartInjection({ systemPrompt: [...BASE_PROMPT] }, context(), path, NOW);
    expect(memoryOnly!.systemPrompt[2]).toContain("# Project memory");
    expect(memoryOnly!.systemPrompt[2]).not.toContain("# Skills");
  });
});

describe("registration", () => {
  it("registers the before_agent_start handler on the real event", () => {
    const handlers: Record<string, unknown[]> = {};
    const api: ExtensionAPI = {
      on: ((event: string, handler: unknown) => {
        (handlers[event] ??= []).push(handler);
      }) as ExtensionAPI["on"],
    };
    ompDesktopGate(api);
    expect((handlers["before_agent_start"] ?? []).length).toBeGreaterThan(0);
    expect((handlers["tool_call"] ?? []).length).toBeGreaterThan(0);
  });
});
