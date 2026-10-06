import { ArrowUp, FileText, GitBranch, Hammer, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AgentEvent,
  AgentMessage,
  ModelsResponse,
  SessionEntry,
  SessionResponse,
  TextContent,
  ToolCallContent,
  ToolDefinition,
} from "../shared/protocol";

const EMPTY_SESSION: SessionResponse = {
  sessionId: "",
  messages: [],
  events: [],
  tools: [],
  entries: [],
};

const EMPTY_MODELS: ModelsResponse = { current: "", models: [] };

export function App() {
  const [session, setSession] = useState<SessionResponse>(EMPTY_SESSION);
  const [models, setModels] = useState<ModelsResponse>(EMPTY_MODELS);
  const [input, setInput] = useState("列出工作区文件");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void refresh();
    void refreshModels();
  }, []);

  async function refresh() {
    setError("");
    const response = await fetch("/api/session");
    setSession(await response.json());
  }

  async function refreshModels() {
    const response = await fetch("/api/models");
    if (response.ok) setModels(await response.json());
  }

  async function selectModel(ref: string) {
    setError("");
    const response = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "切换模型失败");
      return;
    }
    setModels(await response.json());
  }

  async function reset() {
    setError("");
    setIsLoading(true);
    try {
      const response = await fetch("/api/reset", { method: "POST" });
      setSession(await response.json());
    } finally {
      setIsLoading(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Request failed");
      }
      setSession(await response.json());
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  const eventLines = useMemo(() => summarizeEvents(session.events), [session.events]);
  const sessionTree = useMemo(() => buildSessionTree(session.entries), [session.entries]);
  const activeLeafId = session.entries.length > 0 ? session.entries[session.entries.length - 1].id : null;

  return (
    <main className="app-shell">
      <section className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyeline">Pi-style teaching runtime</p>
            <h1>Teaching Agent</h1>
          </div>
          <div className="toolbar">
            <label className="model-picker">
              <span>Model</span>
              <select
                value={models.current}
                onChange={(event) => void selectModel(event.target.value)}
                disabled={isLoading || models.models.length === 0}
              >
                {models.models.map((model) => (
                  <option key={model.ref} value={model.ref}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="icon-button" aria-label="刷新会话" onClick={refresh} disabled={isLoading}>
              <RefreshCw size={18} />
            </button>
            <button type="button" className="icon-button" aria-label="重置会话" onClick={reset} disabled={isLoading}>
              <RotateCcw size={18} />
            </button>
          </div>
        </header>

        <div className="chat-list">
          {session.messages.length === 0 ? (
            <div className="empty-state">
              <Sparkles size={28} />
              <p>输入一个目标，观察模型如何决定直接回答或调用工具。</p>
            </div>
          ) : (
            session.messages.map((message, index) => (
              <MessageCard key={`${message.timestamp}-${index}`} message={message} />
            ))
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="试试：读取 agent-notes.md"
            disabled={isLoading}
          />
          <button type="submit" className="send-button" aria-label="发送" disabled={isLoading || !input.trim()}>
            <ArrowUp size={18} />
          </button>
        </form>
        {error ? <p className="error-line">{error}</p> : null}
      </section>

      <aside className="side-panel">
        <section className="panel-section">
          <h2>Session Tree</h2>
          <div className="tree-list">
            {sessionTree.length === 0 ? (
              <div className="tree-empty">No entries yet</div>
            ) : (
              sessionTree.map((node) => (
                <SessionTreeNodeView key={node.id} node={node} activeLeafId={activeLeafId} />
              ))
            )}
          </div>
        </section>

        <section className="panel-section">
          <h2>Tools</h2>
          <div className="tool-list">
            {session.tools.map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </section>

        <section className="panel-section">
          <h2>Event Timeline</h2>
          <div className="event-list">
            {eventLines.map((line, index) => (
              <div key={`${line}-${index}`} className="event-row">
                {line}
              </div>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}

function MessageCard({ message }: { message: AgentMessage }) {
  return (
    <article className={`message-card message-${message.role}`}>
      <div className="message-role">{roleLabel(message)}</div>
      <div className="message-body">
        {message.role === "assistant"
          ? message.content.map((block, index) =>
              block.type === "toolCall" ? (
                <ToolCallBlock key={index} block={block} />
              ) : (
                <p key={index}>{block.text}</p>
              ),
            )
          : message.content.map((block, index) => <p key={index}>{block.text}</p>)}
      </div>
    </article>
  );
}

function ToolCallBlock({ block }: { block: ToolCallContent }) {
  return (
    <div className="tool-call-block">
      <Hammer size={16} />
      <span>{block.name}</span>
      <code>{JSON.stringify(block.arguments)}</code>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDefinition }) {
  return (
    <div className="tool-card">
      <FileText size={16} />
      <div>
        <strong>{tool.name}</strong>
        <p>{tool.description}</p>
      </div>
    </div>
  );
}

type SessionTreeNode = {
  id: string;
  label: string;
  children: SessionTreeNode[];
};

function SessionTreeNodeView({
  node,
  activeLeafId,
}: {
  node: SessionTreeNode;
  activeLeafId: string | null;
}) {
  const isActive = node.id === activeLeafId;
  return (
    <div className="tree-node">
      <div className={`tree-node-button${isActive ? " tree-node-active" : ""}`}>
        <GitBranch size={14} />
        <span>{node.label}</span>
      </div>
      {node.children.length > 0 ? (
        <div className="tree-children">
          {node.children.map((child) => (
            <SessionTreeNodeView key={child.id} node={child} activeLeafId={activeLeafId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function roleLabel(message: AgentMessage): string {
  if (message.role === "toolResult") return `tool:${message.toolName}`;
  return message.role;
}

function messageText(message: AgentMessage): string {
  const parts: string[] = [];
  for (const block of message.content as Array<TextContent | ToolCallContent>) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

function summarizeEvents(events: AgentEvent[]): string[] {
  return events.slice(-80).map((event) => {
    switch (event.type) {
      case "turn_start":
        return `turn ${event.turn} start`;
      case "turn_end":
        return `turn ${event.turn} end`;
      case "message_start":
      case "message_end":
        return `${event.type}: ${event.message.role}`;
      case "message_update":
        return `message_update: ${event.delta.slice(0, 48)}`;
      case "tool_execution_start":
        return `tool_start: ${event.toolName}`;
      case "tool_execution_end":
        return `tool_end: ${event.toolName}${event.isError ? " error" : ""}`;
      case "agent_end":
        return `agent_end: ${event.messages.length} new messages`;
      case "compaction":
        return `compaction: ${event.tokensBefore} approx tokens`;
      default:
        return event.type;
    }
  });
}

function buildSessionTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodes = new Map<string, SessionTreeNode>();
  const parentById = new Map<string, string | null>();

  for (const entry of entries) {
    if (entry.type === "session") continue;
    nodes.set(entry.id, { id: entry.id, label: entryLabel(entry), children: [] });
    parentById.set(entry.id, entry.parentId);
  }

  const roots: SessionTreeNode[] = [];
  for (const [id, node] of nodes) {
    const parentId = parentById.get(id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function entryLabel(entry: Exclude<SessionEntry, { type: "session" }>): string {
  if (entry.type === "compaction") {
    return `${entry.id} compaction`;
  }

  const message = entry.message;
  if (message.role === "assistant") {
    const toolNames = message.content
      .filter((block): block is ToolCallContent => block.type === "toolCall")
      .map((block) => block.name)
      .join(", ");
    return `${entry.id} assistant${toolNames ? ` -> ${toolNames}` : ""}`;
  }
  if (message.role === "toolResult") {
    return `${entry.id} tool:${message.toolName}`;
  }

  const content = messageText(message).replace(/\s+/g, " ").slice(0, 34);
  return `${entry.id} user${content ? `: ${content}` : ""}`;
}
