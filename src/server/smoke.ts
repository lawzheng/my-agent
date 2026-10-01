import { runAgentLoop } from "./agent/loop";
import { createUserMessage } from "./agent/message";
import { MockModel } from "./agent/mockModel";

const result = await runAgentLoop({
  systemPrompt: "你是教学 Agent。",
  messages: [createUserMessage("列出工作区文件")],
  tools: [{ name: "list_files", description: "List files.", parameters: { type: "object" } }],
  model: new MockModel(),
  toolRegistry: {
    definitions: () => [],
    execute: async () => ({ content: [{ type: "text", text: "README.md" }] }),
  },
});

console.log(result.newMessages.map((message) => message.role));