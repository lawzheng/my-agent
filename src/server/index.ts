import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, ModelInfo, ModelsResponse, SessionResponse } from "../shared/protocol";
import { appendCoalescedEvent } from "../shared/events";
import { runAgentLoop } from "./agent/loop";
import { createUserMessage } from "./agent/message";
import { JsonlSessionStore } from "./agent/sessionStore";
import { createToolRegistry } from "./agent/tools";
import { createMockAdapter } from "./providers/api/mock";
import { createOpenAICompletionsAdapter } from "./providers/api/openaiCompletions";
import { DEFAULT_PROVIDERS_FILE, loadProvidersConfig } from "./providers/config";
import { createModelRuntime, type ModelRuntime, ProviderRegistry } from "./providers/registry";
import type { ApiAdapter, ProviderDefinition } from "./providers/types";
const systemPrompt = [
  "你是 Teaching Agent，一个用于解释 Pi Agent 核心机制的教学版 Agent。",
  "你可以使用工具观察安全工作区，也可以直接回答概念问题。",
  "规则：",
  "1. 需要文件内容时，必须调用工具，不要凭记忆编造。",
  "2. 工具返回结果后，必须基于工具结果继续回答用户。",
  "3. 只操作工作区内的文件，路径必须是相对路径。",
].join("\n");

/** Tokens held back from the context window so the model has room to answer. */
export const RESERVE_TOKENS = 16_384;

export type TeachingAgentApiOptions = {
  store: JsonlSessionStore;
  runtime: ModelRuntime;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  systemPrompt?: string;
};

export function createApp(options: TeachingAgentApiOptions) {
  const app = express();
  const eventLog: AgentEvent[] = [];
  let operationQueue: Promise<void> = Promise.resolve();

  app.use(express.json({ limit: "1mb" }));

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const appendEvent = (event: AgentEvent): void => {
    appendCoalescedEvent(eventLog, event);
    if (eventLog.length > 1000) eventLog.splice(0, eventLog.length - 1000);
  };

  const createResponse = (): SessionResponse => ({
    sessionId: options.store.getSessionId(),
    messages: options.store.buildContext(),
    events: [...eventLog],
    tools: options.toolRegistry.definitions(),
    entries: options.store.getEntries(),
  });

  const createModelsResponse = (): ModelsResponse => ({
    current: options.runtime.currentRef(),
    models: options.runtime.list().map<ModelInfo>((model) => ({
      ref: model.ref,
      providerId: model.providerId,
      modelId: model.modelId,
      label: model.label,
      contextWindow: model.contextWindow,
      supportsTools: model.supportsTools,
    })),
  });

  /**
   * Shared prompt pipeline: persist the user message, compact if needed, run the
   * loop, persist the new messages, and return the refreshed session. Both the
   * buffered and streaming endpoints use it so their behavior stays identical.
   */
  const runPrompt = async (
    input: string,
    onEvent: (event: AgentEvent) => void,
  ): Promise<SessionResponse> => {
    const model = options.runtime.current();
    const userMessage = createUserMessage(input);
    await options.store.appendMessage(userMessage);

    const compaction = await options.store.compactIfNeeded(
      resolveCompactionThreshold(model.contextWindow),
      8,
    );
    if (compaction) {
      onEvent({
        type: "compaction",
        summary: compaction.summary,
        tokensBefore: compaction.tokensBefore,
        firstKeptEntryId: compaction.firstKeptEntryId,
      });
    }

    const result = await runAgentLoop({
      systemPrompt: options.systemPrompt ?? systemPrompt,
      messages: options.store.buildContext(),
      tools: options.toolRegistry.definitions(),
      model: options.runtime.createModel(),
      toolRegistry: options.toolRegistry,
      onEvent,
    });

    for (const message of result.newMessages) {
      await options.store.appendMessage(message);
    }
    return createResponse();
  };

  app.get("/api/session", async (_request, response) => {
    await enqueue(async () => {
      await options.store.initialize();
      response.json(createResponse());
    });
  });

  app.get("/api/models", async (_request, response) => {
    await enqueue(async () => {
      response.json(createModelsResponse());
    });
  });

  app.post("/api/model", async (request, response) => {
    const ref = typeof request.body?.ref === "string" ? request.body.ref.trim() : "";
    if (!ref) {
      response.status(400).json({ error: "ref is required" });
      return;
    }

    await enqueue(async () => {
      try {
        options.runtime.select(ref);
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Invalid model" });
        return;
      }
      response.json(createModelsResponse());
    });
  });

  app.post("/api/prompt", async (request, response) => {
    const input = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!input) {
      response.status(400).json({ error: "text is required" });
      return;
    }

    await enqueue(async () => {
      const result = await runPrompt(input, appendEvent);
      response.json(result);
    });
  });

  /**
   * Streaming variant of /api/prompt. Sends server-sent events as the agent loop
   * progresses, then a final `done` event carrying the complete session.
   */
  app.post("/api/prompt/stream", async (request, response) => {
    const input = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!input) {
      response.status(400).json({ error: "text is required" });
      return;
    }

    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    await enqueue(async () => {
      try {
        const result = await runPrompt(input, (event) => {
          appendEvent(event);
          send("agent", event);
        });
        send("done", result);
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : "Internal server error" });
      } finally {
        response.end();
      }
    });
  });

  app.post("/api/reset", async (_request, response) => {
    await enqueue(async () => {
      await options.store.reset();
      eventLog.length = 0;
      response.json(createResponse());
    });
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status = typeof error === "object" && error !== null && "status" in error &&
      typeof error.status === "number" ? error.status : 500;
    response.status(status).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  });

  return app;
}

/**
 * Compaction triggers near the model's context limit, like Pi. PI_COMPACT_TOKENS
 * overrides it so the teaching demo can force compaction with small prompts.
 */
export function resolveCompactionThreshold(contextWindow: number): number {
  const override = Number(process.env.PI_COMPACT_TOKENS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return Math.max(1, contextWindow - RESERVE_TOKENS);
}

export type ProviderSetup = {
  registry: ProviderRegistry;
  adapters: ApiAdapter[];
  providers: ProviderDefinition[];
};

export function createProviderRegistry(
  configFile = process.env.PI_PROVIDERS_FILE ?? DEFAULT_PROVIDERS_FILE,
): ProviderSetup {
  const config = loadProvidersConfig(configFile);
  const adapters: ApiAdapter[] = [createOpenAICompletionsAdapter(), createMockAdapter()];

  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.registerAdapter(adapter);
  for (const provider of config.providers) registry.registerProvider(provider);

  return { registry, adapters, providers: config.providers };
}

export async function startServer(port = Number(process.env.PORT ?? 4317)): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("PORT must be an integer between 0 and 65535");
  }

  loadDotEnv();
  const cwd = process.cwd();
  const store = new JsonlSessionStore(resolve(cwd, ".teaching-agent/session.jsonl"), cwd);
  await store.initialize();
  const toolRegistry = createToolRegistry(resolve(cwd, "workspace"));

  const configFile = process.env.PI_PROVIDERS_FILE ?? DEFAULT_PROVIDERS_FILE;
  const config = loadProvidersConfig(configFile);
  const { registry } = createProviderRegistry(configFile);
  const runtime = createModelRuntime(registry, process.env.PI_MODEL ?? config.defaultModel);
  const app = createApp({ store, runtime, toolRegistry });

  await new Promise<void>((resolveListen, rejectListen) => {
    const server = app.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const current = runtime.current();
      console.log(`Teaching Agent API listening on http://localhost:${actualPort}`);
      console.log(`Model: ${current.ref} (${current.label}) via ${current.api}`);
      console.log(`Available models: ${runtime.list().map((model) => model.ref).join(", ")}`);
      resolveListen();
    });
    server.once("error", rejectListen);
  });
}

function loadDotEnv(): void {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
  } catch {
    // .env is optional.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
