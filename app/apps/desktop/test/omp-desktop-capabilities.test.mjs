/**
 * T19-C probes: the desktop capability snapshot — the single loader that
 * assembles the live skill catalog (builtin, active plugin, active user — in
 * that order) and the bound project's memory with the exact PI fallback
 * semantics, once per prompt.
 *
 * The baseline (`df49b84`) has no such module: the load guard leaves the
 * provider absent and every behavioral assertion below fails on that fact.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

let createOmpDesktopCapabilities = null;
try {
  ({ createOmpDesktopCapabilities } = await import("../electron/main/runtime/omp-desktop-capabilities.ts"));
} catch {
  createOmpDesktopCapabilities = null;
}

function fakePlugins({ skills = [], loadedPaths = ["/plugins/demo"] } = {}) {
  return {
    getSkills: () => skills,
    listLoaded: () => loadedPaths.map((path) => ({ path })),
  };
}

function pluginSkill(overrides = {}) {
  return { id: "demo.hello/release-notes", pluginId: "demo.hello", name: "Release notes", description: "Draft release notes.", ...overrides };
}

function fakeHost(handler) {
  let calls = 0;
  return {
    calls: () => calls,
    host: () => ({
      call: async (method, params) => {
        calls += 1;
        return handler(method, params);
      },
    }),
  };
}

test("the snapshot assembles builtin, plugin, then user skills in PI order", async () => {
  assert.ok(createOmpDesktopCapabilities, "the capability snapshot module must exist");
  const host = fakeHost(async (method) => {
    if (method === "skills.active") {
      return { skills: [{ id: "user-skill", name: "User skill", description: "User notes." }] };
    }
    if (method === "project.group.context") return { context: null };
    if (method === "project.memory.get") return { memory: { content: "legacy notes" } };
    return {};
  });
  const plugins = fakePlugins({
    skills: [pluginSkill()],
  });
  const capabilities = createOmpDesktopCapabilities({
    host: host.host,
    plugins,
    pluginActiveInProject: (pluginId) => pluginId === "demo.hello",
    activeUserSkills: async () => [{ id: "user-skill", name: "User skill", description: "User notes." }],
  });
  const snapshot = await capabilities.snapshot("/projects/alpha");
  // Builtin first (the pi-desktop skills this workspace activates), then the
  // scoped plugin skill, then the user's own.
  const ids = snapshot.skills.map((skill) => skill.id);
  assert.ok(ids.includes("pi-desktop/plugin-development") || ids.includes("pi-desktop/imagegen"), "builtin skills come first");
  assert.deepEqual(ids.slice(-2), ["demo.hello/release-notes", "user-skill"]);
  // Metadata only — no body crosses this boundary.
  for (const skill of snapshot.skills) {
    assert.ok(!("body" in skill), "catalog entries carry no body");
  }
  assert.equal(snapshot.memory, "legacy notes");
});

test("activation scope filters plugin skills out of the catalog", async () => {
  assert.ok(createOmpDesktopCapabilities, "the capability snapshot module must exist");
  const host = fakeHost(async () => ({ context: null }));
  const plugins = fakePlugins({ skills: [pluginSkill()] });
  const capabilities = createOmpDesktopCapabilities({
    host: host.host,
    plugins,
    pluginActiveInProject: () => false,
    activeUserSkills: async () => [],
  });
  const snapshot = await capabilities.snapshot("/projects/other");
  assert.ok(
    !snapshot.skills.some((skill) => skill.id === "demo.hello/release-notes"),
    "a plugin inactive in this project must be invisible in its catalog",
  );
});

test("group memory wins and the legacy fallback answers when the group has none", async () => {
  assert.ok(createOmpDesktopCapabilities, "the capability snapshot module must exist");
  const calls = [];
  const host = {
    call: async (method) => {
      calls.push(method);
      if (method === "project.group.context") {
        return { context: { memory: { content: "  group memory notes  " } } };
      }
      throw new Error("the legacy path must not be reached");
    },
  };
  const capabilities = createOmpDesktopCapabilities({
    host: () => host,
    plugins: fakePlugins(),
    pluginActiveInProject: () => true,
    activeUserSkills: async () => [],
  });
  const snapshot = await capabilities.snapshot("/projects/grouped");
  assert.equal(snapshot.memory, "group memory notes");
  assert.ok(
    calls.includes("project.group.context") && !calls.includes("project.memory.get"),
    "the legacy path must not be reached when the group reports context",
  );

  const legacyHost = {
    call: async (method) => {
      if (method === "project.group.context") return { context: null };
      if (method === "project.memory.get") return { memory: { content: "  legacy notes  " } };
      return {};
    },
  };
  const legacy = createOmpDesktopCapabilities({
    host: () => legacyHost,
    plugins: fakePlugins(),
    pluginActiveInProject: () => true,
    activeUserSkills: async () => [],
  });
  assert.equal((await legacy.snapshot("/projects/plain")).memory, "legacy notes");
});

test("a failed memory read is best-effort: the catalog still arrives", async () => {
  assert.ok(createOmpDesktopCapabilities, "the capability snapshot module must exist");
  const host = {
    call: async () => {
      throw new Error("host unavailable");
    },
  };
  const plugins = fakePlugins({ skills: [pluginSkill()] });
  const capabilities = createOmpDesktopCapabilities({
    host: () => host,
    plugins,
    pluginActiveInProject: () => true,
    activeUserSkills: async () => {
      throw new Error("skills.active unavailable");
    },
  });
  const snapshot = await capabilities.snapshot("/projects/broken");
  assert.equal(snapshot.memory, undefined);
  assert.deepEqual(
    snapshot.skills.map((skill) => skill.id).filter((id) => id === "demo.hello/release-notes"),
    ["demo.hello/release-notes"],
    "a host failure drops only the user skills and memory, never the plugin catalog",
  );
});

test("edits and removals are visible on the very next snapshot", async () => {
  assert.ok(createOmpDesktopCapabilities, "the capability snapshot module must exist");
  let memory = "first notes";
  let userSkills = [{ id: "user-skill", name: "User skill", description: "" }];
  const host = {
    call: async (method) => {
      if (method === "project.group.context") return { context: { memory: { content: memory } } };
      if (method === "skills.active") return { skills: userSkills };
      return {};
    },
  };
  const capabilities = createOmpDesktopCapabilities({
    host: () => host,
    plugins: fakePlugins(),
    pluginActiveInProject: () => true,
    activeUserSkills: async () => userSkills,
  });
  const first = await capabilities.snapshot("/projects/live");
  assert.equal(first.memory, "first notes");
  assert.ok(first.skills.some((skill) => skill.id === "user-skill"));

  memory = "second notes";
  userSkills = [];
  const second = await capabilities.snapshot("/projects/live");
  assert.equal(second.memory, "second notes");
  assert.ok(!second.skills.some((skill) => skill.id === "user-skill"));
});

test("the gate's prompt blocks are byte-identical to the PI prompt helpers", async () => {
  const { desktopSkillsPrompt, desktopMemoryPrompt, desktopCapabilityPrompt } = await import(
    "../../../packages/omp-runtime/src/desktop-state.ts"
  );
  const { pluginSkillsPrompt } = await import("../../../packages/agent-runtime/src/plugin-skills-prompt.ts");
  const { projectMemoryPrompt } = await import("../../../packages/agent-runtime/src/project-memory-prompt.ts");

  const skills = [
    { id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." },
    { id: "user-skill", name: "User skill", description: "" },
  ];
  assert.equal(desktopSkillsPrompt(skills), pluginSkillsPrompt(skills));
  assert.equal(desktopSkillsPrompt([]), pluginSkillsPrompt([]));
  assert.equal(desktopMemoryPrompt("Use the staging database."), projectMemoryPrompt("Use the staging database."));
  assert.equal(desktopMemoryPrompt("  \n\t"), projectMemoryPrompt("  \n\t"));
  assert.equal(desktopMemoryPrompt(null), projectMemoryPrompt(undefined));
  assert.equal(
    desktopCapabilityPrompt({ skills, memory: "notes" }),
    `${pluginSkillsPrompt(skills)}\n\n${projectMemoryPrompt("notes")}`,
  );
});
