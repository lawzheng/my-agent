import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { JsonlSessionStore } from "./agent/sessionStore";
import { createToolRegistry } from "./agent/tools";
import { createApp, resolveCompactionThreshold } from "./index";
import { createModelRuntime } from "./providers/registry";
import { ProviderRegistry } from "./providers/registry";
import { createMockAdapter } from "./providers/api/mock";

const providers = {
  id: "local",
  baseUrl: "http://127.0.0.1:9/v1",
  api: "mock",
  models: [
    { id: "alpha", label: "Alpha", contextWindow: 32_000 },
    { id: "beta", label: "Beta", contextWindow: 64_000 },
  ],
};

function createRegistry() {
  const registry = new ProviderRegistry();
  registry.registerAdapter(createMockAdapter());
  registry.registerProvider(providers);
  return registry;
}

async function withServer(
  run: (baseUrl: string, runtime: ReturnType<typeof createModelRuntime>) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "teaching-agent-api-"));
  const store = new JsonlSessionStore(join(directory, "session.jsonl"), process.cwd());
  const toolRegistry = createToolRegistry(resolvePath(process.cwd(), "workspace"));
  const runtime = createModelRuntime(createRegistry(), "local/alpha");
  const app = createApp({ store, runtime, toolRegistry });
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`, runtime);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
}

test("GET /api/models lists models and the current selection", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/models`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.current, "local/alpha");
    assert.deepEqual(
      payload.models.map((model: { ref: string }) => model.ref),
      ["local/alpha", "local/beta"],
    );
    assert.equal(payload.models[0].label, "Alpha");
  });
});

test("POST /api/model switches the active model and rejects unknown refs", async () => {
  await withServer(async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "local/beta" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).current, "local/beta");

    const missing = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "local/nope" }),
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /Unknown model/);

    const empty = await fetch(`${baseUrl}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  });
});

test("POST /api/prompt runs the loop against the selected provider model", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "列出工作区文件" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.messages.map((message: { role: string }) => message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    assert.ok(payload.events.some((event: { type: string }) => event.type === "tool_execution_start"));
  });
});

test("resolveCompactionThreshold leaves a reserve and honors the override", () => {
  assert.equal(resolveCompactionThreshold(100_000), 100_000 - 16_384);
  assert.equal(resolveCompactionThreshold(1_000), 1);
  process.env.PI_COMPACT_TOKENS = "1500";
  try {
    assert.equal(resolveCompactionThreshold(1_000_000), 1500);
  } finally {
    delete process.env.PI_COMPACT_TOKENS;
  }
});
