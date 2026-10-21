import type { ComposerCommand } from "./types.js";

/** One namespace for built-in, user and plugin skills; ids remain unchanged. */
export function skillCommandName(id: string): string { return `skill:${id}`; }

export function expandSkillCommand(content: string, commands: readonly ComposerCommand[]): { expanded: string; command: string } | null {
  if (!content.startsWith("/")) return null;
  const end = content.search(/\s/);
  const name = content.slice(1, end < 0 ? undefined : end);
  const exact = commands.find((command) => command.name === name);
  // Legacy aliases remain valid unless a real app/template command owns them.
  const skill = exact ?? commands.find((command) => command.kind === "skill" && command.skillId === name);
  if (skill?.kind !== "skill" || !skill.skillId) {
    if (name.startsWith("skill:")) throw Object.assign(new Error("The requested skill is not active in this session's project"), { errorCode: "INVALID_ARGUMENT" });
    return null;
  }
  const body = end < 0 ? "" : content.slice(end).trim();
  return {
    command: content,
    expanded: [
      `Call the \`Skill\` tool with id ${JSON.stringify(skill.skillId)} before answering this request. Follow the loaded skill instructions.`,
      body,
    ].filter(Boolean).join("\n\n"),
  };
}
