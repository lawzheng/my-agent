import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentMessage, SessionEntry } from "../../shared/protocol";
import { createAssistantMessage, messageText, text } from "./message";

export class JsonlSessionStore {
  private readonly filePath: string;
  private readonly cwd: string;
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;
  private nextEntryNumber = 1;
  private initialization?: Promise<void>;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, cwd: string) {
    this.filePath = resolve(filePath);
    this.cwd = resolve(cwd);
  }

  async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.loadOrCreate();
    await this.initialization;
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    await this.initialize();
    return this.enqueue(async () => {
      const id = this.nextId();
      const entry: SessionEntry = {
        type: "message",
        id,
        parentId: this.leafId,
        timestamp: new Date().toISOString(),
        message,
      };
      await this.appendEntry(entry);
      return id;
    });
  }

  buildContext(): AgentMessage[] {
    const path = this.pathToLeaf();
    const context: AgentMessage[] = [];

    for (let index = 0; index < path.length; index++) {
      const entry = path[index];
      if (entry.type === "message") {
        context.push(entry.message);
      } else if (entry.type === "compaction") {
        const firstKeptIndex = path.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
        const keptMessages = firstKeptIndex >= 0
          ? path.slice(firstKeptIndex, index).filter(
              (candidate): candidate is Extract<SessionEntry, { type: "message" }> => candidate.type === "message",
            )
          : [];
        context.splice(
          0,
          context.length,
          createAssistantMessage([text(entry.summary)]),
          ...keptMessages.map((keptEntry) => keptEntry.message),
        );
      }
    }

    return context;
  }

  async reset(): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      await rm(this.filePath, { force: true });
      this.entries.length = 0;
      this.byId.clear();
      this.leafId = null;
      this.nextEntryNumber = 1;
      await this.writeHeader();
    });
  }

  async compactIfNeeded(
    maxApproxTokens: number,
    keepRecentMessages: number,
  ): Promise<CompactionEntry | undefined> {
    await this.initialize();
    if (!Number.isFinite(maxApproxTokens) || maxApproxTokens < 1) {
      throw new RangeError("maxApproxTokens must be a positive number");
    }
    if (!Number.isInteger(keepRecentMessages) || keepRecentMessages < 1) {
      throw new RangeError("keepRecentMessages must be a positive integer");
    }

    return this.enqueue(async () => {
      const context = this.buildContext();
      const tokensBefore = estimateTokens(context);
      if (tokensBefore <= maxApproxTokens) return undefined;

      const messageEntries = this.pathToLeaf().filter(
        (entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message",
      );
      if (messageEntries.length <= keepRecentMessages) return undefined;

      const kept = messageEntries.slice(-keepRecentMessages);
      const summarized = messageEntries.slice(0, -keepRecentMessages);
      const summary = summarizeMessages(summarized.map((entry) => entry.message));
      const entry: CompactionEntry = {
        type: "compaction",
        id: this.nextId(),
        parentId: this.leafId,
        timestamp: new Date().toISOString(),
        summary,
        firstKeptEntryId: kept[0].id,
        tokensBefore,
      };
      await this.appendEntry(entry);
      return entry;
    });
  }

  private async loadOrCreate(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeHeader();
      return;
    }

    const lines = contents.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
      await this.writeHeader();
      return;
    }

    this.entries.length = 0;
    this.byId.clear();
    this.leafId = null;
    this.nextEntryNumber = 1;

    for (const [index, line] of lines.entries()) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSONL entry at line ${index + 1}`);
      }
      if (!isSessionEntry(entry)) throw new Error(`Invalid session entry at line ${index + 1}`);

      if (index === 0) {
        if (entry.type !== "session" || entry.version !== 1) {
          throw new Error("The first JSONL entry must be a version 1 session header");
        }
        this.entries.push(entry);
        this.byId.set(entry.id, entry);
        continue;
      }

      if (entry.type === "session") throw new Error("A session header can only appear on the first JSONL line");
      if (this.byId.has(entry.id)) throw new Error(`Duplicate session entry id: ${entry.id}`);
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw new Error(`Unknown parent id '${entry.parentId}' for session entry '${entry.id}'`);
      }
      if (entry.type === "compaction" && !this.byId.has(entry.firstKeptEntryId)) {
        throw new Error(`Unknown first kept entry id '${entry.firstKeptEntryId}'`);
      }

      this.entries.push(entry);
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      const numericId = /^entry_(\d+)$/.exec(entry.id);
      if (numericId) this.nextEntryNumber = Math.max(this.nextEntryNumber, Number(numericId[1]) + 1);
    }
  }

  private async writeHeader(): Promise<void> {
    const header: SessionEntry = {
      type: "session",
      version: 1,
      id: `session_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
    };
    await writeFile(this.filePath, `${JSON.stringify(header)}\n`, "utf8");
    this.entries.push(header);
    this.byId.set(header.id, header);
  }

  private pathToLeaf(): SessionEntry[] {
    const path: SessionEntry[] = [];
    let current = this.leafId ? this.byId.get(this.leafId) : undefined;
    const visited = new Set<string>();

    while (current && current.type !== "session") {
      if (visited.has(current.id)) throw new Error(`Cycle in session history at '${current.id}'`);
      visited.add(current.id);
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }

    return path;
  }

  private nextId(): string {
    return `entry_${this.nextEntryNumber++}`;
  }

  private async appendEntry(entry: Exclude<SessionEntry, { type: "session" }>): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(this.filePath, line, "utf8");
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appendQueue.then(operation);
    this.appendQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") return false;

  if (entry.type === "session") {
    return entry.version === 1 && typeof entry.cwd === "string";
  }
  if (entry.type === "message") {
    return (entry.parentId === null || typeof entry.parentId === "string") &&
      typeof entry.message === "object" && entry.message !== null;
  }
  if (entry.type === "compaction") {
    return (entry.parentId === null || typeof entry.parentId === "string") &&
      typeof entry.summary === "string" &&
      typeof entry.firstKeptEntryId === "string" &&
      typeof entry.tokensBefore === "number";
  }
  return false;
}

function estimateTokens(messages: AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function summarizeMessages(messages: AgentMessage[]): string {
  const lines = messages.map((message) => {
    const content = messageText(message) ||
      (message.role === "assistant"
        ? message.content.filter((block) => block.type === "toolCall")
            .map((block) => `tool call ${block.name}(${JSON.stringify(block.arguments)})`).join(", ")
        : "");
    return `${message.role}: ${content || "(no text content)"}`;
  });
  const joined = lines.join("\n");
  return joined.length > 4000 ? `${joined.slice(0, 3997)}...` : joined;
}

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;