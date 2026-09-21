import { describe, expect, it } from "vitest";
import {
  pluginSkillsPrompt,
  SKILL_TOOL_NAME,
  type PluginSkillDef,
} from "./plugin-skills-prompt.js";

const skills: PluginSkillDef[] = [
  {
    id: "demo.hello/release-notes",
    name: "Release notes",
    description: "Draft release notes from the changelog.",
  },
  { id: "demo.hello/no-description", name: "Bare" },
];

describe("pluginSkillsPrompt", () => {
  it("returns nothing when no plugin taught a skill", () => {
    expect(pluginSkillsPrompt([])).toBeUndefined();
  });

  it("lists ids, names and descriptions and names the load tool", () => {
    const prompt = pluginSkillsPrompt(skills) ?? "";
    expect(prompt.startsWith("# Skills")).toBe(true);
    expect(prompt).toContain(`\`${SKILL_TOOL_NAME}\` tool`);
    expect(prompt).toContain(
      "- `demo.hello/release-notes` — Release notes: Draft release notes from the changelog.",
    );
    // A skill without a description still has to be addressable.
    expect(prompt).toContain("- `demo.hello/no-description` — Bare");
  });

  it("keeps the document body out of the prompt", () => {
    const prompt = pluginSkillsPrompt([
      { id: "a/b", name: "B", description: "Short line." },
    ]) ?? "";
    expect(prompt).not.toContain("Short line.\n\n");
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });
});
