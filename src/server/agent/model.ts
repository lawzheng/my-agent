import type {
  AgentMessage,
  AssistantMessage,
  ModelStreamEvent,
  ToolDefinition,
} from "../../shared/protocol";

export type CompleteInput = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

export interface TeachingModel {
  complete(input: CompleteInput): Promise<AssistantMessage>;
  /**
   * Optional streaming variant. When present the agent loop consumes it and
   * emits incremental `message_update` events; `complete` stays as the fallback
   * and the source of truth for non-streaming callers.
   */
  stream?(input: CompleteInput, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
