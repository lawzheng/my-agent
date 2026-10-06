import { MockModel } from "../../agent/mockModel";
import type { ApiAdapter } from "../types";

/**
 * Adapts the offline MockModel to the provider layer. Keeping the mock behind the
 * same ApiAdapter interface means the registry, runtime, and API routes treat it
 * exactly like a real provider — which is the whole teaching point.
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
  };
}
