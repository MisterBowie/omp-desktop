import { expect, it } from "vitest";
import { expandSkillCommand, skillCommandName } from "./skill-command.js";
const commands = [{ name: "skill:demo/review", kind: "skill" as const, skillId: "demo/review", title: "Review" }];
it("resolves namespaced and legacy skills with arguments without loading bodies", () => {
  expect(skillCommandName("demo/review")).toBe("skill:demo/review");
  for (const content of ["/skill:demo/review inspect src", "/demo/review inspect src"]) {
    expect(expandSkillCommand(content, commands)).toEqual({ command: content, expanded: 'Call the `Skill` tool with id "demo/review" before answering this request. Follow the loaded skill instructions.\n\ninspect src' });
  }
  expect(() => expandSkillCommand("/skill:missing", commands)).toThrow(/not active/);
  expect(expandSkillCommand("/unknown", commands)).toBeNull();
  expect(expandSkillCommand("/demo/review", [...commands, { name: "demo/review", kind: "builtin", id: "app", title: "App" }])).toBeNull();
});
