/**
 * B14 counterexample control (M5/T20-B1): the B2 acceptance predicate must
 * reject the wrong implementations it exists to catch, not merely accept the
 * correct one.
 *
 * The predicate is the same module the real-runtime E2E applies to provider
 * requests (`helpers/mode-prompt-assertions.mjs`); these hand-built system
 * prompts stand in for the counterexample implementations: a PI default base
 * written into the state or appended as a second block, the mode block
 * appended twice, another mode's block, the block not last, and a missing
 * capability injection.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { assertModePromptShape, SKILL_CATALOG_MARKER, MEMORY_MARKER } = await import(
  "./helpers/mode-prompt-assertions.mjs"
);
const { composeModeSystemPrompt, DEFAULT_RUNTIME_SYSTEM_PROMPT } = await import(
  "../../../packages/agent-runtime/src/mode-prompts.ts"
);

const NATIVE_BASE = "native base part one\n\nnative base part two";
const AGENT_BLOCK = composeModeSystemPrompt("agent", "");
const PLAN_BLOCK = composeModeSystemPrompt("plan", "");
const CAPABILITY = [
  "# Skills",
  "",
  SKILL_CATALOG_MARKER,
  "",
  "- `demo` — Demo",
  "",
  "# Project memory",
  "",
  MEMORY_MARKER,
  "",
  "notes",
].join("\n");

test("the B2 predicate accepts the correct production shape", () => {
  assert.doesNotThrow(() =>
    assertModePromptShape({
      label: "correct",
      systemText: `${NATIVE_BASE}\n\n${CAPABILITY}\n\n${AGENT_BLOCK}`,
      mode: "agent",
      capabilityExpected: true,
    }),
  );
});

test("the B2 predicate rejects every counterexample it exists to catch", () => {
  const counterexamples = [
    [
      "PI default base appended as a second block",
      `${NATIVE_BASE}\n\n${CAPABILITY}\n\n${AGENT_BLOCK}\n\n${DEFAULT_RUNTIME_SYSTEM_PROMPT}`,
    ],
    [
      "PI default base written into the state's block",
      `${NATIVE_BASE}\n\n${CAPABILITY}\n\n${DEFAULT_RUNTIME_SYSTEM_PROMPT}\n\n${AGENT_BLOCK}`,
    ],
    ["the mode block appended twice", `${NATIVE_BASE}\n\n${AGENT_BLOCK}\n\n${AGENT_BLOCK}`],
    ["another mode's block instead of this one", `${NATIVE_BASE}\n\n${PLAN_BLOCK}`],
    ["the capability block after the mode block", `${NATIVE_BASE}\n\n${AGENT_BLOCK}\n\n${CAPABILITY}`],
    ["a missing capability injection", `${NATIVE_BASE}\n\n${AGENT_BLOCK}`],
  ];
  for (const [label, systemText] of counterexamples) {
    assert.throws(
      () => assertModePromptShape({ label, systemText, mode: "agent", capabilityExpected: true }),
      undefined,
      `${label} must be rejected`,
    );
  }
});
