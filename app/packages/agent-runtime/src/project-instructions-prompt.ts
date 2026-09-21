import type { ProjectInstructions } from "./project-instructions.js";

export function projectInstructionsPrompt(
  instructions?: ProjectInstructions,
): string | undefined {
  if (!instructions?.entries.length) return undefined;
  return [
    "# Project instructions",
    "",
    "The following instructions are loaded by PI-Desktop. Follow them when they apply to the task; entries later in this section are closer to the file being worked on and take precedence.",
    "",
    ...instructions.entries.flatMap((entry) => [
      `## ${entry.source}`,
      "",
      entry.content,
      "",
    ]),
  ].join("\n").trimEnd();
}
