import { IPC } from "@pi-desktop/shared";
import type { OmpMemoryService } from "../runtime/omp-memory";
import type { IpcRegistrar } from "./types";
export function registerMemoryIpc(registrar: IpcRegistrar, memory: OmpMemoryService): void {
  registrar.handle(IPC.invoke.ompMemorySettingsGet, () => memory.getSettings());
  registrar.handle(IPC.invoke.ompMemorySettingsSet, (value) => memory.setSettings(value));
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid memory request");
    return value as Record<string, unknown>;
  };
  registrar.handle(IPC.invoke.ompMemoryQuery, (value) => memory.query(object(value)));
  registrar.handle(IPC.invoke.ompMemoryClear, (value) => memory.clear(object(value)));
}
