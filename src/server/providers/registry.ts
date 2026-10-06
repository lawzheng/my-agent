import type { CompleteInput, TeachingModel } from "../agent/model";
import { interpolate, resolveSecret } from "./interpolate";
import { MODEL_DEFAULTS, type ApiAdapter, type ApiRequest, type ProviderDefinition, type ResolvedModel } from "./types";

export type ModelRuntime = {
  list(): ResolvedModel[];
  currentRef(): string;
  current(): ResolvedModel;
  select(ref: string): void;
  createModel(ref?: string): TeachingModel;
};

/**
 * Holds registered providers and ApiAdapters, resolves "provider/model" references
 * into concrete model configs, and hands the agent loop a TeachingModel.
 *
 * This mirrors Pi's ModelRegistry: config is declarative, adapters own the wire
 * protocol, and the loop only sees a plain model interface.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();
  private readonly adapters = new Map<string, ApiAdapter>();

  registerAdapter(adapter: ApiAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  registerProvider(definition: ProviderDefinition): void {
    const api = definition.api ?? MODEL_DEFAULTS.api;
    if (!this.adapters.has(api)) {
      throw new Error(`Unknown api "${api}" for provider "${definition.id}"`);
    }
    if (this.providers.has(definition.id)) {
      throw new Error(`Provider already registered: ${definition.id}`);
    }
    this.providers.set(definition.id, definition);
  }

  list(): ResolvedModel[] {
    const models: ResolvedModel[] = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        models.push(this.resolve(`${provider.id}/${model.id}`));
      }
    }
    return models;
  }

  resolve(ref: string): ResolvedModel {
    const separator = ref.indexOf("/");
    if (separator <= 0 || separator === ref.length - 1) {
      throw new Error(`Model ref must look like "provider/model", got "${ref}"`);
    }
    const providerId = ref.slice(0, separator);
    const modelId = ref.slice(separator + 1);

    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const model = provider.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error(`Unknown model "${modelId}" on provider "${providerId}"`);

    const api = provider.api ?? MODEL_DEFAULTS.api;
    if (!this.adapters.has(api)) throw new Error(`No adapter registered for api "${api}"`);

    return {
      ref,
      providerId,
      modelId,
      label: model.label ?? modelId,
      api,
      baseUrl: interpolate(provider.baseUrl),
      apiKey: resolveSecret(provider.apiKey),
      headers: interpolateHeaders(provider.headers),
      contextWindow: model.contextWindow ?? MODEL_DEFAULTS.contextWindow,
      maxOutputTokens: model.maxOutputTokens ?? MODEL_DEFAULTS.maxOutputTokens,
      supportsTools: model.supportsTools ?? MODEL_DEFAULTS.supportsTools,
      maxTokensField: MODEL_DEFAULTS.maxTokensField,
    };
  }

  has(ref: string): boolean {
    try {
      this.resolve(ref);
      return true;
    } catch {
      return false;
    }
  }

  createModel(ref?: string): TeachingModel {
    const resolved = this.resolve(ref ?? this.requireFirstRef());
    const adapter = this.adapters.get(resolved.api);
    if (!adapter) throw new Error(`No adapter registered for api "${resolved.api}"`);

    const request = (input: CompleteInput): ApiRequest => ({
      model: resolved,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      tools: input.tools,
    });

    const model: TeachingModel = {
      complete: (input) => adapter.complete(request(input)),
    };
    if (adapter.stream) {
      model.stream = (input, signal) => adapter.stream!(request(input), signal);
    }
    return model;
  }

  private requireFirstRef(): string {
    const first = this.providers.values().next().value as ProviderDefinition | undefined;
    const model = first?.models[0];
    if (!first || !model) throw new Error("No providers registered");
    return `${first.id}/${model.id}`;
  }
}

function interpolateHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, interpolate(value)]));
}

/**
 * Wrap a registry in a small mutable runtime so the API can expose the current
 * selection (like Pi's /model) and switch models mid-session.
 */
export function createModelRuntime(registry: ProviderRegistry, initialRef?: string): ModelRuntime {
  const available = registry.list();
  if (available.length === 0) throw new Error("No models available");

  const fallback = available[0].ref;
  let currentRef = initialRef && registry.has(initialRef) ? initialRef : fallback;

  return {
    list: () => registry.list(),
    currentRef: () => currentRef,
    current: () => registry.resolve(currentRef),
    select(ref) {
      registry.resolve(ref); // throws on unknown ref
      currentRef = ref;
    },
    createModel: (ref) => registry.createModel(ref ?? currentRef),
  };
}
