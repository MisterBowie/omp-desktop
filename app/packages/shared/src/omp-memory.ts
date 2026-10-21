/** Desktop-owned preferences; OMP remains the sole memory database writer. */
export type OmpMemorySettings = { autoSave: boolean; autoRead: boolean };
export type OmpMemoryItem = {
  id: string;
  content: string;
  source?: string | null;
  timestamp?: string | null;
};
export type OmpMemoryPage = { items: OmpMemoryItem[]; total: number; offset: number };
export const DEFAULT_OMP_MEMORY: OmpMemorySettings = { autoSave: false, autoRead: false };
export function parseOmpMemorySettings(value: unknown): OmpMemorySettings {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof Reflect.get(value, "autoSave") !== "boolean" ||
    typeof Reflect.get(value, "autoRead") !== "boolean" ||
    Object.keys(value).some((key) => key !== "autoSave" && key !== "autoRead")
  ) {
    throw Object.assign(new Error("Invalid memory settings"), { errorCode: "INVALID_PARAMS" });
  }
  return { autoSave: Reflect.get(value, "autoSave"), autoRead: Reflect.get(value, "autoRead") };
}
