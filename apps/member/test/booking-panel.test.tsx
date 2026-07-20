// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BookingPanel,
  type AccountLoad,
  type BookOutcome,
  type BookingPanelProps,
  type WaitlistOutcome,
} from "../src/components/booking-panel.jsx";

/**
 * The Book → Confirmed core (plan-member-app §3H). The panel is presentational
 * and driven by injected member-core-wired callbacks; these tests pin every
 * branch of the gate + booking state machine with fakes — NO network, no
 * member id ever leaves the panel (scope is the session, verified by the
 * callbacks taking only an idempotency key).
 */

afterEach(cleanup);

const SESSION = {
  session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  offering_name: "Contrast Therapy",
  starts_at: "2026-07-21T18:00:00.000Z",
  ends_at: "2026-07-21T18:45:00.000Z",
  available: 3,
  credit_cost: 1,
};

function renderPanel(overrides: Partial<BookingPanelProps> = {}) {
  const props: BookingPanelProps = {
    session: SESSION,
    formatWhen: () => "Tue, Jul 21 · 6:00 – 6:45 PM",
    loadAccount: vi.fn<() => Promise<AccountLoad>>().mockResolvedValue({
      ok: true,
      creditBalance: 5,
      waiverNeedsSignature: false,
      bookedSessionIds: [],
    }),
    onBook: vi.fn<(k: string) => Promise<BookOutcome>>().mockResolvedValue({ ok: true }),
    onJoinWaitlist: vi.fn<(k: string) => Promise<WaitlistOutcome>>().mockResolvedValue({ ok: true, position: 2 }),
    onRequireSignIn: vi.fn(),
    makeIdempotencyKey: vi.fn(() => "key-1"),
    loadWaiver: vi
      .fn()
      .mockResolvedValue({ ok: true, needsSignature: true, title: "Waiver", body: "Assume all risk." }),
    onSignWaiver: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  render(<BookingPanel {...props} />);
  return props;
}

describe("BookingPanel — happy path", () => {
  it("books with one credit and confirms the remaining balance", async () => {
    const onBook = vi.fn<(k: string) => Promise<BookOutcome>>().mockResolvedValue({ ok: true });
    renderPanel({ onBook });

    const bookBtn = await screen.findByRole("button", { name: /book with 1 credit/i });
    fireEvent.click(bookBtn);

    await waitFor(() => expect(onBook).toHaveBeenCalledWith("key-1"));
    const confirmed = await screen.findByText(/you're booked/i);
    expect(confirmed.textContent).toMatch(/4 left/i); // 5 - 1
  });
});

describe("BookingPanel — gates", () => {
  it("routes an unsigned-waiver member into the in-flow waiver step (no book button yet)", async () => {
    renderPanel({
      loadAccount: vi
        .fn<() => Promise<AccountLoad>>()
        .mockResolvedValue({ ok: true, creditBalance: 5, waiverNeedsSignature: true, bookedSessionIds: [] }),
    });
    // The WaiverStep renders the text + sign affordance — not a dead-end.
    expect(await screen.findByText(/assume all risk/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /sign & continue/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /book with 1 credit/i })).toBeNull();
  });

  it("after signing the waiver in-flow, re-gates and offers the credit book", async () => {
    // First gate says waiver needed; after signing, the re-gate says it's done.
    const loadAccount = vi
      .fn<() => Promise<AccountLoad>>()
      .mockResolvedValueOnce({ ok: true, creditBalance: 5, waiverNeedsSignature: true, bookedSessionIds: [] })
      .mockResolvedValue({ ok: true, creditBalance: 5, waiverNeedsSignature: false, bookedSessionIds: [] });
    const onSignWaiver = vi.fn().mockResolvedValue({ ok: true });
    renderPanel({ loadAccount, onSignWaiver });

    const name = await screen.findByLabelText(/type your full name/i);
    fireEvent.change(name, { target: { value: "Jane Member" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /sign & continue/i }));

    await waitFor(() => expect(onSignWaiver).toHaveBeenCalledWith("Jane Member"));
    // Re-gate landed on the bookable state.
    expect(await screen.findByRole("button", { name: /book with 1 credit/i })).toBeDefined();
  });

  it("shows out-of-credits (no book button) when the balance is below cost", async () => {
    renderPanel({
      loadAccount: vi
        .fn<() => Promise<AccountLoad>>()
        .mockResolvedValue({ ok: true, creditBalance: 0, waiverNeedsSignature: false, bookedSessionIds: [] }),
    });
    expect(await screen.findByText(/out of credits/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /book with 1 credit/i })).toBeNull();
  });

  it("recognizes an existing booking for this session", async () => {
    renderPanel({
      loadAccount: vi.fn<() => Promise<AccountLoad>>().mockResolvedValue({
        ok: true,
        creditBalance: 5,
        waiverNeedsSignature: false,
        bookedSessionIds: [SESSION.session_id],
      }),
    });
    expect(await screen.findByText(/already booked/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /book with 1 credit/i })).toBeNull();
  });

  it("sends an unauthenticated member to Identify (never renders account data)", async () => {
    const onRequireSignIn = vi.fn();
    renderPanel({
      loadAccount: vi.fn<() => Promise<AccountLoad>>().mockResolvedValue({ ok: false, unauthenticated: true }),
      onRequireSignIn,
    });
    await waitFor(() => expect(onRequireSignIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /book with 1 credit/i })).toBeNull();
  });
});

describe("BookingPanel — waitlist", () => {
  it("offers the waitlist directly for a full session, then confirms the position", async () => {
    const onJoinWaitlist = vi
      .fn<(k: string) => Promise<WaitlistOutcome>>()
      .mockResolvedValue({ ok: true, position: 4 });
    renderPanel({ session: { ...SESSION, available: 0 }, onJoinWaitlist });

    const joinBtn = await screen.findByRole("button", { name: /join the waitlist/i });
    // A full session should NOT offer a credit-book path.
    expect(screen.queryByRole("button", { name: /book with 1 credit/i })).toBeNull();
    fireEvent.click(joinBtn);

    expect(await screen.findByText(/position 4/i)).toBeDefined();
    expect(onJoinWaitlist).toHaveBeenCalledTimes(1);
  });

  it("falls through to the waitlist when the seat is lost at book time (race)", async () => {
    const onBook = vi
      .fn<(k: string) => Promise<BookOutcome>>()
      .mockResolvedValue({ ok: false, reason: "race" });
    renderPanel({ onBook });

    fireEvent.click(await screen.findByRole("button", { name: /book with 1 credit/i }));

    // The race copy is honest that nothing was charged, and offers the waitlist.
    expect(await screen.findByText(/just filled/i)).toBeDefined();
    expect(await screen.findByRole("button", { name: /join the waitlist/i })).toBeDefined();
  });
});

describe("BookingPanel — book-time reason branches", () => {
  async function bookWithReason(reason: "no_credits" | "waiver" | "unavailable") {
    const onBook = vi.fn<(k: string) => Promise<BookOutcome>>().mockResolvedValue({ ok: false, reason });
    renderPanel({ onBook });
    fireEvent.click(await screen.findByRole("button", { name: /book with 1 credit/i }));
  }

  it("no_credits → out-of-credits (never a dead retry loop)", async () => {
    await bookWithReason("no_credits");
    expect(await screen.findByText(/out of credits/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("waiver → the in-flow waiver step", async () => {
    await bookWithReason("waiver");
    // The book-time waiver reason lands in the same in-flow WaiverStep as the gate.
    expect(await screen.findByText(/assume all risk/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /sign & continue/i })).toBeDefined();
  });

  it("unavailable → a terminal 'no longer open' message with a way back", async () => {
    await bookWithReason("unavailable");
    expect(await screen.findByText(/isn't open for booking anymore/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /back to the schedule/i })).toBeDefined();
    // Terminal — no book/waitlist retry that would loop against a closed session.
    expect(screen.queryByRole("button", { name: /book with 1 credit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /join the waitlist/i })).toBeNull();
  });
});

describe("BookingPanel — errors + idempotency", () => {
  it("reuses the SAME idempotency key across a book retry (no double-debit)", async () => {
    const onBook = vi
      .fn<(k: string) => Promise<BookOutcome>>()
      .mockResolvedValueOnce({ ok: false, reason: "retry" }) // transient failure
      .mockResolvedValueOnce({ ok: true });
    const makeIdempotencyKey = vi.fn(() => "stable-key");
    renderPanel({ onBook, makeIdempotencyKey });

    fireEvent.click(await screen.findByRole("button", { name: /book with 1 credit/i }));
    const retry = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(retry);

    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(2));
    expect(onBook.mock.calls[0]?.[0]).toBe("stable-key");
    expect(onBook.mock.calls[1]?.[0]).toBe("stable-key"); // SAME key on retry
    // The key factory is called exactly once for the booking intent.
    expect(makeIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it("surfaces an account-load failure with a retry that does not leak booking", async () => {
    const loadAccount = vi
      .fn<() => Promise<AccountLoad>>()
      .mockResolvedValueOnce({ ok: false, unauthenticated: false })
      .mockResolvedValueOnce({ ok: true, creditBalance: 5, waiverNeedsSignature: false, bookedSessionIds: [] });
    renderPanel({ loadAccount });

    const alert = await screen.findByText(/couldn't load your account/i);
    expect(alert).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Retry re-runs the loader and lands on the bookable state.
    expect(await screen.findByRole("button", { name: /book with 1 credit/i })).toBeDefined();
    await waitFor(() => expect(loadAccount).toHaveBeenCalledTimes(2));
  });
});
