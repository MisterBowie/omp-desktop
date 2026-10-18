import { describe, expect, it } from "vitest";
import { readTodoPhases, todoPhasesFromResult } from "./session-todos.js";

const phases = [{ name: "Build", tasks: [{ content: "Implement", status: "in_progress", blocker: "Waiting" }] }];
describe("native session todo snapshots", () => {
  it("preserves phases, blocked/abandoned states, and explicit empty snapshots", () => {
    expect(readTodoPhases(phases)).toEqual(phases);
    expect(readTodoPhases([])).toEqual([]);
    for (const status of ["pending", "completed", "blocked", "abandoned"]) {
      expect(readTodoPhases([{ name: "P", tasks: [{ content: "T", status }] }])).toBeDefined();
    }
    expect(readTodoPhases([{ name: "P", tasks: [{ content: "T", status: "invented" }] }])).toBeUndefined();
  });
  it("accepts only successful native todo mutations, never views or partial/error results", () => {
    expect(todoPhasesFromResult("todo", { details: { op: "init", phases } })).toEqual(phases);
    for (const result of [{ details: { op: "view", phases } }, { isError: true, details: { phases } }, { details: { phases, truncated: true } }]) {
      expect(todoPhasesFromResult("todo", result)).toBeUndefined();
    }
    expect(todoPhasesFromResult("other", { details: { phases } })).toBeUndefined();
  });
});
