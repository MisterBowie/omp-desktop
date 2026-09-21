import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, skillIdFromPath } from "./skills.js";

describe("parseSkillFrontmatter", () => {
  it("reads name and description and strips the block", () => {
    const parsed = parseSkillFrontmatter(
      ['---', 'name: Release Notes', 'description: "Draft a changelog entry"', '---', '', 'Body line.'].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({
      name: "Release Notes",
      description: "Draft a changelog entry",
      body: "Body line.",
    });
  });

  it("keeps the whole document when there is no front matter", () => {
    expect(parseSkillFrontmatter("# Skill\n\nDo the thing.")).toEqual({
      body: "# Skill\n\nDo the thing.",
    });
  });

  it("ignores unknown keys, comments and CRLF line endings", () => {
    const parsed = parseSkillFrontmatter("---\r\n# comment\r\nname: A\r\nrisk: high\r\n---\r\nBody");
    expect(parsed.name).toBe("A");
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("Body");
  });

  it("does not treat a horizontal rule as front matter", () => {
    const parsed = parseSkillFrontmatter("Intro\n---\nname: nope\n---\n");
    expect(parsed.name).toBeUndefined();
    expect(parsed.body.startsWith("Intro")).toBe(true);
  });

  it("skips empty values", () => {
    expect(parseSkillFrontmatter("---\nname:\ndescription: ok\n---\nB").name).toBeUndefined();
  });
});

describe("skillIdFromPath", () => {
  it("slugifies the file name", () => {
    expect(skillIdFromPath("./skills/Release Notes.md")).toBe("release-notes");
    expect(skillIdFromPath("skills/deep/dive_v2.md")).toBe("dive-v2");
    expect(skillIdFromPath("skills\\windows.md")).toBe("windows");
  });

  it("falls back when nothing usable remains", () => {
    expect(skillIdFromPath("skills/___.md")).toBe("skill");
  });
});
