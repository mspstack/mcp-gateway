/**
 * Replay buffer for server→client SSE events (MCP resumability).
 *
 * Without an event store, a server-initiated notification sent while the
 * client's standalone GET stream is closed is dropped on the floor: the SDK
 * returns early with a comment about storing it for replay, and there is
 * nothing to store it in. That silently loses `tools/list_changed` — the one
 * notification this gateway emits — so a user who flips a tool on `/me` between
 * two client reconnects never learns their list moved.
 *
 * One store per session (created next to its transport, discarded with it), so
 * events can never leak across principals and cleanup needs no bookkeeping.
 * Bounded per stream: this is a resume window, not a durable log — a client
 * that fell far behind gets whatever is still buffered and can always fall back
 * to re-listing.
 */

import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Events kept per stream. Notifications are small; this is ~one per change. */
const DEFAULT_LIMIT = 64;

interface StoredEvent {
  id: EventId;
  message: JSONRPCMessage;
}

export class ReplayEventStore implements EventStore {
  private readonly streams = new Map<StreamId, StoredEvent[]>();
  private counter = 0;

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    // The stream id has to be recoverable from the event id: on resume the SDK
    // hands us only the Last-Event-ID header.
    const id = `${streamId}|${++this.counter}`;
    const events = this.streams.get(streamId) ?? [];
    events.push({ id, message });
    if (events.length > this.limit) events.splice(0, events.length - this.limit);
    this.streams.set(streamId, events);
    return id;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const streamId = streamIdOf(eventId);
    return streamId !== undefined && this.streams.has(streamId) ? streamId : undefined;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const streamId = streamIdOf(lastEventId) ?? "";
    const events = this.streams.get(streamId) ?? [];
    const from = events.findIndex((event) => event.id === lastEventId);
    // Unknown id (buffer rotated past it, or a stale client): replay nothing
    // rather than everything — a flood of stale notifications is worse than a
    // client that re-lists on its own.
    if (from >= 0) {
      for (const event of events.slice(from + 1)) await send(event.id, event.message);
    }
    return streamId;
  }
}

/** Event ids are `<streamId>|<counter>`; stream ids never contain a pipe. */
const streamIdOf = (eventId: EventId): StreamId | undefined => {
  const cut = eventId.lastIndexOf("|");
  return cut > 0 ? eventId.slice(0, cut) : undefined;
};
