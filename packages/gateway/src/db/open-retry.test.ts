/**
 * Boot-time database open is retried: on App Service the outgoing container
 * can still hold the file on the shared /home mount while the replacement
 * boots, and a single failed open used to be fatal (exit 1 -> crash loop).
 */

import { describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, openWithRetry } from "./index.js";

/** Minimal stand-in — openWithRetry only ever hands the handle back. */
const fakeDb = () => ({}) as unknown as DatabaseSync;

describe("openWithRetry", () => {
  it("does not retry or sleep when the first attempt works", () => {
    const connect = vi.fn(fakeDb);
    const sleep = vi.fn();
    expect(openWithRetry("/data/gateway.db", { connect, sleep })).toBeDefined();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a locked file with backoff and returns the handle once it opens", () => {
    let attempts = 0;
    const connect = vi.fn(() => {
      if (++attempts < 3) throw new Error("unable to open database file");
      return fakeDb();
    });
    const slept: number[] = [];

    expect(openWithRetry("/data/gateway.db", { connect, sleep: (ms) => slept.push(ms) })).toBeDefined();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([250, 500]); // backoff doubles
  });

  it("gives up at the deadline and rethrows the real error", () => {
    const connect = vi.fn(() => {
      throw new Error("unable to open database file");
    });
    // Zero budget: the first failure is already past the deadline.
    expect(() => openWithRetry("/data/gateway.db", { connect, sleep: vi.fn(), openTimeoutMs: 0 })).toThrow(
      /unable to open database file/
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("never spends the retry window on :memory: — nothing can be holding it", () => {
    const connect = vi.fn(() => {
      throw new Error("nope");
    });
    const sleep = vi.fn();
    expect(() => openWithRetry(":memory:", { connect, sleep, openTimeoutMs: 60_000 })).toThrow(/nope/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("caps the backoff so a long wait keeps checking every 5s", () => {
    let attempts = 0;
    const connect = vi.fn(() => {
      if (++attempts < 8) throw new Error("locked");
      return fakeDb();
    });
    const slept: number[] = [];
    openWithRetry("/data/gateway.db", { connect, sleep: (ms) => slept.push(ms) });
    expect(slept).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe("openDatabase", () => {
  it("runs migrations OUTSIDE the retry — a failing migration is never transient", () => {
    // A handle that survives connect but breaks in migrate(): if migrations
    // were inside the loop this would be retried (and re-applied) on a timer.
    const connect = vi.fn(
      () =>
        ({
          prepare: () => {
            throw new Error("migration boom");
          },
        }) as unknown as DatabaseSync
    );
    const sleep = vi.fn();
    expect(() => openDatabase(":memory:", { connect, sleep })).toThrow(/migration boom/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
