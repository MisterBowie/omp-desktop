import { describe, expect, it } from "vitest";
import { pluginSkillsDigest, type PluginSkillDef } from "./plugin-skills.js";

function skill(overrides: Partial<PluginSkillDef> = {}): PluginSkillDef {
  return {
    id: "demo.notes/summarise",
    name: "Summarise notes",
    description: "Group notes by tag.",
    ...overrides,
  };
}

describe("pluginSkillsDigest", () => {
  it("is empty without skills", () => {
    expect(pluginSkillsDigest()).toBe("");
    expect(pluginSkillsDigest([])).toBe("");
  });

  it("is stable for the same catalog", () => {
    expect(pluginSkillsDigest([skill()])).toBe(pluginSkillsDigest([skill()]));
  });

  it("changes when catalog text the model reads changes", () => {
    const base = pluginSkillsDigest([skill()]);
    expect(pluginSkillsDigest([skill({ id: "demo.notes/other" })])).not.toBe(base);
    expect(pluginSkillsDigest([skill({ name: "Renamed" })])).not.toBe(base);
    expect(pluginSkillsDigest([skill({ description: "Group by date." })])).not.toBe(
      base,
    );
  });

  it("distinguishes order, because the prompt lists skills in order", () => {
    expect(pluginSkillsDigest([skill({ id: "a" }), skill({ id: "b" })])).not.toBe(
      pluginSkillsDigest([skill({ id: "b" }), skill({ id: "a" })]),
    );
  });

  it("ignores a missing description consistently", () => {
    const without = pluginSkillsDigest([{ id: "a", name: "A" }]);
    expect(pluginSkillsDigest([{ id: "a", name: "A", description: "" }])).toBe(without);
  });
});
