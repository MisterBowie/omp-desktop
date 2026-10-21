/** Read-only projection of the native OMP Todo contract. The runtime owns edits. */
export type SessionTodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type SessionTodoPhase = { name: string; tasks: Array<{ content: string; status: SessionTodoStatus; blocker?: string }> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTodoPhases(value: unknown): SessionTodoPhase[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: SessionTodoPhase[] = [];
  for (const phase of value) {
    if (!record(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return undefined;
    const tasks: SessionTodoPhase["tasks"] = [];
    for (const task of phase.tasks) {
      if (!record(task) || typeof task.content !== "string" ||
          typeof task.status !== "string" || !["pending", "in_progress", "completed", "abandoned", "blocked"].includes(task.status) ||
          (task.blocker !== undefined && typeof task.blocker !== "string")) return undefined;
      tasks.push({ content: task.content, status: task.status as SessionTodoStatus,
        ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}) });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

/** Ignore failures, views and truncated envelopes: none commits a new list. */
export function todoPhasesFromResult(toolName: string | undefined, result: unknown, isError = false): SessionTodoPhase[] | undefined {
  if (toolName !== "todo" || isError || !record(result) || result.isError || result.truncated) return undefined;
  const details = result.details;
  if (!record(details) || details.op === "view" || details.truncated) return undefined;
  return readTodoPhases(details.phases);
}
