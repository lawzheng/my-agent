import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { runAgentLoop } from "./agent/loop";
import { createUserMessage, messageText } from "./agent/message";
import { MockModel } from "./agent/mockModel";
import { createToolRegistry } from "./agent/tools";

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
console.log("Step 3 smoke checks passed.");