/**
 * Replay buffer semantics: ids carry their stream, resume sends only what came
 * after, an unknown id replays nothing, and the window is bounded.
 */

import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ReplayEventStore } from "./event-store.js";

const note = (n: number): JSONRPCMessage => ({
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
  params: { n },
});

const collect = async (store: ReplayEventStore, lastEventId: string) => {
  const sent: Array<{ id: string; n: unknown }> = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: async (id, message) => {
      sent.push({ id, n: (message as { params?: { n?: unknown } }).params?.n });
    },
  });
  return { streamId, sent };
};

describe("ReplayEventStore", () => {
  it("replays only the events after the given id, on that id's stream", async () => {
    const store = new ReplayEventStore();
    const first = await store.storeEvent("_GET_stream", note(1));
    await store.storeEvent("_GET_stream", note(2));
    await store.storeEvent("_GET_stream", note(3));

    const { streamId, sent } = await collect(store, first);
    expect(streamId).toBe("_GET_stream");
    expect(sent.map((e) => e.n)).toEqual([2, 3]);
    expect(await store.getStreamIdForEventId(first)).toBe("_GET_stream");
  });

  it("keeps streams apart", async () => {
    const store = new ReplayEventStore();
    const a = await store.storeEvent("stream-a", note(1));
    await store.storeEvent("stream-b", note(99));
    await store.storeEvent("stream-a", note(2));

    const { sent } = await collect(store, a);
    expect(sent.map((e) => e.n)).toEqual([2]);
  });

  it("replays nothing for an id it no longer knows", async () => {
    const store = new ReplayEventStore();
    await store.storeEvent("_GET_stream", note(1));

    // A flood of stale notifications is worse than a client that re-lists.
    expect((await collect(store, "_GET_stream|999")).sent).toEqual([]);
    expect((await collect(store, "garbage")).sent).toEqual([]);
    expect(await store.getStreamIdForEventId("other-stream|1")).toBeUndefined();
  });

  it("bounds the window, dropping the oldest events", async () => {
    const store = new ReplayEventStore(2);
    const first = await store.storeEvent("s", note(1));
    const second = await store.storeEvent("s", note(2));
    await store.storeEvent("s", note(3));

    // `first` rotated out — resuming from it can't be honoured…
    expect((await collect(store, first)).sent).toEqual([]);
    // …but the two most recent are still there.
    expect((await collect(store, second)).sent.map((e) => e.n)).toEqual([3]);
  });
});
