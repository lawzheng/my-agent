import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolDefinition,
  ToolResult,
  ToolResultMessage,
} from "../../shared/protocol";
import { text } from "./message";
import type { TeachingModel } from "./model";

export type ToolRegistry = {
  definitions: () => ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

export type RunAgentLoopOptions = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  model: TeachingModel;
  toolRegistry: ToolRegistry;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};

export type RunAgentLoopResult = {
  newMessages: AgentMessage[];
  events: AgentEvent[];
};

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const maxTurns = options.maxTurns ?? 10;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError("maxTurns must be a positive integer");
  }

  const context = [...options.messages];
  const newMessages: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };

  emit({ type: "agent_start" });

  for (let turn = 1; turn <= maxTurns; turn++) {
    emit({ type: "turn_start", turn });
    const assistant = await completeAssistant(options.model, context, options, emit);
    context.push(assistant);
    newMessages.push(assistant);
    emit({ type: "message_end", message: assistant });

    const toolCalls = assistant.content.filter(
      (block): block is ToolCallContent => block.type === "toolCall",
    );
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted" || toolCalls.length === 0) {
      emit({ type: "turn_end", turn, message: assistant, toolResults: [] });
      emit({ type: "agent_end", messages: newMessages });
      return { newMessages, events };
    }

    const toolResults: ToolResultMessage[] = [];
    for (const toolCall of toolCalls) {
      emit({
        type: "tool_execution_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });

      let result: ToolResult;
      let isError = false;
      try {
        result = await options.toolRegistry.execute(toolCall.name, toolCall.arguments);
      } catch (error) {
        isError = true;
        result = { content: [text(error instanceof Error ? error.message : String(error))] };
      }

      emit({
        type: "tool_execution_end",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        isError,
      });

      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        details: result.details,
        isError,
        timestamp: Date.now(),
      };
      context.push(toolResult);
      newMessages.push(toolResult);
      toolResults.push(toolResult);
      emitMessageLifecycle(toolResult, emit);
    }

    emit({ type: "turn_end", turn, message: assistant, toolResults });
  }

  const guardrail = createLoopGuardrailMessage(maxTurns);
  context.push(guardrail);
  newMessages.push(guardrail);
  emitMessageLifecycle(guardrail, emit);
  emit({ type: "agent_end", messages: newMessages });
  return { newMessages, events };
}

function emitMessageLifecycle(
  message: AgentMessage,
  emit: (event: AgentEvent) => void,
): void {
  emit({ type: "message_start", message });
  emitAssistantText(message, emit);
  emit({ type: "message_end", message });
}

function emitAssistantText(
  message: AgentMessage,
  emit: (event: AgentEvent) => void,
): void {
  if (message.role !== "assistant") return;
  for (const block of message.content) {
    if (block.type === "text") {
      emit({ type: "message_update", message, delta: block.text });
    }
  }
}

/**
 * Produce one assistant message. When the model supports streaming, text is
 * emitted chunk by chunk via `message_update` and the finalized message is
 * returned; otherwise it falls back to a single `complete` call.
 */
async function completeAssistant(
  model: TeachingModel,
  context: AgentMessage[],
  options: RunAgentLoopOptions,
  emit: (event: AgentEvent) => void,
): Promise<AssistantMessage> {
  const input = {
    systemPrompt: options.systemPrompt,
    messages: context,
    tools: options.tools,
  };

  if (!model.stream) {
    const assistant = await model.complete(input);
    emit({ type: "message_start", message: assistant });
    emitAssistantText(assistant, emit);
    return assistant;
  }

  // Announce a placeholder first so the UI can open a bubble, then grow it as
  // text arrives. The finalized message is emitted as `message_end`.
  const placeholder: AssistantMessage = {
    role: "assistant",
    content: [],
    stopReason: "pending",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };
  emit({ type: "message_start", message: placeholder });

  let finalized: AssistantMessage | undefined;
  for await (const event of model.stream(input, options.signal)) {
    if (event.type === "text_delta") {
      emit({ type: "message_update", message: placeholder, delta: event.delta });
    } else {
      finalized = event.message;
    }
  }

  const assistant = finalized ?? createStreamGuardrailMessage();
  return assistant;
}

function createStreamGuardrailMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [text("模型流意外结束，没有返回最终消息。")],
    stopReason: "error",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
    errorMessage: "stream_incomplete",
  };
}

function createLoopGuardrailMessage(maxTurns: number): AssistantMessage {
  return {
    role: "assistant",
    content: [text(`已达到最大轮数（${maxTurns}），本次运行已停止。`)],
    stopReason: "error",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
    errorMessage: "max_turns_exceeded",
  };
}