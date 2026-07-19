// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderBook(overrides: Partial<BookScreenProps> = {}) {
  const onHold = vi.fn().mockResolvedValue({ hold_id: "hold-1" });
  const onFreeze = vi.fn().mockResolvedValue(undefined);
  const onRelease = vi.fn().mockResolvedValue(undefined);
  const onBook = vi.fn().mockResolvedValue({ booking_id: "book-1", credit_entry_id: "credit-1" });
  const onJoinWaitlist = vi.fn().mockResolvedValue({ position: 3 });
  const props: BookScreenProps = {
    availabilityQuery: success({ sessions: [OPEN_SLOT] }),
    statusQueryFor: () => waiverStatus(false),
    onHold,
    onFreeze,
    onRelease,
    onBook,
    onJoinWaitlist,
    ...overrides,
  };
  render(<BookScreen {...props} />);
  return { onHold, onFreeze, onRelease, onBook, onJoinWaitlist };
}

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
