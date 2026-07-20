// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FrontDeskScreen, type FrontDeskScreenProps } from "../src/screens/front-desk-screen.jsx";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { readQueue, type QueueStorage } from "../src/lib/checkin-queue.js";

/**
 * F3 — an undo-window check-in must NEVER be silently lost. Switching tabs or
 * reloading during the 10s window used to clear the timer with no POST, no
 * enqueue, and no error. On unmount we now FLUSH the pending intent: commit it
 * when the app is alive, or enqueue it to the degraded queue.
 */

afterEach(cleanup);

function memoryStorage(seed: Record<string, string> = {}): QueueStorage {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

const META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "bookings:v1",
  correlation_id: "corr-desk",
};
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

const BOOKING = {
  id: "book-1",
  person_id: "p1",
  status: "booked",
  checked_in_at: null,
  people: { first_name: "Maria" },
};
const roster = () => success({ roster: { bookings: [BOOKING], waitlist: [] } });

function renderDesk(overrides: Partial<FrontDeskScreenProps> = {}) {
  const onCheckIn = vi.fn().mockResolvedValue({ status: "checked_in" });
  const props: FrontDeskScreenProps = {
    rosterQueryFor: () => roster(),
    onCheckIn,
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    initialSessionId: "sess-1",
    storage: memoryStorage(),
    isOnline: () => true,
    ...overrides,
  };
  const result = render(<FrontDeskScreen {...props} />);
  return { ...result, onCheckIn, props };
}

describe("FrontDeskScreen — undo-window flush on unmount (F3)", () => {
  it("COMMITS a pending check-in when the tab is closed mid-window (app still online)", async () => {
    const { unmount, onCheckIn } = renderDesk();

    // Start the undo window but do NOT let the 10s timer elapse.
    fireEvent.click(await screen.findByTestId("check-in-book-1"));
    expect(screen.getByTestId("undo-window-book-1")).toBeDefined();
    expect(onCheckIn).not.toHaveBeenCalled();

    // Unmount during the window: the intent is flushed, not discarded.
    unmount();
    await vi.waitFor(() =>
      expect(onCheckIn).toHaveBeenCalledWith("sess-1", "book-1", expect.any(String)),
    );
  });

  it("ENQUEUES a pending check-in on unmount when offline (durable, never lost)", async () => {
    const storage = memoryStorage();
    const { unmount, onCheckIn } = renderDesk({ storage, isOnline: () => false });

    fireEvent.click(await screen.findByTestId("check-in-book-1"));
    expect(screen.getByTestId("undo-window-book-1")).toBeDefined();

    unmount();
    // Offline: the intent is queued on this device with its stable key, ready to
    // replay on reconnect — the POST was never fired.
    expect(readQueue(storage).map((item) => item.bookingId)).toEqual(["book-1"]);
    expect(onCheckIn).not.toHaveBeenCalled();
  });

  it("does NOT flush a check-in the operator explicitly undid", async () => {
    const { unmount, onCheckIn } = renderDesk();

    fireEvent.click(await screen.findByTestId("check-in-book-1"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    unmount();

    // Undo cancels the intent entirely — nothing to commit or queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCheckIn).not.toHaveBeenCalled();
  });
});

// WS-8: the waitlist accept/decline booking mutations were stubbed as vi.fn()
// and NEVER invoked (audit CRITICAL #5). These pin the promote/release path:
// the per-entry idempotency key, its reuse on retry, independence across
// entries, and the honest failure states (nothing silently dropped).
const OFFERED = {
  id: "wl-1",
  person_id: "p2",
  position: 1,
  status: "offered",
  offer_expires_at: "2026-07-19T13:00:00.000Z",
  people: { first_name: "Jon" },
};
const OFFERED2 = { ...OFFERED, id: "wl-2", person_id: "p3", people: { first_name: "Kim" } };
const rosterWaitlist = (entries: unknown[]) => success({ roster: { bookings: [], waitlist: entries } });

describe("FrontDeskScreen — waitlist accept/decline mutations (WS-8, CRITICAL #5)", () => {
  it("accept calls onAccept once with the entry id + a stable idempotency key", async () => {
    const onAccept = vi.fn().mockResolvedValue({ booking_id: "b1" });
    renderDesk({ rosterQueryFor: () => rosterWaitlist([OFFERED]), onAccept });
    fireEvent.click(screen.getByTestId("waitlist-accept-wl-1"));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect(onAccept.mock.calls[0]?.[0]).toBe("wl-1");
    expect(typeof onAccept.mock.calls[0]?.[1]).toBe("string");
    expect((onAccept.mock.calls[0]?.[1] as string).length).toBeGreaterThan(10);
  });

  it("a failed accept SURFACES the error (never a silent drop) and a retry REUSES the same key", async () => {
    const onAccept = vi
      .fn()
      .mockRejectedValueOnce(new Error("that offer just filled"))
      .mockResolvedValueOnce({ booking_id: "b1" });
    renderDesk({ rosterQueryFor: () => rosterWaitlist([OFFERED]), onAccept });
    fireEvent.click(screen.getByTestId("waitlist-accept-wl-1"));
    // The failure is shown, not swallowed — the operator knows nothing promoted.
    expect(await screen.findByText(/that offer just filled/i)).toBeDefined();
    fireEvent.click(screen.getByTestId("waitlist-accept-wl-1"));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(2));
    // The offer-book is a MONEY mutation — the retry must reuse the intent key.
    expect(onAccept.mock.calls[0]?.[1]).toBe(onAccept.mock.calls[1]?.[1]);
  });

  it("a non-Error rejection falls back to the honest 'Nothing was booked' copy", async () => {
    const onAccept = vi.fn().mockRejectedValue("network gone"); // not an Error instance
    renderDesk({ rosterQueryFor: () => rosterWaitlist([OFFERED]), onAccept });
    fireEvent.click(screen.getByTestId("waitlist-accept-wl-1"));
    expect(await screen.findByText(/nothing was booked/i)).toBeDefined();
  });

  it("two offered entries get INDEPENDENT idempotency keys", async () => {
    const onAccept = vi.fn().mockResolvedValue({ booking_id: "b1" });
    renderDesk({ rosterQueryFor: () => rosterWaitlist([OFFERED, OFFERED2]), onAccept });
    fireEvent.click(screen.getByTestId("waitlist-accept-wl-1"));
    fireEvent.click(screen.getByTestId("waitlist-accept-wl-2"));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(2));
    expect(onAccept.mock.calls[0]?.[1]).not.toBe(onAccept.mock.calls[1]?.[1]);
  });

  it("decline calls onDecline; a failure surfaces the decline error (nothing silently dropped)", async () => {
    const onDecline = vi.fn().mockRejectedValue("network gone"); // non-Error → fallback copy
    renderDesk({ rosterQueryFor: () => rosterWaitlist([OFFERED]), onDecline });
    fireEvent.click(screen.getByTestId("waitlist-decline-wl-1"));
    expect(await screen.findByText(/couldn't be declined/i)).toBeDefined();
    expect(onDecline).toHaveBeenCalledWith("wl-1", expect.any(String));
  });
});
