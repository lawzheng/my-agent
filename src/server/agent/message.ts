import type { AgentMessage, AssistantMessage, TextContent, UserMessage } from "../../shared/protocol";

export function text(value: string): TextContent {
  return { type: "text", text: value };
}

export function createUserMessage(input: string): UserMessage {
  return { role: "user", content: [text(input)], timestamp: Date.now() };
}

export function createAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };
}

export function messageText(message: AgentMessage): string {
  return message.content.reduce<string[]>((parts, block) => {
    if (block.type === "text") parts.push(block.text);
    return parts;
  }, []).join("\n");
}