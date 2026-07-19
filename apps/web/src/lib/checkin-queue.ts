/**
 * The DEGRADED-MODE check-in queue (plan-ux §3C: "Queued on this device (N)").
 *
 * Check-in is the ONE booking action allowed to survive offline — it moves no
 * money, so a commit-after-reconnect is acceptable where an offline booking or
 * charge would never be (offline money is an unacceptable conflict risk,
 * plan-ux §7). When the check-in POST fails or the device is offline, the intent
 * is queued in localStorage; on reconnect it replays IDEMPOTENTLY (each entry
 * carries a stable per-booking Idempotency-Key, and a re-check-in of an already
 * checked-in booking no-ops server-side). The queue is stateless-in-memory: every
 * operation reads and writes storage, so it SURVIVES a reload — a "reload" is
 * just the next read. Failures are kept in the queue and surfaced, never dropped.
 *
 * Storage is injected (defaults to window.localStorage) so it is unit-testable
 * without a browser and a "simulated reload" is a fresh read of the same store.
 */

const STORAGE_KEY = "kelo.checkin.queue.v1";

/** A queued check-in intent. `idempotencyKey` is minted once per booking and
 *  reused on every replay so the server debit/no-op is safe. */
export interface QueuedCheckIn {
  bookingId: string;
  sessionId: string;
  /** Display label captured at queue time (the roster row's name), so the
   *  "queued" list reads honestly even after a reload with no roster loaded. */
  personLabel: string | null;
  idempotencyKey: string;
  queuedAt: string;
}

/** The minimal Storage surface used — Window.localStorage satisfies it. */
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): QueueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Access can throw in a locked-down context; degrade to a no-op queue.
    return null;
  }
}

/** Read the current queue (stable order; survives reload). Malformed storage
 *  yields an empty queue rather than throwing — a corrupt cache never wedges
 *  the desk. */
export function readQueue(storage: QueueStorage | null = defaultStorage()): QueuedCheckIn[] {
  if (storage === null) return [];
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueuedCheckIn =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as QueuedCheckIn).bookingId === "string" &&
        typeof (item as QueuedCheckIn).idempotencyKey === "string",
    );
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedCheckIn[], storage: QueueStorage | null): void {
  if (storage === null) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

/**
 * Enqueue a check-in intent. IDEMPOTENT by bookingId: queuing the same booking
 * twice keeps the FIRST entry (and its stable key), so a double-tap while
 * offline does not create two pending check-ins. Returns the new queue.
 */
export function enqueueCheckIn(
  entry: QueuedCheckIn,
  storage: QueueStorage | null = defaultStorage(),
): QueuedCheckIn[] {
  const queue = readQueue(storage);
  if (queue.some((item) => item.bookingId === entry.bookingId)) {
    return queue;
  }
  const next = [...queue, entry];
  writeQueue(next, storage);
  return next;
}

/** Remove a booking from the queue (after a confirmed replay). Returns the new queue. */
export function removeFromQueue(
  bookingId: string,
  storage: QueueStorage | null = defaultStorage(),
): QueuedCheckIn[] {
  const next = readQueue(storage).filter((item) => item.bookingId !== bookingId);
  writeQueue(next, storage);
  return next;
}

export interface ReplayOutcome {
  synced: string[];
  failed: { bookingId: string; error: unknown }[];
  remaining: QueuedCheckIn[];
}

/**
 * Replay the queue on reconnect. Each entry is performed with its STABLE key;
 * a confirmed replay is removed, a failure is KEPT (surfaced, never dropped).
 * `perform` calls the check-in API with the entry's idempotency key.
 */
export async function replayQueue(
  perform: (entry: QueuedCheckIn) => Promise<unknown>,
  storage: QueueStorage | null = defaultStorage(),
): Promise<ReplayOutcome> {
  const queue = readQueue(storage);
  const synced: string[] = [];
  const failed: { bookingId: string; error: unknown }[] = [];
  for (const entry of queue) {
    try {
      await perform(entry);
      synced.push(entry.bookingId);
    } catch (error) {
      failed.push({ bookingId: entry.bookingId, error });
    }
  }
  // MERGE, never blind-write the pre-await snapshot: an entry enqueued DURING
  // the awaited POSTs (a failed tap on another booking while we replay) lives
  // in storage now but NOT in `queue`. Re-read and remove exactly the ids that
  // synced — so a concurrent enqueue survives instead of being clobbered.
  const remaining = readQueue(storage).filter((item) => !synced.includes(item.bookingId));
  writeQueue(remaining, storage);
  return { synced, failed, remaining };
}
