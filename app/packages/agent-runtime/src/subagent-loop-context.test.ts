import { expect, it, vi } from "vitest";
import { SubagentRun } from "./subagent.js";

// Context decisions have their own suite; force a boundary replacement here
// while keeping the real Agent and the delegate's context handoff.
vi.mock("./subagent-context.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./subagent-context.js")>(),
  prepareDelegateTurnContext: vi.fn(async () => ({
    kind: "degraded" as const, messages: [], tokensBefore: 1,
  })),
}));

it("a delegate turn boundary gives the loop a separate message array", async () => {
  const run = new SubagentRun({
    definition: { name: "explorer", description: "Inspect files", tools: ["Read"], prompt: "Inspect", source: "builtin" },
    sessionId: "fixture", turnId: "turn", parentToolCallId: "task", task: "Inspect files",
    provider: {
      id: "fixture", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1",
      modelId: "fixture", apiKey: "", authKind: "none", supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    },
    thinkingLevel: "off", systemPrompt: "system", tools: [], onEvent() {},
  });
  const agent = (run as unknown as {
    agent: {
      state: { messages: unknown[] };
      prepareNextTurnWithContext: (turn: unknown, signal: AbortSignal) => Promise<{ context?: { messages: unknown[] } }>;
    };
  }).agent;
  agent.state.messages = [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "Inspect files", timestamp: 1 },
  ];
  const update = await agent.prepareNextTurnWithContext({ toolResults: [] }, new AbortController().signal);
  expect(update.context).toBeDefined();
  const state = [...agent.state.messages];
  expect(update.context!.messages).not.toBe(agent.state.messages);
  update.context!.messages.push({ role: "toolResult", toolCallId: "probe" });
  expect(agent.state.messages).toEqual(state);
});
