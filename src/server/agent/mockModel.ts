import type { ToolCallContent } from "../../shared/protocol";
import { createAssistantMessage, messageText, text } from "./message";
import type { CompleteInput, TeachingModel } from "./model";

export class MockModel implements TeachingModel {
  private nextCallId = 1;

  async complete(input: CompleteInput) {
    const last = input.messages[input.messages.length - 1];
    if (!last) return createAssistantMessage([text("还没有上下文。")]);

    if (last.role === "toolResult") {
      return createAssistantMessage([text(`我看到了工具结果：${messageText(last)}`)]);
    }

    if (last.role !== "user") {
      return createAssistantMessage([text("教学版 Agent 收到你的问题。")]);
    }

    const prompt = messageText(last);
    const filePath = prompt.match(/[\w./-]+\.[\w]+/)?.[0];
    let toolCall: ToolCallContent | undefined;

    if (prompt.includes("读取")) {
      toolCall = {
        type: "toolCall",
        id: this.createCallId(),
        name: "read_file",
        arguments: { path: filePath ?? "agent-notes.md" },
      };
    } else if (prompt.includes("笔记")) {
      toolCall = {
        type: "toolCall",
        id: this.createCallId(),
        name: "write_note",
        arguments: { fileName: filePath ?? "agent-note.md", content: prompt },
      };
    } else if (filePath) {
      toolCall = {
        type: "toolCall",
        id: this.createCallId(),
        name: "read_file",
        arguments: { path: filePath },
      };
    } else if (prompt.includes("列出") || prompt.includes("文件")) {
      toolCall = {
        type: "toolCall",
        id: this.createCallId(),
        name: "list_files",
        arguments: { path: "." },
      };
    }

    if (toolCall) return createAssistantMessage([toolCall], "toolUse");
    return createAssistantMessage([text("教学版 Agent 收到你的问题。")]);
  }

  private createCallId(): string {
    return `call_${this.nextCallId++}`;
  }
}