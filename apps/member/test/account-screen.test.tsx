// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountScreen, type AccountScreenProps } from "../src/components/account-screen.jsx";
import type { AccountView } from "../src/lib/account-view.js";

/**
 * The read-only account area. Presentational + driven by an injected `load`;
 * these tests pin the ready/empty/error/unauthenticated states with fakes —
 * NO network, no member id sent (scope is the session cookie).
 */

afterEach(cleanup);

function renderScreen(overrides: Partial<AccountScreenProps> = {}) {
  const props: AccountScreenProps = {
    load: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
      ok: true,
      creditBalance: 6,
      waiverNeedsSignature: false,
      bookings: [
        { bookingId: "b1", sessionId: "s1", status: "booked", title: "Morning Sauna", when: "Tue · 7:00 AM", startsAt: "2026-07-21T07:00:00.000Z" },
      ],
    }),
    onRequireSignIn: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
  render(<AccountScreen {...props} />);
  return props;
}

describe("AccountScreen", () => {
  it("renders the credit balance, waiver status, and booked sessions", async () => {
    renderScreen();
    expect(await screen.findByText("6")).toBeDefined();
    expect(screen.getByText("Signed")).toBeDefined();
    expect(screen.getByText("Morning Sauna")).toBeDefined();
    expect(screen.getByText("Tue · 7:00 AM")).toBeDefined();
    expect(screen.getByText("Booked")).toBeDefined();
  });

  it("renders the checked-in badge and the outside-window time fallback", async () => {
    renderScreen({
      load: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
        ok: true,
        creditBalance: 1,
        waiverNeedsSignature: false,
        bookings: [
          // checked_in badge branch:
          { bookingId: "b1", sessionId: "s1", status: "checked_in", title: "Evening Sauna", when: "Wed · 6:00 PM", startsAt: "2026-07-22T18:00:00.000Z" },
          // session outside the loaded window → null when → fallback copy:
          { bookingId: "b2", sessionId: "s2", status: "booked", title: "Booked session", when: null, startsAt: null },
        ],
      }),
    });
    expect(await screen.findByText("Checked in")).toBeDefined();
    expect(screen.getByText("Time to be confirmed")).toBeDefined();
    // Singular credit copy (creditBalance === 1).
    expect(screen.getByText(/1 credit ·/)).toBeDefined();
  });

  it("offers a Sign out action that invokes the injected handler", async () => {
    const onSignOut = vi.fn();
    renderScreen({ onSignOut });
    const btn = await screen.findByRole("button", { name: /sign out/i });
    fireEvent.click(btn);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("shows the signature-needed badge when the waiver is unsigned", async () => {
    renderScreen({
      load: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
        ok: true,
        creditBalance: 0,
        waiverNeedsSignature: true,
        bookings: [],
      }),
    });
    expect(await screen.findByText("Signature needed")).toBeDefined();
  });

  it("shows an honest empty state (not a bare 'nothing here') with a route to book", async () => {
    renderScreen({
      load: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
        ok: true,
        creditBalance: 3,
        waiverNeedsSignature: false,
        bookings: [],
      }),
    });
    expect(await screen.findByText(/no sessions booked yet/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /browse the schedule/i }).getAttribute("href")).toBe("/");
  });

  it("hands an unauthenticated read off to Identify (never renders account data)", async () => {
    const onRequireSignIn = vi.fn();
    renderScreen({
      load: vi.fn<() => Promise<AccountView>>().mockResolvedValue({ ok: false, unauthenticated: true }),
      onRequireSignIn,
    });
    await waitFor(() => expect(onRequireSignIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/credit balance/i)).toBeNull();
  });

  it("surfaces a retryable error (non-401) and reloads on retry", async () => {
    const load = vi
      .fn<() => Promise<AccountView>>()
      .mockResolvedValueOnce({ ok: false, unauthenticated: false })
      .mockResolvedValueOnce({ ok: true, creditBalance: 2, waiverNeedsSignature: false, bookings: [] });
    renderScreen({ load });

    expect(await screen.findByText(/couldn't load your account/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/no sessions booked yet/i)).toBeDefined();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
