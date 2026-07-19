import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueCheckIn,
  readQueue,
  removeFromQueue,
  replayQueue,
  type QueuedCheckIn,
  type QueueStorage,
} from "../src/lib/checkin-queue.js";

/**
 * The degraded-mode check-in queue: enqueue on failure, replay idempotently on
 * reconnect, and SURVIVE a reload. Storage is a plain in-memory map — a
 * "simulated reload" is just constructing a fresh reader over the same bytes.
 */

function memoryStorage(seed: Record<string, string> = {}): QueueStorage & { dump(): Record<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    dump: () => Object.fromEntries(store),
  };
}

function entry(bookingId: string): QueuedCheckIn {
  return {
    bookingId,
    sessionId: "sess-1",
    personLabel: "Maria",
    idempotencyKey: `key-${bookingId}`,
    queuedAt: "2026-07-19T12:00:00.000Z",
  };
}

describe("checkin-queue", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("enqueues a failed check-in and reads it back", () => {
    enqueueCheckIn(entry("book-1"), storage);
    expect(readQueue(storage).map((item) => item.bookingId)).toEqual(["book-1"]);
  });

  it("is idempotent by bookingId — a double-enqueue keeps ONE entry (and its key)", () => {
    enqueueCheckIn(entry("book-1"), storage);
    enqueueCheckIn({ ...entry("book-1"), idempotencyKey: "key-DIFFERENT" }, storage);
    const queue = readQueue(storage);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.idempotencyKey).toBe("key-book-1"); // the first key is preserved
  });

  it("survives a simulated reload (a fresh reader over the same bytes sees the queue)", () => {
    enqueueCheckIn(entry("book-1"), storage);
    enqueueCheckIn(entry("book-2"), storage);
    // Simulate reload: a brand-new storage seeded from the persisted bytes.
    const reloaded = memoryStorage(storage.dump());
    expect(readQueue(reloaded).map((item) => item.bookingId)).toEqual(["book-1", "book-2"]);
  });

  it("replays with each entry's STABLE key and clears synced entries", async () => {
    enqueueCheckIn(entry("book-1"), storage);
    enqueueCheckIn(entry("book-2"), storage);
    const perform = vi.fn().mockResolvedValue(undefined);

    const outcome = await replayQueue(perform, storage);

    expect(perform).toHaveBeenCalledTimes(2);
    // Idempotent replay: the queued (stable) key is what goes to the server, so
    // a re-check-in of an already checked-in booking is a safe no-op.
    expect(perform.mock.calls[0]?.[0].idempotencyKey).toBe("key-book-1");
    expect(outcome.synced).toEqual(["book-1", "book-2"]);
    expect(readQueue(storage)).toHaveLength(0);
  });

  it("KEEPS a failed replay in the queue (surfaced, never dropped) and retries later", async () => {
    enqueueCheckIn(entry("book-1"), storage);
    enqueueCheckIn(entry("book-2"), storage);
    const perform = vi
      .fn()
      .mockResolvedValueOnce(undefined) // book-1 syncs
      .mockRejectedValueOnce(new Error("still offline")); // book-2 fails

    const outcome = await replayQueue(perform, storage);

    expect(outcome.synced).toEqual(["book-1"]);
    expect(outcome.failed.map((f) => f.bookingId)).toEqual(["book-2"]);
    // book-2 stays queued for the next reconnect — nothing was dropped.
    expect(readQueue(storage).map((item) => item.bookingId)).toEqual(["book-2"]);
  });

  it("preserves an entry enqueued DURING replay (merge, never blind-write the stale snapshot)", async () => {
    // Reconnect replays book-1; while its POST is in flight, a failed tap on
    // book-2 enqueues concurrently. The final write must NOT erase book-2.
    enqueueCheckIn(entry("book-1"), storage);
    const perform = vi.fn().mockImplementation(async () => {
      enqueueCheckIn(entry("book-2"), storage);
    });

    const outcome = await replayQueue(perform, storage);

    expect(perform).toHaveBeenCalledTimes(1); // only the snapshot entry replays
    expect(outcome.synced).toEqual(["book-1"]);
    // book-2, enqueued mid-replay, survives the replay's final write.
    expect(outcome.remaining.map((item) => item.bookingId)).toEqual(["book-2"]);
    expect(readQueue(storage).map((item) => item.bookingId)).toEqual(["book-2"]);
  });

  it("removeFromQueue drops a single booking", () => {
    enqueueCheckIn(entry("book-1"), storage);
    enqueueCheckIn(entry("book-2"), storage);
    removeFromQueue("book-1", storage);
    expect(readQueue(storage).map((item) => item.bookingId)).toEqual(["book-2"]);
  });

  it("tolerates malformed storage without throwing (a corrupt cache never wedges the desk)", () => {
    const corrupt = memoryStorage({ "kelo.checkin.queue.v1": "{not json" });
    expect(readQueue(corrupt)).toEqual([]);
  });
});
