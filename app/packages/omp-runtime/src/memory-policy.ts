/** Fixed per-run user choices also govern model-initiated memory tools. */
export function memoryToolRefusal(
  tool: string,
  input: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  if (["retain", "learn", "memory_edit"].includes(tool) && env.OMP_DESKTOP_MEMORY_AUTO_SAVE !== "1")
    return "Memory saving is disabled in OMP Desktop settings";
  const readsMemory =
    tool === "read" &&
    typeof input?.path === "string" &&
    input.path.trim().toLowerCase().startsWith("memory://");
  if ((["recall", "reflect"].includes(tool) || readsMemory) && env.OMP_DESKTOP_MEMORY_AUTO_READ !== "1")
    return "Memory recall is disabled in OMP Desktop settings";
  return null;
}
