import type { AgentMessage, AssistantMessage, ModelStreamEvent, ToolDefinition } from "../../shared/protocol";

/**
 * A single model advertised by a provider. Everything except `id` is optional and
 * falls back to MODEL_DEFAULTS so a provider can list models with just an id.
 */
export type ModelDefinition = {
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
};

/**
 * A provider is a declarative description of a model service: where it lives, how
 * to authenticate, and which models it offers. `api` selects the ApiAdapter that
 * knows the wire protocol.
 */
export type ProviderDefinition = {
  id: string;
  label?: string;
  api?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: ModelDefinition[];
};

/**
 * A provider definition merged with model-level overrides and resolved secrets.
 * ApiAdapters only ever see this shape, never the raw config.
 */
export type ResolvedModel = {
  ref: string;
  providerId: string;
  modelId: string;
  label: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
};

/**
 * A normalized model request. This is the only thing an ApiAdapter receives, so
 * adapters stay independent from the agent loop and the session store.
 */
export type ApiRequest = {
  model: ResolvedModel;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
};

/**
 * The wire-protocol layer. One adapter per API family (OpenAI Chat Completions,
 * Anthropic Messages, ...). It must never throw for provider failures: return an
 * AssistantMessage with stopReason "error" so the agent loop can surface it.
 *
 * `stream` is optional. When implemented, the final `done` event must carry the
 * same finalized message `complete` would return.
 */
export interface ApiAdapter {
  readonly id: string;
  complete(request: ApiRequest, signal?: AbortSignal): Promise<AssistantMessage>;
  stream?(request: ApiRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export const MODEL_DEFAULTS = {
  api: "openai-completions",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  supportsTools: true,
  maxTokensField: "max_tokens",
} as const satisfies {
  api: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  maxTokensField: ResolvedModel["maxTokensField"];
};
