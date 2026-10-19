import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { dedupeToolCallMessages } from "./tool-call-dedupe.js";

const call = (id: string) => ({ type: "toolCall", id, name: "Read", arguments: {} });
const text = (value: string) => ({ type: "text", text: value });
function assistant(content: unknown[]): AgentMessage {
  return { role: "assistant", content, timestamp: 1 } as unknown as AgentMessage;
}
function result(toolCallId: string): AgentMessage {
  return {
    role: "toolResult", toolCallId, toolName: "Read", content: [text("ok")],
    isError: false, timestamp: 2,
  } as AgentMessage;
}
function outputIds(messages: AgentMessage[]) {
  const model = { api: "openai-completions", id: "fixture", provider: "fixture", input: ["text"] } as never;
  return transformMessages(messages as never, model)
    .filter((message) => message.role === "toolResult")
    .map((message) => (message as { toolCallId?: string }).toolCallId);
}

describe("provider request tool-call pairing", () => {
  it("preserves a valid request and its identity", () => {
    const messages = [assistant([call("one")]), result("one"), assistant([text("done")])];
    const drop = dedupeToolCallMessages(messages);
    expect(drop.messages).toBe(messages);
    expect(drop.droppedCount).toBe(0);
    expect(drop.droppedMessages).toBe(0);
  });

  it("prevents the real adapter from synthesizing a duplicate result after a replay", () => {
    const message = assistant([text("reading"), call("one")]);
    const answer = result("one");
    // Keeping a replay's text between the call and result produces two outputs.
    expect(outputIds([message, assistant([text("reading")]), answer])).toEqual(["one", "one"]);
    const drop = dedupeToolCallMessages([message, message, answer, answer]);
    expect(drop.messages).toEqual([message, answer]);
    expect(drop.droppedMessages).toBe(1);
    expect(drop.droppedCount).toBe(2);
    expect(outputIds(drop.messages)).toEqual(["one"]);
  });

  it("remaps a single mismatched item id even without a duplicate to drop", () => {
    const answer = result("one|different-item");
    const messages = [assistant([call("one|original-item")]), answer];
    const drop = dedupeToolCallMessages(messages);
    expect(drop.droppedCount).toBe(0);
    expect(drop.messages).not.toBe(messages);
    expect(drop.messages[1]).toMatchObject({ toolCallId: "one|original-item" });
    expect(answer).toMatchObject({ toolCallId: "one|different-item" });
    expect(outputIds(drop.messages)).toEqual(["one|original-item"]);
  });

  it("deduplicates composite ids by the call id sent to the provider", () => {
    const message = assistant([call("one|item-a")]);
    const drop = dedupeToolCallMessages([
      message, assistant([text("replay"), call("one|item-b")]),
      result("one|item-c"), result("one|item-d"),
    ]);
    expect(drop.messages).toHaveLength(2);
    expect(drop.droppedIds).toEqual(["one"]);
    expect(drop.droppedMessages).toBe(1);
    expect(outputIds(drop.messages)).toEqual(["one|item-a"]);
  });

  it("retains a new call in a message that also contains a replay", () => {
    const drop = dedupeToolCallMessages([
      assistant([call("one")]), assistant([text("new work"), call("one"), call("two")]),
      result("one"), result("two"),
    ]);
    expect(drop.droppedMessages).toBe(0);
    expect(drop.messages[1]).toMatchObject({ content: [text("new work"), call("two")] });
  });

  it("leaves an unanswered call for the adapter's existing placeholder", () => {
    const messages = [assistant([call("one")])];
    expect(dedupeToolCallMessages(messages).messages).toBe(messages);
    expect(outputIds(messages)).toEqual(["one"]);
  });
});
