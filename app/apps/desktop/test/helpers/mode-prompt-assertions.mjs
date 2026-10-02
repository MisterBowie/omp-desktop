/**
 * The M5/T20-B1 mode-prompt acceptance predicate, shared by the real-runtime
 * E2E and the B14 counterexample control.
 *
 * B2 is only meaningful if a wrong implementation is actually rejected, so the
 * same predicate the E2E applies to provider requests is applied here to
 * hand-built counterexample prompts (PI default base leaked into the state,
 * the mode block appended twice, the wrong mode's block, the block not last).
 * A predicate that cannot fail is not evidence.
 */
import assert from "node:assert/strict";

import {
  composeModeSystemPrompt,
  DEFAULT_RUNTIME_SYSTEM_PROMPT,
} from "../../../../packages/agent-runtime/src/mode-prompts.ts";

/** The PI catalog's own wording, so a native `# Skills` section cannot alias ours. */
export const SKILL_CATALOG_MARKER = "Plugins have taught you the following skills.";
export const MEMORY_MARKER = "The following notes are durable context for this project.";

export function occurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Assert one provider-visible system prompt matches the B2 contract:
 * exactly one mode block (the production composer's output for `mode`), no
 * other mode's block, the block appended last, no PI default base anywhere,
 * and the injected capability markers exactly when expected.
 */
export function assertModePromptShape({ label, systemText, mode, capabilityExpected }) {
  const block = composeModeSystemPrompt(mode, "");
  assert.equal(occurrences(systemText, block), 1, `${label}: the ${mode} block must appear exactly once`);
  for (const other of ["agent", "plan", "goal"].filter((candidate) => candidate !== mode)) {
    assert.equal(
      occurrences(systemText, composeModeSystemPrompt(other, "")),
      0,
      `${label}: the ${other} block must not appear`,
    );
  }
  assert.ok(systemText.endsWith(block), `${label}: the mode block must be the final appended part`);
  assert.ok(
    !systemText.includes(DEFAULT_RUNTIME_SYSTEM_PROMPT.trim()),
    `${label}: the PI default runtime base must never ride the state`,
  );
  assert.equal(
    occurrences(systemText, SKILL_CATALOG_MARKER),
    capabilityExpected ? 1 : 0,
    `${label}: the injected skill catalog must appear exactly when the catalog is non-empty`,
  );
  assert.equal(
    occurrences(systemText, MEMORY_MARKER),
    capabilityExpected ? 1 : 0,
    `${label}: injected project memory must appear exactly when present`,
  );
}

/** The single system message a request may carry; returns its text. */
export function requestSystemText(request) {
  const messages = request.body?.messages ?? [];
  const systems = messages.filter((message) => message && typeof message === "object" && message.role === "system");
  assert.equal(systems.length, 1, "every request must carry exactly one system message");
  return String(systems[0].content ?? "");
}
