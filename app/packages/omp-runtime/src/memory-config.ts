import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import type { OmpMemorySettings } from "@pi-desktop/shared";

export type OmpMemoryLaunchConfig = OmpMemorySettings & {
  dbPath: string;
  management?: boolean;
  modelSelector?: string;
};
/** Each exact execution directory (including each worktree) has its own durable store. */
export function ompMemoryDirectory(dataRoot: string, projectDirectory: string): string {
  if (!isAbsolute(dataRoot) || !isAbsolute(projectDirectory))
    throw new Error("Absolute memory paths required");
  const key = createHash("sha256").update(normalize(projectDirectory)).digest("hex");
  return join(dataRoot, "omp-memory", key);
}
export function memoryOverlayLines(config?: OmpMemoryLaunchConfig): string[] {
  if (!config || (!config.autoSave && !config.autoRead && !config.management))
    return ["memory:", "  backend: off", "autolearn:", "  enabled: false"];
  if (!isAbsolute(config.dbPath) || /[\r\n\0]/.test(config.dbPath))
    throw new Error("Invalid memory database path");
  if (
    config.modelSelector !== undefined &&
    (typeof config.modelSelector !== "string" ||
      /[\r\n\0]/.test(config.modelSelector) ||
      config.modelSelector.length > 2048)
  )
    throw new Error("Invalid memory model selector");
  if (!config.management && !config.modelSelector)
    throw new Error("A bound conversation model is required for memory");
  return [
    "memory:",
    "  backend: mnemopi",
    "mnemopi:",
    `  dbPath: ${JSON.stringify(config.dbPath)}`,
    "  scoping: global",
    "  bank: desktop",
    `  autoRetain: ${config.autoSave}`,
    `  autoRecall: ${config.autoRead}`,
    "  retainFromSessionStart: true",
    "  noEmbeddings: true",
    `  llmMode: ${config.management ? "none" : "smol"}`,
    ...(config.management ? [] : ["modelRoles:", `  memory: ${JSON.stringify(config.modelSelector)}`]),
    "autolearn:",
    "  enabled: false",
    "  autoContinue: false",
  ];
}
