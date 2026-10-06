import assert from "node:assert/strict";
import { test } from "node:test";
import { createUserMessage } from "../agent/message";
import { createOpenAICompletionsAdapter } from "./api/openaiCompletions";
import { ProviderRegistry } from "./registry";
import type { ResolvedModel } from "./types";

/**
 * Live integration test against the local gateway. It is opt-in so the normal
 * `npm test` run stays offline:
 *
 *   PI_LIVE_TEST=1 MAGPIE_API_KEY=magpie npx tsx --test src/server/providers/live.test.ts
 */
const enabled = process.env.PI_LIVE_TEST === "1";
const baseUrl = process.env.PI_LIVE_BASE_URL ?? "http://127.0.0.1:3425/v1";
const modelId = process.env.PI_LIVE_MODEL ?? "workbuddy-ai/deepseek-v4.1-flash";

const model: ResolvedModel = {
  ref: `magpie/${modelId}`,
  providerId: "magpie",
  modelId,
  label: modelId,
  api: "openai-completions",
  baseUrl,
  apiKey: process.env.MAGPIE_API_KEY ?? "magpie",
  headers: {},
  contextWindow: 1_000_000,
  maxOutputTokens: 2_048,
  supportsTools: true,
  maxTokensField: "max_tokens",
};

test("live: gateway answers a plain prompt", { skip: !enabled }, async () => {
  const message = await createOpenAICompletionsAdapter().complete({
    model,
    systemPrompt: "You are a terse assistant. Answer in one short sentence.",
    messages: [createUserMessage("Say hello.")],
    tools: [],
  });

  assert.equal(message.stopReason, "stop", message.errorMessage ?? "no error message");
  assert.ok(message.usage.totalTokens > 0, "usage should be reported");
  const text = message.content.find((block) => block.type === "text");
  assert.ok(text && text.type === "text" && text.text.length > 0, "expected assistant text");
});

test("live: gateway calls a tool and reports toolUse", { skip: !enabled }, async () => {
  const message = await createOpenAICompletionsAdapter().complete({
    model,
    systemPrompt: "You are a teaching agent. Use the provided tools when asked.",
    messages: [createUserMessage("列出工作区文件")],
    tools: [
      {
        name: "list_files",
        description: "List files in the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
  });

  assert.equal(message.stopReason, "toolUse", message.errorMessage ?? "no error message");
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.ok(toolCall && toolCall.type === "toolCall");
  assert.equal(toolCall.name, "list_files");
});

test("live: registry resolves the gateway model end to end", { skip: !enabled }, async () => {
  const registry = new ProviderRegistry();
  registry.registerAdapter(createOpenAICompletionsAdapter());
  registry.registerProvider({
    id: "magpie",
    baseUrl,
    api: "openai-completions",
    apiKey: "$MAGPIE_API_KEY",
    models: [{ id: modelId, contextWindow: 1_000_000 }],
  });

  const resolved = registry.resolve(`magpie/${modelId}`);
  assert.equal(resolved.apiKey, process.env.MAGPIE_API_KEY ?? "magpie");

  const message = await registry.createModel(`magpie/${modelId}`).complete({
    systemPrompt: "Answer in one short sentence.",
    messages: [createUserMessage("Reply with the single word: ready")],
    tools: [],
  });

  assert.equal(message.stopReason, "stop", message.errorMessage ?? "no error message");
});

test("live: gateway streams text deltas that rebuild the final message", { skip: !enabled }, async () => {
  const events = [];
  for await (const event of createOpenAICompletionsAdapter().stream!(
    {
      model,
      systemPrompt: "Count from 1 to 5, one number per line.",
      messages: [createUserMessage("Go.")],
      tools: [],
    },
  )) {
    events.push(event);
  }

  const deltas = events.filter((event) => event.type === "text_delta");
  assert.ok(deltas.length > 1, "expected multiple text deltas");

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.message.stopReason, "stop", done.message.errorMessage ?? "no error message");

  const streamed = deltas.map((event) => event.delta).join("");
  const finalText = done.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(streamed, finalText);
});

test("live: gateway streams a tool call", { skip: !enabled }, async () => {
  const events = [];
  for await (const event of createOpenAICompletionsAdapter().stream!(
    {
      model,
      systemPrompt: "You are a teaching agent. Use the provided tools when asked.",
      messages: [createUserMessage("列出工作区文件")],
      tools: [
        {
          name: "list_files",
          description: "List files in the workspace.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    },
  )) {
    events.push(event);
  }

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.message.stopReason, "toolUse", done.message.errorMessage ?? "no error message");
  const toolCall = done.message.content.find((block) => block.type === "toolCall");
  assert.equal(toolCall?.type === "toolCall" && toolCall.name, "list_files");
});
