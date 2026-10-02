import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, SessionResponse } from "../shared/protocol";
import { runAgentLoop } from "./agent/loop";
import { createUserMessage } from "./agent/message";
import { MockModel } from "./agent/mockModel";
import type { TeachingModel } from "./agent/model";
import { JsonlSessionStore } from "./agent/sessionStore";
import { createToolRegistry } from "./agent/tools";

const systemPrompt = [
  "你是 Teaching Agent，一个用于解释 Pi Agent 核心机制的教学版 Agent。",
  "你可以使用工具观察安全工作区，也可以直接回答概念问题。",
  "当工具返回结果后，必须基于工具结果继续回答用户。",
].join("\n");

export type TeachingAgentApiOptions = {
  store: JsonlSessionStore;
  model: TeachingModel;
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
    eventLog.push(event);
    if (eventLog.length > 1000) eventLog.splice(0, eventLog.length - 1000);
  };

  const createResponse = (): SessionResponse => ({
    sessionId: options.store.getSessionId(),
    messages: options.store.buildContext(),
    events: [...eventLog],
    tools: options.toolRegistry.definitions(),
    entries: options.store.getEntries(),
  });

  app.get("/api/session", async (_request, response) => {
    await enqueue(async () => {
      await options.store.initialize();
      response.json(createResponse());
    });
  });

  app.post("/api/prompt", async (request, response) => {
    const input = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!input) {
      response.status(400).json({ error: "text is required" });
      return;
    }

    await enqueue(async () => {
      const userMessage = createUserMessage(input);
      await options.store.appendMessage(userMessage);

      const compaction = await options.store.compactIfNeeded(1200, 8);
      if (compaction) {
        appendEvent({
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
        model: options.model,
        toolRegistry: options.toolRegistry,
        onEvent: appendEvent,
      });

      for (const message of result.newMessages) {
        await options.store.appendMessage(message);
      }
      response.json(createResponse());
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

export async function startServer(port = Number(process.env.PORT ?? 4317)): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("PORT must be an integer between 0 and 65535");
  }

  const cwd = process.cwd();
  const store = new JsonlSessionStore(resolve(cwd, ".teaching-agent/session.jsonl"), cwd);
  await store.initialize();
  const toolRegistry = createToolRegistry(resolve(cwd, "workspace"));
  const app = createApp({ store, model: new MockModel(), toolRegistry });

  await new Promise<void>((resolveListen, rejectListen) => {
    const server = app.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`Teaching Agent API listening on http://localhost:${actualPort}`);
      resolveListen();
    });
    server.once("error", rejectListen);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}