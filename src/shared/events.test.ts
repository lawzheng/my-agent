import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, AssistantMessage } from "./protocol";
import { appendCoalescedEvent, withCoalescedEvent } from "./events";

const assistant: AssistantMessage = {
  role: "assistant",
  content: [],
  stopReason: "pending",
  usage: { input: 0, output: 0, totalTokens: 0 },
  timestamp: 0,
};

function update(delta: string): AgentEvent {
  return { type: "message_update", message: assistant, delta };
}

test("appendCoalescedEvent merges consecutive message_update deltas", () => {
  const events: AgentEvent[] = [];
  appendCoalescedEvent(events, update("Hel"));
  appendCoalescedEvent(events, update("lo"));
  appendCoalescedEvent(events, update(" world"));

  assert.equal(events.length, 1);
  assert.equal(events[0].type === "message_update" && events[0].delta, "Hello world");
});

test("appendCoalescedEvent starts a new entry after any other event", () => {
  const events: AgentEvent[] = [];
  appendCoalescedEvent(events, update("a"));
  appendCoalescedEvent(events, { type: "turn_end", turn: 1, message: assistant, toolResults: [] });
  appendCoalescedEvent(events, update("b"));

  assert.deepEqual(
    events.map((event) => event.type),
    ["message_update", "turn_end", "message_update"],
  );
});

test("withCoalescedEvent does not mutate the input array", () => {
  const original: AgentEvent[] = [update("a")];
  const next = withCoalescedEvent(original, update("b"));

  assert.equal(original.length, 1);
  assert.equal(original[0].type === "message_update" && original[0].delta, "a");
  assert.equal(next.length, 1);
  assert.equal(next[0].type === "message_update" && next[0].delta, "ab");
});

test("appendCoalescedEvent keeps non-update events as-is", () => {
  const events: AgentEvent[] = [];
  appendCoalescedEvent(events, { type: "agent_start" });
  appendCoalescedEvent(events, { type: "tool_execution_start", toolCallId: "c1", toolName: "read_file", args: {} });
  appendCoalescedEvent(events, { type: "agent_end", messages: [] });

  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_start", "tool_execution_start", "agent_end"],
  );
});
