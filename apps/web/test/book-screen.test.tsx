// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiRequestError } from "../src/lib/api.js";
import { BookScreen, type BookScreenProps } from "../src/screens/book-screen.jsx";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";

afterEach(cleanup);

const META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "bookings:v1",
  correlation_id: "corr-book",
};
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

const OPEN_SLOT = {
  session_id: "sess-open",
  starts_at: "2026-07-19T13:00:00.000Z",
  capacity: 12,
  booked: 4,
  held: 1,
  available: 7,
  readiness_ok: true,
};
const FULL_SLOT = {
  session_id: "sess-full",
  starts_at: "2026-07-19T14:00:00.000Z",
  capacity: 8,
  booked: 8,
  held: 0,
  available: 0,
  readiness_ok: true,
};

function waiverStatus(needs: boolean): BoundaryQuery {
  return success({
    status: {
      has_current_signature: !needs,
      signed_version: needs ? null : 3,
      active_version: 3,
      needs_signature: needs,
    },
  });
}

function peopleResult(people: unknown[], truncated = false): unknown {
  return { data: { people, truncated }, meta: META };
}

function renderBook(overrides: Partial<BookScreenProps> = {}) {
  const onHold = vi.fn().mockResolvedValue({ id: "hold-1", expires_at: null, frozen: false });
  const onFreeze = vi.fn().mockResolvedValue(undefined);
  const onRelease = vi.fn().mockResolvedValue(undefined);
  const onBook = vi.fn().mockResolvedValue({ booking_id: "book-1", credit_entry_id: "credit-1" });
  const onJoinWaitlist = vi.fn().mockResolvedValue({ position: 3 });
  const onSearchPeople = vi.fn().mockResolvedValue(peopleResult([]));
  const props: BookScreenProps = {
    availabilityQuery: success({ sessions: [OPEN_SLOT] }),
    onSearchPeople,
    statusQueryFor: () => waiverStatus(false),
    onHold,
    onFreeze,
    onRelease,
    onBook,
    onJoinWaitlist,
    ...overrides,
  };
  render(<BookScreen {...props} />);
  return { onHold, onFreeze, onRelease, onBook, onJoinWaitlist, onSearchPeople };
}

// The by-id fallback path (a pasted id) — the previous behaviour, still present.
function loadPerson() {
  fireEvent.change(document.querySelector("#book-person") as HTMLInputElement, {
    target: { value: "person-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load member" }));
}

describe("BookScreen — waiver gate", () => {
  it("BLOCKS tender when the member needs a signature (preflight, not a bookable seat)", async () => {
    renderBook({ statusQueryFor: () => waiverStatus(true) });
    loadPerson();
    fireEvent.click(await screen.findByTestId("slot-book-sess-open"));

    // The held reservation appears, but the waiver preflight replaces tender.
    await waitFor(() => expect(screen.getByTestId("hold-countdown")).toBeDefined());
    expect(screen.getByTestId("waiver-preflight")).toBeDefined();
    // No tender tabs are offered until the waiver is clear.
    expect(screen.queryByTestId("book-tender-credit")).toBeNull();
  });

  it("renders the 403 booking_waiver_required as the preflight state, never a toast", async () => {
    const onBook = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(403, "booking_waiver_required", "sign first", "corr-x"));
    renderBook({ statusQueryFor: () => waiverStatus(false), onBook });
    loadPerson();
    fireEvent.click(await screen.findByTestId("slot-book-sess-open"));
    await waitFor(() => expect(screen.getByTestId("hold-countdown")).toBeDefined());

    // Waiver read was clear, so tender is offered; pick credit → freeze fires.
    fireEvent.click(screen.getByTestId("book-tender-credit"));
    const confirm = await screen.findByTestId("book-confirm");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    // The server's 403 backstop renders the preflight block.
    expect(await screen.findByTestId("waiver-preflight")).toBeDefined();
    expect(onBook).toHaveBeenCalledTimes(1);
  });

  it("passes use_credit=true and a per-intent key when a clear member books on credit", async () => {
    const { onBook, onFreeze } = renderBook({ statusQueryFor: () => waiverStatus(false) });
    loadPerson();
    fireEvent.click(await screen.findByTestId("slot-book-sess-open"));
    await waitFor(() => expect(screen.getByTestId("hold-countdown")).toBeDefined());

    fireEvent.click(screen.getByTestId("book-tender-credit"));
    await waitFor(() => expect(onFreeze).toHaveBeenCalledWith("hold-1"));
    const confirm = await screen.findByTestId("book-confirm");
    // The confirm button NAMES the act.
    expect(confirm.textContent).toContain("Book with 1 credit");
    fireEvent.click(confirm);

    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(1));
    const [input, key] = onBook.mock.calls[0] as [Record<string, unknown>, string];
    expect(input).toEqual({
      session_id: "sess-open",
      person_id: "person-1",
      hold_id: "hold-1",
      use_credit: true,
    });
    expect(typeof key).toBe("string");
    expect(await screen.findByTestId("book-result")).toBeDefined();
  });
});

describe("BookScreen — frozen hold never expires (F1)", () => {
  it("shows a STATIC locked state for a frozen hold past its TTL, never 'expired'", async () => {
    // A mutable clock: the hold is anchored at t0, then time is pushed past the
    // TTL before the freeze completes.
    let t = 1_000_000;
    const onHold = vi.fn().mockResolvedValue({ id: "hold-1", expires_at: null, frozen: false });
    renderBook({ onHold, statusQueryFor: () => waiverStatus(false), holdTtlSeconds: 60, now: () => t });
    loadPerson();

    fireEvent.click(await screen.findByTestId("slot-book-sess-open"));
    await waitFor(() => expect(screen.getByTestId("hold-countdown")).toBeDefined());
    // Before tender, the courtesy countdown is running.
    expect(screen.getByTestId("hold-countdown").textContent).toContain("Seat held for about");

    // Push the clock WELL past the TTL, then start tender → freeze-hold fires.
    t = 1_000_000 + 60_000 + 30_000;
    fireEvent.click(screen.getByTestId("book-tender-credit"));

    // Once frozen, the seat is locked to the tender: a static locked line, never
    // a running countdown and never the 'expired — reserve again' state.
    await waitFor(() =>
      expect(screen.getByTestId("hold-countdown").textContent).toContain("Seat locked for this tender"),
    );
    expect(screen.getByTestId("hold-countdown").textContent).not.toContain("expired");
    // Tender is still available — the operator is NOT pushed to re-hold the seat.
    expect(screen.getByTestId("book-confirm")).toBeDefined();
  });
});

describe("BookScreen — server-authoritative hold expiry (F4)", () => {
  it("anchors the countdown on the server expires_at, ignoring the client TTL", async () => {
    // Client TTL is a tiny 5s, but the server says the hold lives ~10 minutes;
    // the countdown must reflect the SERVER expiry, not the client anchor.
    const now = 1_000_000;
    const serverExpires = new Date(now + 600_000).toISOString();
    const onHold = vi
      .fn()
      .mockResolvedValue({ id: "hold-1", expires_at: serverExpires, frozen: false });
    renderBook({ onHold, statusQueryFor: () => waiverStatus(false), holdTtlSeconds: 5, now: () => now });
    loadPerson();

    fireEvent.click(await screen.findByTestId("slot-book-sess-open"));
    await waitFor(() => expect(screen.getByTestId("hold-countdown")).toBeDefined());
    // ~10:00 from the server expiry, NOT ~0:05 from the client TTL.
    expect(screen.getByTestId("hold-countdown").textContent).toContain("10:00");
  });
});

describe("BookScreen — slot picker", () => {
  it("offers a WAITLIST affordance for a full slot (never a bookable-empty seat)", async () => {
    const { onJoinWaitlist } = renderBook({
      availabilityQuery: success({ sessions: [FULL_SLOT] }),
    });
    loadPerson();

    // A full slot shows join-waitlist, not a reserve button.
    const waitlistButton = await screen.findByTestId("slot-waitlist-sess-full");
    expect(waitlistButton).toBeDefined();
    expect(screen.queryByTestId("slot-book-sess-full")).toBeNull();

    fireEvent.click(waitlistButton);
    await waitFor(() => expect(onJoinWaitlist).toHaveBeenCalledTimes(1));
    expect(onJoinWaitlist.mock.calls[0]?.[0]).toEqual({
      session_id: "sess-full",
      person_id: "person-1",
    });
    expect((await screen.findByTestId("waitlist-note")).textContent).toContain("position 3");
  });

  it("shows a not-ready room as not-ready, not as an open seat", async () => {
    renderBook({
      availabilityQuery: success({ sessions: [{ ...OPEN_SLOT, readiness_ok: false }] }),
    });
    loadPerson();
    expect(await screen.findByTestId("slot-not-ready-sess-open")).toBeDefined();
    expect(screen.queryByTestId("slot-book-sess-open")).toBeNull();
    expect(screen.queryByTestId("slot-waitlist-sess-open")).toBeNull();
  });
});

const PERSON_ROW = {
  id: "person-77",
  first_name: "Dana",
  last_name: "Ng",
  email: "dana@example.io",
  phone_e164: "+15557778888",
  source: "native" as const,
};

function typeSearch(value: string) {
  fireEvent.change(document.querySelector("#book-person-search") as HTMLInputElement, {
    target: { value },
  });
}

describe("BookScreen — person search typeahead (debounce + min length)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never fetches under 2 trimmed chars, and fires exactly once AFTER the debounce", () => {
    const onSearchPeople = vi.fn().mockResolvedValue(peopleResult([]));
    renderBook({ onSearchPeople, searchDebounceMs: 250 });

    // 1 char → below the minimum; no fetch even after the debounce elapses.
    typeSearch("a");
    act(() => vi.advanceTimersByTime(500));
    expect(onSearchPeople).not.toHaveBeenCalled();

    // "  b " trims to 1 char → still below the minimum.
    typeSearch("  b ");
    act(() => vi.advanceTimersByTime(500));
    expect(onSearchPeople).not.toHaveBeenCalled();

    // 2 chars → fires, but ONLY after the debounce window completes.
    typeSearch("an");
    act(() => vi.advanceTimersByTime(249));
    expect(onSearchPeople).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearchPeople).toHaveBeenCalledTimes(1);
    expect(onSearchPeople).toHaveBeenCalledWith("an", undefined);
  });

  it("drops a slow EARLIER response so a newer query's results always win (stale guard)", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    const onSearchPeople = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNew = resolve)));
    renderBook({ onSearchPeople, searchDebounceMs: 100 });

    // Query 1 fires, then a keystroke supersedes it with query 2.
    typeSearch("ann");
    act(() => vi.advanceTimersByTime(100));
    typeSearch("anna");
    act(() => vi.advanceTimersByTime(100));
    expect(onSearchPeople).toHaveBeenCalledTimes(2);

    // The NEWER query resolves first…
    await act(async () => {
      resolveNew(peopleResult([{ ...PERSON_ROW, id: "p-new", first_name: "Anna" }]));
    });
    // …then the OLDER query resolves LATE — it must be discarded, not rendered.
    await act(async () => {
      resolveOld(peopleResult([{ ...PERSON_ROW, id: "p-old", first_name: "Stale" }]));
    });

    expect(screen.getByTestId("person-result-p-new")).toBeDefined();
    expect(screen.queryByTestId("person-result-p-old")).toBeNull();
  });
});

describe("BookScreen — person search typeahead (results)", () => {
  it("selecting a result feeds the SAME person-summary step and books with a per-intent key for that person", async () => {
    const onSearchPeople = vi.fn().mockResolvedValue(peopleResult([PERSON_ROW]));
    const statusQueryFor = vi.fn(() => waiverStatus(false));
    const { onBook, onFreeze } = renderBook({
      onSearchPeople,
      statusQueryFor,
      searchDebounceMs: 0,
    });

    typeSearch("dana");
    const result = await screen.findByTestId("person-result-person-77");
    // Contact context is shown to disambiguate (staff surface).
    expect(result.textContent).toContain("Dana Ng");
    expect(result.textContent).toContain("dana@example.io");
    fireEvent.click(result);

    // The selected id flows into the injected waiver-status summary step.
    await waitFor(() => expect(statusQueryFor).toHaveBeenCalledWith("person-77"));
    expect(await screen.findByTestId("person-summary")).toBeDefined();

    // Booking the selected person mints the per-intent key for THIS person_id.
    fireEvent.click(await screen.findByTestId("slot-book-sess-open"));
    await waitFor(() => expect(screen.getByTestId("hold-countdown")).toBeDefined());
    fireEvent.click(screen.getByTestId("book-tender-credit"));
    await waitFor(() => expect(onFreeze).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("book-confirm"));

    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(1));
    const [input, key] = onBook.mock.calls[0] as [Record<string, unknown>, string];
    expect(input.person_id).toBe("person-77");
    expect(typeof key).toBe("string");
  });

  it("renders a refine-your-search hint when the result set is truncated", async () => {
    const onSearchPeople = vi.fn().mockResolvedValue(peopleResult([PERSON_ROW], true));
    renderBook({ onSearchPeople, searchDebounceMs: 0 });

    typeSearch("da");
    expect(await screen.findByTestId("person-search-truncated")).toBeDefined();
  });

  it("renders the empty state with the create-person deferral note when nothing matches", async () => {
    const onSearchPeople = vi.fn().mockResolvedValue(peopleResult([]));
    renderBook({ onSearchPeople, searchDebounceMs: 0 });

    typeSearch("zzzz");
    expect(await screen.findByText("No members match that search.")).toBeDefined();
    // The deferral note names that CREATE is not available yet (§3C).
    expect(screen.getByText(/isn't available yet/)).toBeDefined();
  });
});
