import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { runAgentLoop } from "./agent/loop";
import { createAssistantMessage, createUserMessage, messageText, text } from "./agent/message";
import { MockModel } from "./agent/mockModel";
import { JsonlSessionStore } from "./agent/sessionStore";
import { createToolRegistry } from "./agent/tools";
import { createApp } from "./index";

const registry = createToolRegistry(resolvePath(process.cwd(), "workspace"));
const definitions = registry.definitions();
assert.deepEqual(definitions.map((tool) => tool.name), ["list_files", "read_file", "write_note"]);
assert.ok(definitions.every((tool) => !("execute" in tool)));

const writeRequest = await new MockModel().complete({
  systemPrompt: "",
  messages: [createUserMessage("写笔记 weekly.md")],
  tools: definitions,
});
assert.equal(writeRequest.content[0].type, "toolCall");
if (writeRequest.content[0].type === "toolCall") {
  assert.equal(writeRequest.content[0].name, "write_note");
  assert.equal(writeRequest.content[0].arguments.fileName, "weekly.md");
}

const files = await registry.execute("list_files", { path: "." });
assert.match(files.content[0].text, /README\.md/);
assert.match(files.content[0].text, /agent-notes\.md/);

const note = await registry.execute("read_file", { path: "agent-notes.md" });
assert.match(note.content[0].text, /Agent Loop/);
await assert.rejects(registry.execute("read_file", { path: "..\\package.json" }), /escapes workspace/);
await assert.rejects(
  registry.execute("write_note", { fileName: "draft.txt", content: "invalid" }),
  /ending in \.md/,
);
await assert.rejects(
  registry.execute("write_note", { fileName: "C:escape.md", content: "invalid" }),
  /ending in \.md/,
);

const smokeNoteName = `step-3-smoke-${process.pid}.md`;
const smokeNotePath = resolvePath(process.cwd(), "workspace", "notes", smokeNoteName);
try {
  await registry.execute("write_note", { fileName: smokeNoteName, content: "Tool write smoke check." });
  const writtenNote = await registry.execute("read_file", { path: `notes/${smokeNoteName}` });
  assert.equal(writtenNote.content[0].text, "Tool write smoke check.");
} finally {
  await rm(smokeNotePath, { force: true });
}

const result = await runAgentLoop({
  systemPrompt: "你是教学 Agent。",
  messages: [createUserMessage("读取 agent-notes.md")],
  tools: definitions,
  model: new MockModel(),
  toolRegistry: registry,
});

assert.deepEqual(result.newMessages.map((message) => message.role), ["assistant", "toolResult", "assistant"]);
assert.match(messageText(result.newMessages[2]), /Agent Loop/);
assert.ok(result.events.some((event) => event.type === "tool_execution_start"));
assert.ok(result.events.some((event) => event.type === "tool_execution_end"));

const sessionDirectory = await mkdtemp(join(tmpdir(), "teaching-agent-session-"));
const sessionFile = join(sessionDirectory, "session.jsonl");
try {
  const store = new JsonlSessionStore(sessionFile, process.cwd());
  const firstId = await store.appendMessage(createUserMessage("hello"));
  const secondId = await store.appendMessage(createAssistantMessage([text("hello back")]));
  await store.appendMessage(createUserMessage("continue"));
  assert.equal(firstId, "entry_1");
  assert.equal(secondId, "entry_2");
  assert.equal(store.buildContext().length, 3);

  const reopened = new JsonlSessionStore(sessionFile, process.cwd());
  await reopened.initialize();
  assert.equal(reopened.buildContext().length, 3);
  await reopened.appendMessage(createUserMessage("after restart"));

  const jsonlEntries = (await readFile(sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(jsonlEntries[0].type, "session");
  assert.equal(jsonlEntries[1].parentId, null);
  assert.equal(jsonlEntries[2].parentId, firstId);
  assert.equal(jsonlEntries[4].parentId, "entry_3");

  const compaction = await reopened.compactIfNeeded(1, 1);
  assert.ok(compaction);
  assert.equal(reopened.buildContext().length, 2);
  assert.match(messageText(reopened.buildContext()[0]), /user: hello/);

  await reopened.reset();
  assert.equal(reopened.buildContext().length, 0);
  const resetEntries = (await readFile(sessionFile, "utf8")).trim().split("\n");
  assert.equal(resetEntries.length, 1);
  assert.equal(JSON.parse(resetEntries[0]).type, "session");
} finally {
  await rm(sessionDirectory, { recursive: true, force: true });
}

const apiDirectory = await mkdtemp(join(tmpdir(), "teaching-agent-api-"));
const apiStore = new JsonlSessionStore(join(apiDirectory, "session.jsonl"), process.cwd());
const api = createApp({ store: apiStore, model: new MockModel(), toolRegistry: registry });
const server = api.listen(0, "127.0.0.1");
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const emptySessionResponse = await fetch(`${baseUrl}/api/session`);
  assert.equal(emptySessionResponse.status, 200);
  const emptySession = await emptySessionResponse.json();
  assert.equal(emptySession.messages.length, 0);
  assert.equal(emptySession.tools.length, 3);

  const emptyPromptResponse = await fetch(`${baseUrl}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(emptyPromptResponse.status, 400);

  const promptResponse = await fetch(`${baseUrl}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "列出工作区文件" }),
  });
  assert.equal(promptResponse.status, 200);
  const promptedSession = await promptResponse.json();
  assert.deepEqual(
    promptedSession.messages.map((message: { role: string }) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.ok(promptedSession.events.some((event: { type: string }) => event.type === "tool_execution_start"));
  assert.ok(promptedSession.tools.every((tool: Record<string, unknown>) => !("execute" in tool)));

  const resetResponse = await fetch(`${baseUrl}/api/reset`, { method: "POST" });
  assert.equal(resetResponse.status, 200);
  const resetSession = await resetResponse.json();
  assert.equal(resetSession.messages.length, 0);
  assert.equal(resetSession.events.length, 0);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await rm(apiDirectory, { recursive: true, force: true });
}

console.log("Step 3, Step 4, and Step 5 smoke checks passed.");