/**
 * T19-C probes: the on-demand Skill user path on the desktop adapter.
 *
 * The adapter must serve the PI `Skill` contract with the exact PI precedence
 * and error shape — builtin first, then the user's own, then the plugin's.
 * The live-recheck boundaries are PI's own, not tighter: a user skill body is
 * re-checked against the project scope at every call (PI `loadUserSkillBody`
 * throws when the skill is no longer active); a plugin skill body is read
 * with PI `loadSkillBody`'s checks only — registered, plugin loaded, file
 * readable, ≤128 KiB, non-empty body — with no execution-time scope predicate
 * (PI `sidecar.ts` calls `plugins.loadSkillBody(id)` directly). Plugin scope
 * changes land on the next prompt's catalog rebuild instead. An unload,
 * delete or edit therefore takes effect at the very next call.
 *
 * On the T19-C baseline (`df49b84`) the adapter has no Skill branch: a `Skill`
 * call falls into the plugin-tool branch and fails with
 * "plugin tool not loaded", so every success-shape assertion below is red.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts");

const BINDING = {
  sessionId: "session-omp",
  projectPath: "/projects/alpha",
  modelKey: () => null,
  thinkingLevel: () => null,
  dispatchable: () => true,
};

function skillCall(args) {
  return { id: "host-1", toolCallId: "tc-1", toolName: "Skill", arguments: args };
}

function skillRun() {
  return { id: "host-1", toolCallId: "tc-1", turnId: "turn-1" };
}

const SIGNAL = new AbortController().signal;

function harness(overrides = {}) {
  const state = {
    builtinBody: null,
    userBody: null,
    userThrows: null,
    userSkills: [],
    pluginSkills: [],
    pluginThrows: null,
    ...overrides,
  };
  const plugins = {
    getTools: () => [],
    getSkills: () => state.pluginSkills,
    loadSkillBody: (id) => {
      if (state.pluginThrows) throw state.pluginThrows;
      const skill = state.pluginSkills.find((candidate) => candidate.id === id);
      if (!skill) {
        throw Object.assign(new Error(`unknown skill: ${id}`), { code: "NOT_FOUND" });
      }
      return { id: skill.id, name: skill.name, body: skill.body };
    },
  };
  const adapter = createOmpHostToolAdapter({
    plugins,
    userMcp: {
      toolsForProject: async () => [],
      callTool: async () => "unused",
    },
    pluginActiveInProject: (pluginId) => pluginId !== "scoped.away",
    loadBuiltinSkillBody: (id) => (id === state.builtinBody?.id ? state.builtinBody : null),
    loadUserSkillBody: async (id) => {
      if (state.userThrows) throw state.userThrows;
      return state.userBody?.id === id ? state.userBody : null;
    },
    activeUserSkills: async () => state.userSkills,
  });
  const executor = adapter.executor(BINDING);
  return { executor, state, plugins };
}

test("a missing id answers with the PI error and isError", async () => {
  const { executor } = harness();
  const outcome = await executor.execute(skillCall({ id: "  " }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.content[0].text, "Skill: `id` is required. Use an id from the Skills section.");
});

test("builtin skills win over plugin skills with the same id", async () => {
  const { executor } = harness({
    builtinBody: { id: "pi-desktop/imagegen", name: "Image generation", body: "BUILTIN-BODY" },
    pluginSkills: [
      { id: "pi-desktop/imagegen", pluginId: "pi-desktop", name: "Shadow", body: "PLUGIN-BODY" },
    ],
  });
  const outcome = await executor.execute(skillCall({ id: "pi-desktop/imagegen" }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(outcome.content, [
    { type: "text", text: "# Skill: Image generation (pi-desktop/imagegen)\n\nBUILTIN-BODY" },
  ]);
});

test("user skills answer after builtins and re-check scope at execution", async () => {
  const { executor } = harness({
    userBody: { id: "user-skill", name: "User skill", body: "USER-BODY" },
  });
  const outcome = await executor.execute(skillCall({ id: "user-skill" }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(outcome.content, [
    { type: "text", text: "# Skill: User skill (user-skill)\n\nUSER-BODY" },
  ]);

  // A user skill rescoped between catalog and execution fails closed with the
  // PI error (PI `loadUserSkillBody` re-checks the scope at the call).
  const rescoped = harness({
    userThrows: new Error('skill "user-skill" is not enabled for this project'),
    userSkills: [{ id: "user-skill" }],
  });
  const denied = await rescoped.executor.execute(skillCall({ id: "user-skill" }), skillRun(), SIGNAL);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /^Skill: skill "user-skill" is not enabled for this project\. Available skills: user-skill\.$/);
});

test("plugin skills answer last and re-check load state at execution", async () => {
  const { executor } = harness({
    pluginSkills: [
      { id: "demo.hello/release-notes", pluginId: "demo.hello", name: "Release notes", body: "PLUGIN-BODY" },
    ],
  });
  const outcome = await executor.execute(skillCall({ id: "demo.hello/release-notes" }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(outcome.content, [
    { type: "text", text: "# Skill: Release notes (demo.hello/release-notes)\n\nPLUGIN-BODY" },
  ]);
});

test("an unknown id answers with the PI error and the available-skill list", async () => {
  const { executor } = harness({
    userSkills: [{ id: "user-skill" }],
    pluginSkills: [
      { id: "demo.hello/release-notes", pluginId: "demo.hello", name: "Release notes" },
      { id: "scoped.away/hidden", pluginId: "scoped.away", name: "Hidden" },
    ],
  });
  const outcome = await executor.execute(skillCall({ id: "does.not.exist" }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, true);
  assert.match(
    outcome.content[0].text,
    /^Skill: unknown skill: does\.not\.exist\. Available skills: user-skill, demo\.hello\/release-notes\.$/,
    "the hint lists the active user skills then the scoped plugin skills, never a scoped-away plugin",
  );
});

test("a plugin unloaded between catalog and execution fails closed", async () => {
  const { executor, plugins } = harness({
    pluginSkills: [
      { id: "demo.hello/release-notes", pluginId: "demo.hello", name: "Release notes", body: "PLUGIN-BODY" },
    ],
  });
  // Unload the plugin: the registry no longer knows the skill, and the live
  // body read refuses it exactly like `PluginRuntime.loadSkillBody` after an
  // unload (`loaded.has(pluginId)` fails).
  plugins.getSkills = () => [];
  plugins.loadSkillBody = (id) => {
    throw Object.assign(new Error(`unknown skill: ${id}`), { code: "NOT_FOUND" });
  };
  const outcome = await executor.execute(skillCall({ id: "demo.hello/release-notes" }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, true);
  // PI's error appends the available-skill hint only when the list is
  // non-empty; an unloaded plugin with no other skills yields the bare
  // message.
  assert.match(outcome.content[0].text, /^Skill: unknown skill: demo\.hello\/release-notes\.$/);
});

test("plugin skill bodies load without a scope re-check, exactly like Pi", async () => {
  // PI's sidecar calls plugins.loadSkillBody(id) with no scope predicate
  // (`sidecar.ts`: builtin -> loadUserSkillBody -> plugins.loadSkillBody);
  // scope filters the catalog and the error hint, not the body read. The
  // harness's pluginActiveInProject rejects scoped.away, so this pins that
  // the OMP adapter does not add an incompatible execution-time gate.
  const { executor } = harness({
    pluginSkills: [
      { id: "scoped.away/notes", pluginId: "scoped.away", name: "Scoped away", body: "SCOPED-BODY" },
    ],
  });
  const outcome = await executor.execute(skillCall({ id: "scoped.away/notes" }), skillRun(), SIGNAL);
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(outcome.content, [
    { type: "text", text: "# Skill: Scoped away (scoped.away/notes)\n\nSCOPED-BODY" },
  ]);
});

test("body edits are read live: the next call sees the new document", async () => {
  const state = { body: "FIRST-BODY" };
  const { executor, plugins } = harness({
    pluginSkills: [{ id: "demo.hello/release-notes", pluginId: "demo.hello", name: "Release notes", body: null }],
  });
  // The plugin runtime reads the document file per call; emulate by serving
  // the live value.
  plugins.loadSkillBody = (id) => ({ id, name: "Release notes", body: state.body });
  const first = await executor.execute(skillCall({ id: "demo.hello/release-notes" }), skillRun(), SIGNAL);
  assert.match(first.content[0].text, /FIRST-BODY/);
  state.body = "SECOND-BODY";
  const second = await executor.execute(skillCall({ id: "demo.hello/release-notes" }), skillRun(), SIGNAL);
  assert.match(second.content[0].text, /SECOND-BODY/);
});

test("the plain host-tool catalog never carries the Skill tool (the bridge owns its presence)", async () => {
  const adapter = createOmpHostToolAdapter({
    plugins: { getTools: () => [] },
    userMcp: { toolsForProject: async () => [] },
    pluginActiveInProject: () => true,
  });
  const catalog = await adapter.catalog("/projects/alpha");
  assert.deepEqual(catalog, [], "the adapter catalog lists plugin/MCP tools only");
});

test("the Skill tool is not a plugin_/mcp_ tool, so the gate never asks for it", async () => {
  const { isHostToolName } = await import("../../../packages/omp-runtime/extensions/omp-desktop-gate.ts");
  assert.equal(isHostToolName("Skill"), false);
  assert.equal(isHostToolName("plugin_demo_echo"), true);
});
