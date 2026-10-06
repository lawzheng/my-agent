import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelDefinition, ProviderDefinition } from "./types";

export type ProvidersConfig = {
  defaultModel?: string;
  providers: ProviderDefinition[];
};

export const DEFAULT_PROVIDERS_FILE = "providers.json";

/**
 * Load and validate a providers config file. The file is trusted input: it may
 * contain `!command` secrets that execute on the host, so never load it from an
 * untrusted directory.
 */
export function loadProvidersConfig(filePath = DEFAULT_PROVIDERS_FILE): ProvidersConfig {
  const absolute = resolve(filePath);

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Providers config not found: ${absolute}`);
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Providers config is not valid JSON: ${absolute}\n${String(error)}`);
  }

  return normalizeConfig(parsed, absolute);
}

export function normalizeConfig(parsed: unknown, source = "<inline>"): ProvidersConfig {
  if (!isRecord(parsed)) throw new Error(`Providers config must be a JSON object (${source})`);
  const rawProviders = parsed.providers;
  if (!isRecord(rawProviders)) {
    throw new Error(`Providers config needs a "providers" object (${source})`);
  }

  const providers: ProviderDefinition[] = [];
  for (const [id, value] of Object.entries(rawProviders)) {
    providers.push(normalizeProvider(id, value, source));
  }
  if (providers.length === 0) throw new Error(`Providers config lists no providers (${source})`);

  const defaultModel = typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined;
  return { defaultModel, providers };
}

function normalizeProvider(id: string, value: unknown, source: string): ProviderDefinition {
  if (!isRecord(value)) throw new Error(`Provider "${id}" must be an object (${source})`);

  const baseUrl = value.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error(`Provider "${id}" needs a non-empty baseUrl (${source})`);
  }

  const rawModels = value.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new Error(`Provider "${id}" needs a non-empty models array (${source})`);
  }

  return {
    id,
    label: typeof value.label === "string" ? value.label : undefined,
    api: typeof value.api === "string" ? value.api : undefined,
    baseUrl,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
    headers: isStringRecord(value.headers) ? value.headers : undefined,
    models: rawModels.map((model, index) => normalizeModel(id, model, index, source)),
  };
}

function normalizeModel(
  providerId: string,
  value: unknown,
  index: number,
  source: string,
): ModelDefinition {
  if (!isRecord(value)) {
    throw new Error(`Model #${index} of provider "${providerId}" must be an object (${source})`);
  }
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Model #${index} of provider "${providerId}" needs a non-empty id (${source})`);
  }

  return {
    id,
    label: typeof value.label === "string" ? value.label : undefined,
    contextWindow: positiveInteger(value.contextWindow),
    maxOutputTokens: positiveInteger(value.maxOutputTokens),
    supportsTools: typeof value.supportsTools === "boolean" ? value.supportsTools : undefined,
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
