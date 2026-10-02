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
    const assistant = await options.model.complete({
      systemPrompt: options.systemPrompt,
      messages: context,
      tools: options.tools,
    });
    context.push(assistant);
    newMessages.push(assistant);
    emitMessageLifecycle(assistant, emit);

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
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") {
        emit({ type: "message_update", message, delta: block.text });
      }
    }
  }
  emit({ type: "message_end", message });
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