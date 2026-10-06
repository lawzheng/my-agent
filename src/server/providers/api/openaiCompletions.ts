import type {
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolDefinition,
  Usage,
} from "../../../shared/protocol";
import type { ApiAdapter, ApiRequest, ResolvedModel } from "../types";

type FetchLike = typeof fetch;

type WireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; name?: string; content: string };

export type OpenAICompletionsOptions = {
  fetchImpl?: FetchLike;
};

/**
 * Adapter for the OpenAI Chat Completions wire protocol. Covers OpenAI itself and
 * the many compatible gateways (DeepSeek, Qwen, Kimi, Ollama, vLLM, LM Studio,
 * the local magpie gateway, ...).
 */
export function createOpenAICompletionsAdapter(
  options: OpenAICompletionsOptions = {},
): ApiAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: "openai-completions",

    async complete(request, signal) {
      const { model } = request;
      const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;

      const body: Record<string, unknown> = {
        model: model.modelId,
        messages: toWireMessages(request.systemPrompt, request.messages),
        [model.maxTokensField]: model.maxOutputTokens,
      };
      if (request.tools.length > 0 && model.supportsTools) {
        body.tools = request.tools.map(toWireTool);
        body.tool_choice = "auto";
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(model),
            ...model.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        return failure(`请求模型失败：${describeError(error)}`);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return failure(`模型返回 ${response.status}：${detail.slice(0, 500)}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        return failure(`模型响应不是合法 JSON：${describeError(error)}`);
      }

      return fromWireResponse(payload);
    },
  };
}

function authHeaders(model: ResolvedModel): Record<string, string> {
  return model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {};
}

function toWireTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function toWireMessages(systemPrompt: string, messages: AgentMessage[]): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: joinText(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      const text = joinText(message.content);
      const toolCalls = message.content
        .filter((block): block is ToolCallContent => block.type === "toolCall")
        .map<WireToolCall>((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));

      // Some providers reject an assistant message with neither content nor tool calls.
      if (text.length === 0 && toolCalls.length === 0) continue;

      wire.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    wire.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: joinText(message.content) || "(no tool output)",
    });
  }

  return wire;
}

function joinText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function fromWireResponse(payload: unknown): AssistantMessage {
  const choices = (payload as { choices?: unknown })?.choices;
  const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  const raw = choice?.message as Record<string, unknown> | undefined;
  if (!raw) return failure("模型响应缺少 choices[0].message");

  const content: AssistantMessage["content"] = [];
  if (typeof raw.content === "string" && raw.content.length > 0) {
    content.push({ type: "text", text: raw.content });
  }
  const rawToolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  for (const call of rawToolCalls as Array<Record<string, any>>) {
    content.push({
      type: "toolCall",
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${content.length}`,
      name: call.function?.name ?? "unknown",
      arguments: parseArguments(call.function?.arguments),
    });
  }

  const hasToolCall = content.some((block) => block.type === "toolCall");
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;

  if (content.length === 0) {
    return failure(`模型返回了空消息（finish_reason: ${finishReason ?? "unknown"}）`);
  }

  return {
    role: "assistant",
    content,
    stopReason: hasToolCall ? "toolUse" : "stop",
    usage: parseUsage(payload),
    timestamp: Date.now(),
  };
}

export function parseUsage(payload: unknown): Usage {
  const usage = (payload as { usage?: Record<string, unknown> })?.usage;
  const input = numberOrZero(usage?.prompt_tokens);
  const output = numberOrZero(usage?.completion_tokens);
  const total = numberOrZero(usage?.total_tokens) || input + output;
  return { input, output, totalTokens: total };
}

export function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message }],
    stopReason: "error",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
    errorMessage: message,
  };
}
