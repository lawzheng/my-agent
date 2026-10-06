import type {
  AgentMessage,
  AssistantMessage,
  ModelStreamEvent,
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

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(model),
            ...model.headers,
          },
          body: JSON.stringify(buildBody(request, false)),
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

    async *stream(request, signal) {
      const { model } = request;
      const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(model),
            ...model.headers,
          },
          body: JSON.stringify(buildBody(request, true)),
          signal,
        });
      } catch (error) {
        yield { type: "done", message: streamFailure(error, signal) };
        return;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        yield { type: "done", message: failure(`模型返回 ${response.status}：${detail.slice(0, 500)}`) };
        return;
      }
      if (!response.body) {
        yield { type: "done", message: failure("模型响应没有可读的数据流") };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const state = createStreamState();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
            buffer = buffer.slice(newlineIndex + 1);
            const delta = consumeStreamLine(line, state);
            if (delta !== undefined) yield { type: "text_delta", delta };
          }
        }
      } catch (error) {
        yield { type: "done", message: streamFailure(error, signal) };
        return;
      } finally {
        reader.releaseLock();
      }

      yield { type: "done", message: finalizeStream(state) };
    },
  };
}

function buildBody(request: ApiRequest, stream: boolean): Record<string, unknown> {
  const { model } = request;
  const body: Record<string, unknown> = {
    model: model.modelId,
    messages: toWireMessages(request.systemPrompt, request.messages),
    [model.maxTokensField]: model.maxOutputTokens,
  };
  if (request.tools.length > 0 && model.supportsTools) {
    body.tools = request.tools.map(toWireTool);
    body.tool_choice = "auto";
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

type PartialToolCall = { id?: string; name?: string; args: string };

type StreamState = {
  text: string;
  toolCalls: Map<number, PartialToolCall>;
  finishReason?: string;
  usage?: Usage;
};

function createStreamState(): StreamState {
  return { text: "", toolCalls: new Map() };
}

/**
 * Parse one SSE line. Returns a text delta when the chunk carried assistant text.
 * Tool-call fragments and usage are accumulated into `state` because they can be
 * split across many chunks.
 */
function consumeStreamLine(line: string, state: StreamState): string | undefined {
  if (line.length === 0 || line.startsWith(":") || !line.startsWith("data:")) return undefined;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return undefined;

  let chunk: Record<string, any>;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return undefined;
  }

  if (chunk.usage) state.usage = parseUsage(chunk);

  const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, any>) : undefined;
  if (!choice) return undefined;
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;

  const delta = choice.delta as Record<string, any> | undefined;
  if (!delta) return undefined;

  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const index = typeof call.index === "number" ? call.index : 0;
    const existing = state.toolCalls.get(index) ?? { args: "" };
    if (typeof call.id === "string" && call.id.length > 0) existing.id = call.id;
    if (typeof call.function?.name === "string" && call.function.name.length > 0) {
      existing.name = call.function.name;
    }
    if (typeof call.function?.arguments === "string") existing.args += call.function.arguments;
    state.toolCalls.set(index, existing);
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    state.text += delta.content;
    return delta.content;
  }
  return undefined;
}

function finalizeStream(state: StreamState): AssistantMessage {
  if (state.finishReason === "content_filter" || state.finishReason === "network_error") {
    return failure(`模型流结束原因：${state.finishReason}`);
  }

  const content: AssistantMessage["content"] = [];
  if (state.text.length > 0) content.push({ type: "text", text: state.text });

  const calls = [...state.toolCalls.entries()].sort((left, right) => left[0] - right[0]);
  for (const [index, call] of calls) {
    content.push({
      type: "toolCall",
      id: call.id ?? `call_${index}`,
      name: call.name ?? "unknown",
      arguments: parseArguments(call.args),
    });
  }

  if (content.length === 0) {
    return failure(`模型返回了空消息（finish_reason: ${state.finishReason ?? "unknown"}）`);
  }

  const hasToolCall = content.some((block) => block.type === "toolCall");
  return {
    role: "assistant",
    content,
    stopReason: hasToolCall ? "toolUse" : "stop",
    usage: state.usage ?? { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };
}

function streamFailure(error: unknown, signal?: AbortSignal): AssistantMessage {
  if (signal?.aborted) {
    return { ...failure("模型请求已中止"), stopReason: "aborted" };
  }
  return failure(`请求模型失败：${describeError(error)}`);
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
