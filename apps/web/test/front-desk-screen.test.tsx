// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
