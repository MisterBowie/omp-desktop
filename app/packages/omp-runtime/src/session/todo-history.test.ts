import { expect, it } from "vitest";
import { projectOmpHistory } from "./history.js";

it("restores Todo from the active branch before paging, including native custom edits", () => {
  const phases = [{ name: "Ship", tasks: [{ content: "Check", status: "pending" }] }];
  const done = [{ name: "Ship", tasks: [{ content: "Check", status: "completed" }] }];
  const entries = [
    { id: "a", parentId: null, type: "message", message: { role: "toolResult", toolName: "todo", toolCallId: "t", content: [], details: { op: "init", phases } } },
    { id: "fork", parentId: "a", type: "custom", customType: "user_todo_edit", data: { phases: [] } },
    { id: "b", parentId: "a", type: "custom", customType: "user_todo_edit", data: { phases: done } },
    { id: "c", parentId: "b", type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  expect(projectOmpHistory(entries, "c", { sessionId: "s", messageLimit: 1 }).todoPhases).toEqual(done);
  expect(projectOmpHistory(entries, "fork", { sessionId: "s", messageLimit: 1 }).todoPhases).toEqual([]);
  expect(projectOmpHistory(entries, "a", { sessionId: "s", messageLimit: 1 }).todoPhases).toEqual(phases);
});
