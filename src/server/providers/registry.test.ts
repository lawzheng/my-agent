import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiAdapter, ProviderDefinition } from "./types";
import { createModelRuntime, ProviderRegistry } from "./registry";
import { normalizeConfig } from "./config";

const echoAdapter: ApiAdapter = {
  id: "test-api",
  async complete(request) {
    return {
      role: "assistant",
      content: [{ type: "text", text: request.model.ref }],
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 },
      timestamp: 0,
    };
  },
};

const provider: ProviderDefinition = {
  id: "local",
  baseUrl: "http://127.0.0.1:8080/v1",
  api: "test-api",
  models: [
    { id: "small", label: "Small", contextWindow: 32_000 },
    { id: "large", maxOutputTokens: 8_000 },
  ],
};

function createRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerAdapter(echoAdapter);
  registry.registerProvider(provider);
  return registry;
}

test("registerProvider rejects an unknown api", () => {
  const registry = new ProviderRegistry();
  registry.registerAdapter(echoAdapter);
  assert.throws(
    () => registry.registerProvider({ ...provider, api: "nope" }),
    /Unknown api "nope"/,
  );
});

test("registerProvider rejects duplicate ids and adapters", () => {
  const registry = createRegistry();
  assert.throws(() => registry.registerProvider(provider), /already registered/);
  assert.throws(() => registry.registerAdapter(echoAdapter), /already registered/);
});

test("resolve merges provider, model, and defaults", () => {
  const resolved = createRegistry().resolve("local/small");
  assert.equal(resolved.ref, "local/small");
  assert.equal(resolved.label, "Small");
  assert.equal(resolved.contextWindow, 32_000);
  assert.equal(resolved.maxOutputTokens, 4_096); // default
  assert.equal(resolved.supportsTools, true); // default
  assert.equal(resolved.maxTokensField, "max_tokens");
});

test("resolve interpolates an api key from the environment", () => {
  process.env.PI_REGISTRY_KEY = "sk-from-env";
  try {
    const registry = new ProviderRegistry();
    registry.registerAdapter(echoAdapter);
    registry.registerProvider({ ...provider, apiKey: "$PI_REGISTRY_KEY" });
    assert.equal(registry.resolve("local/small").apiKey, "sk-from-env");
  } finally {
    delete process.env.PI_REGISTRY_KEY;
  }
});

test("resolve rejects malformed and unknown refs", () => {
  const registry = createRegistry();
  assert.throws(() => registry.resolve("small"), /provider\/model/);
  assert.throws(() => registry.resolve("nope/small"), /Unknown provider: nope/);
  assert.throws(() => registry.resolve("local/nope"), /Unknown model "nope"/);
  assert.equal(registry.has("local/small"), true);
  assert.equal(registry.has("local/nope"), false);
});

test("createModel binds the adapter to the resolved model", async () => {
  const message = await createRegistry().createModel("local/large").complete({
    systemPrompt: "",
    messages: [],
    tools: [],
  });
  assert.equal(message.content[0].type === "text" && message.content[0].text, "local/large");
});

test("runtime lists models and switches the current selection", () => {
  const runtime = createModelRuntime(createRegistry(), "local/large");
  assert.equal(runtime.currentRef(), "local/large");
  assert.deepEqual(runtime.list().map((model) => model.ref), ["local/small", "local/large"]);

  runtime.select("local/small");
  assert.equal(runtime.current().modelId, "small");
  assert.throws(() => runtime.select("local/nope"), /Unknown model/);
});

test("runtime falls back to the first model for an unknown initial ref", () => {
  const runtime = createModelRuntime(createRegistry(), "missing/model");
  assert.equal(runtime.currentRef(), "local/small");
});

test("normalizeConfig validates the config shape", () => {
  assert.throws(() => normalizeConfig(null), /must be a JSON object/);
  assert.throws(() => normalizeConfig({}), /needs a "providers" object/);
  assert.throws(() => normalizeConfig({ providers: {} }), /lists no providers/);
  assert.throws(
    () => normalizeConfig({ providers: { bad: { models: [{ id: "x" }] } } }),
    /needs a non-empty baseUrl/,
  );
  assert.throws(
    () => normalizeConfig({ providers: { bad: { baseUrl: "http://x", models: [] } } }),
    /needs a non-empty models array/,
  );
  assert.throws(
    () => normalizeConfig({ providers: { bad: { baseUrl: "http://x", models: [{}] } } }),
    /needs a non-empty id/,
  );

  const config = normalizeConfig({
    defaultModel: "local/small",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        headers: { "x-trace": "1" },
        models: [{ id: "small", label: "Small", contextWindow: 32_000 }],
      },
    },
  });
  assert.equal(config.defaultModel, "local/small");
  assert.equal(config.providers[0].id, "local");
  assert.deepEqual(config.providers[0].models[0], {
    id: "small",
    label: "Small",
    contextWindow: 32_000,
    maxOutputTokens: undefined,
    supportsTools: undefined,
  });
});
