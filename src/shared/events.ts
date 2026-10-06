import type { AgentEvent } from "./protocol";

/**
 * Append an event, merging a run of `message_update` events into a single
 * evolving entry.
 *
 * Streaming produces one `message_update` per token. Keeping them all would
 * flood the session event log and the UI timeline, so consecutive updates are
 * coalesced by concatenating their deltas. Any other event ends the run.
 */
export function appendCoalescedEvent(events: AgentEvent[], event: AgentEvent): void {
  if (event.type === "message_update") {
    const last = events[events.length - 1];
    if (last?.type === "message_update") {
      events[events.length - 1] = { ...last, delta: last.delta + event.delta };
      return;
    }
  }
  events.push(event);
}

/** Return a new array with `event` appended using the coalescing rule above. */
export function withCoalescedEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  const next = [...events];
  appendCoalescedEvent(next, event);
  return next;
}
