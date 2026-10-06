import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "../../shared/protocol";
import { createAssistantMessage, createUserMessage, messageText, text } from "./message";
import type { TeachingModel } from "./model";
import { MockModel } from "./mockModel";
import { runAgentLoop } from "./loop";
import { ToolRegistry } from "./tools";

describe("runAgentLoop", () => {
  test("continues after a tool call and returns the final assistant message", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: "list_files",
      description: "List test files.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: [text("README.md\nagent-notes.md")],
          details: { entries: ["README.md", "agent-notes.md"] },
        };
      },
    });

    const result = await runAgentLoop({
      systemPrompt: "You are a teaching agent.",
      messages: [createUserMessage("列出工作区文件")],
      tools: toolRegistry.definitions(),
      model: new MockModel(),
      toolRegistry,
    });

    assert.equal(result.newMessages.length, 3);
    assert.equal(result.newMessages[0].role, "assistant");
    assert.equal((result.newMessages[0] as AssistantMessage).stopReason, "toolUse");
    assert.equal(result.newMessages[1].role, "toolResult");
    assert.equal(result.newMessages[2].role, "assistant");
    assert.match(messageText(result.newMessages[2]), /README\.md/);
    assert.ok(result.events.some((event) => event.type === "tool_execution_start"));
    assert.ok(result.events.some((event) => event.type === "agent_end"));
  });

  test("turns an unknown tool into an isError tool result", async () => {
    const result = await runAgentLoop({
      systemPrompt: "You are a teaching agent.",
      messages: [createUserMessage("列出工作区文件")],
      tools: [
        {
          name: "list_files",
          description: "Advertised but not registered.",
          parameters: { type: "object", properties: {} },
        },
      ],
      model: new MockModel(),
      toolRegistry: new ToolRegistry(),
    });

    const toolResult = result.newMessages.find(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    assert.ok(toolResult);
    assert.equal(toolResult.isError, true);
    assert.match(messageText(toolResult), /Tool not found: list_files/);
  });

  test("stops a repeating tool loop at maxTurns", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: "list_files",
      description: "Always succeeds.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [text("README.md")] };
      },
    });

    const loopingModel: TeachingModel = {
      async complete() {
        return createAssistantMessage(
          [
            {
              type: "toolCall",
              id: "call_loop",
              name: "list_files",
              arguments: { path: "." },
            },
          ],
          "toolUse",
        );
      },
    };

    const result = await runAgentLoop({
      systemPrompt: "You are a teaching agent.",
      messages: [createUserMessage("一直调用工具")],
      tools: toolRegistry.definitions(),
      model: loopingModel,
      toolRegistry,
      maxTurns: 1,
    });

    const last = result.newMessages.at(-1);
    assert.equal(last?.role, "assistant");
    assert.equal((last as AssistantMessage).stopReason, "error");
    assert.equal((last as AssistantMessage).errorMessage, "max_turns_exceeded");
  });

  test("streams text as incremental message_update events", async () => {
    const streamingModel: TeachingModel = {
      async complete() {
        throw new Error("complete should not be called when stream is available");
      },
      async *stream() {
        for (const delta of ["Hel", "lo", " world"]) {
          yield { type: "text_delta", delta };
        }
        yield {
          type: "done",
          message: createAssistantMessage([text("Hello world")]),
        };
      },
    };

    const result = await runAgentLoop({
      systemPrompt: "You are a teaching agent.",
      messages: [createUserMessage("hi")],
      tools: [],
      model: streamingModel,
      toolRegistry: new ToolRegistry(),
    });

    const deltas = result.events
      .filter((event) => event.type === "message_update")
      .map((event) => (event as { delta: string }).delta);
    assert.deepEqual(deltas, ["Hel", "lo", " world"]);

    const starts = result.events.filter((event) => event.type === "message_start");
    assert.equal(starts.length, 1);
    assert.equal((starts[0] as { message: AssistantMessage }).message.stopReason, "pending");

    const ends = result.events.filter((event) => event.type === "message_end");
    assert.equal(ends.length, 1);
    assert.equal((ends[0] as { message: AssistantMessage }).message.stopReason, "stop");
    assert.equal(messageText(result.newMessages[0]), "Hello world");
  });

  test("turns an incomplete stream into an error message", async () => {
    const brokenModel: TeachingModel = {
      async complete() {
        throw new Error("unused");
      },
      async *stream() {
        yield { type: "text_delta", delta: "partial" };
      },
    };

    const result = await runAgentLoop({
      systemPrompt: "You are a teaching agent.",
      messages: [createUserMessage("hi")],
      tools: [],
      model: brokenModel,
      toolRegistry: new ToolRegistry(),
    });

    const last = result.newMessages.at(-1) as AssistantMessage;
    assert.equal(last.stopReason, "error");
    assert.equal(last.errorMessage, "stream_incomplete");
  });
});
