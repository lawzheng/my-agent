import { MockModel } from "../../agent/mockModel";
import type { ApiAdapter } from "../types";

/**
 * Adapts the offline MockModel to the provider layer. Keeping the mock behind the
 * same ApiAdapter interface means the registry, runtime, and API routes treat it
 * exactly like a real provider — which is the whole teaching point.
 *
 * It also streams, splitting the reply into word-sized chunks, so the UI typing
 * effect can be demoed without a network.
 */
export function createMockAdapter(): ApiAdapter {
  const model = new MockModel();

  return {
    id: "mock",
    async complete(request) {
      return model.complete({
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
      });
    },
    async *stream(request) {
      const message = await model.complete({
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
      });

      for (const block of message.content) {
        if (block.type !== "text") continue;
        for (const chunk of block.text.match(/\S+\s*/g) ?? []) {
          yield { type: "text_delta", delta: chunk };
        }
      }
      yield { type: "done", message };
    },
  };
}
