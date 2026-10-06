import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, ToolDefinition } from "../../../shared/protocol";
import { createAssistantMessage, createUserMessage, text } from "../../agent/message";
import type { ResolvedModel } from "../types";
import {
  createOpenAICompletionsAdapter,
  fromWireResponse,
  toWireMessages,
} from "./openaiCompletions";

const model: ResolvedModel = {
  ref: "local/test-model",
  providerId: "local",
  modelId: "test-model",
  label: "Test Model",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9999/v1/",
  apiKey: "test-key",
  headers: { "x-extra": "1" },
  contextWindow: 128_000,
  maxOutputTokens: 512,
  supportsTools: true,
  maxTokensField: "max_tokens",
};

const tools: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files.",
    parameters: { type: "object", properties: {} },
  },
];

test("toWireMessages converts every agent role to the OpenAI wire format", () => {
  const messages: AgentMessage[] = [
    createUserMessage("列出文件"),
    createAssistantMessage(
      [
        text("好的"),
        { type: "toolCall", id: "call_1", name: "list_files", arguments: { path: "." } },
      ],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "list_files",
      content: [text("README.md")],
      isError: false,
      timestamp: 1,
    },
  ];

  const wire = toWireMessages("You are a teaching agent.", messages);
  assert.deepEqual(wire[0], { role: "system", content: "You are a teaching agent." });
  assert.deepEqual(wire[1], { role: "user", content: "列出文件" });
  assert.deepEqual(wire[2], {
    role: "assistant",
    content: "好的",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } },
    ],
  });
  assert.deepEqual(wire[3], { role: "tool", tool_call_id: "call_1", content: "README.md" });
});

test("toWireMessages drops an empty assistant message", () => {
  const wire = toWireMessages("sys", [createAssistantMessage([])]);
  assert.equal(wire.length, 1);
});

test("adapter posts to /chat/completions with auth, tools, and max_tokens", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "working on it",
              tool_calls: [
                { id: "call_9", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const adapter = createOpenAICompletionsAdapter({ fetchImpl });
  const message = await adapter.complete({
    model,
    systemPrompt: "sys",
    messages: [createUserMessage("列出文件")],
    tools,
  });

  assert.equal(captured?.url, "http://127.0.0.1:9999/v1/chat/completions");
  const headers = captured?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["x-extra"], "1");

  const body = JSON.parse(String(captured?.init.body));
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools[0].function.name, "list_files");

  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.usage, { input: 12, output: 3, totalTokens: 15 });
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall, {
    type: "toolCall",
    id: "call_9",
    name: "list_files",
    arguments: { path: "." },
  });
});

test("adapter omits tools when the model does not support them", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await createOpenAICompletionsAdapter({ fetchImpl }).complete({
    model: { ...model, supportsTools: false, maxTokensField: "max_completion_tokens" },
    systemPrompt: "sys",
    messages: [createUserMessage("hi")],
    tools,
  });

  assert.equal(body?.tools, undefined);
  assert.equal(body?.max_completion_tokens, 512);
});

test("adapter returns an error message instead of throwing on HTTP failure", async () => {
  const fetchImpl = (async () =>
    new Response("boom", { status: 500 })) as unknown as typeof fetch;

  const message = await createOpenAICompletionsAdapter({ fetchImpl }).complete({
    model,
    systemPrompt: "sys",
    messages: [createUserMessage("hi")],
    tools: [],
  });

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /模型返回 500/);
});

test("adapter returns an error message when the network rejects", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const message = await createOpenAICompletionsAdapter({ fetchImpl }).complete({
    model,
    systemPrompt: "sys",
    messages: [createUserMessage("hi")],
    tools: [],
  });

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /ECONNREFUSED/);
});

test("fromWireResponse falls back to an error for an empty choice", () => {
  assert.equal(fromWireResponse({}).stopReason, "error");
  assert.equal(
    fromWireResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] })
      .stopReason,
    "error",
  );
});

test("fromWireResponse tolerates malformed tool arguments", () => {
  const message = fromWireResponse({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{not json" } }],
        },
      },
    ],
  });
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content[0], {
    type: "toolCall",
    id: "c1",
    name: "list_files",
    arguments: {},
  });
});
