import { describe, expect, it } from "vitest";
import { MemberApiError, type MemberResult } from "@kelo/member-core";
import type { MemberAccount } from "@kelo/contracts";
import { toAccountView, type SessionMeta } from "../src/lib/account-view.js";

/**
 * The account-view join: member-core account + the public schedule → the
 * read-only account view. Pins the session-name/time join, the soonest-first
 * ordering, the outside-window fallback, and the 401 → sign-in signal.
 */

const META = {
  as_of: "2026-07-20T12:00:00.000Z",
  source: "native" as const,
  stale: false,
  definition_version: "member-booking:v1",
  correlation_id: "corr-1",
};

const SESSION_META: Record<string, SessionMeta> = {
  s_late: { offering_name: "Late Plunge", starts_at: "2026-07-22T18:00:00.000Z", ends_at: "2026-07-22T18:45:00.000Z" },
  s_early: { offering_name: "Morning Sauna", starts_at: "2026-07-21T07:00:00.000Z", ends_at: "2026-07-21T07:45:00.000Z" },
};

const fmt = (s: string, e: string) => `${s}__${e}`;

function account(bookings: MemberAccount["bookings"], balance = 4): MemberResult<MemberAccount> {
  return {
    ok: true,
    value: { credit_balance: balance, waiver: { needs_signature: false }, bookings },
    meta: META,
  };
}

describe("toAccountView", () => {
  it("joins bookings to session name/time and orders soonest-first", () => {
    const res = account([
      { booking_id: "b1", session_id: "s_late", status: "booked" },
      { booking_id: "b2", session_id: "s_early", status: "checked_in" },
    ]);
    const view = toAccountView(res, SESSION_META, fmt);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.creditBalance).toBe(4);
    expect(view.waiverNeedsSignature).toBe(false);
    // s_early (Jul 21) before s_late (Jul 22).
    expect(view.bookings.map((b) => b.sessionId)).toEqual(["s_early", "s_late"]);
    expect(view.bookings[0]).toMatchObject({
      title: "Morning Sauna",
      status: "checked_in",
      when: "2026-07-21T07:00:00.000Z__2026-07-21T07:45:00.000Z",
    });
  });

  it("falls back gracefully for a booking whose session is outside the window", () => {
    const res = account([{ booking_id: "b1", session_id: "s_unknown", status: "booked" }]);
    const view = toAccountView(res, SESSION_META, fmt);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.bookings[0]).toMatchObject({ title: "Booked session", when: null, startsAt: null });
  });

  it("sorts unknown-start bookings after known ones", () => {
    const res = account([
      { booking_id: "b1", session_id: "s_unknown", status: "booked" },
      { booking_id: "b2", session_id: "s_early", status: "booked" },
    ]);
    const view = toAccountView(res, SESSION_META, fmt);
    if (!view.ok) throw new Error("expected ok");
    expect(view.bookings.map((b) => b.sessionId)).toEqual(["s_early", "s_unknown"]);
  });

  it("401 → unauthenticated (send to Identify)", () => {
    const res: MemberResult<MemberAccount> = {
      ok: false,
      error: new MemberApiError("http_error", "HTTP 401", { status: 401 }),
    };
    expect(toAccountView(res, SESSION_META, fmt)).toEqual({ ok: false, unauthenticated: true });
  });

  it("any other failure → not unauthenticated (a retryable account error)", () => {
    const res: MemberResult<MemberAccount> = {
      ok: false,
      error: new MemberApiError("http_error", "HTTP 500", { status: 500 }),
    };
    expect(toAccountView(res, SESSION_META, fmt)).toEqual({ ok: false, unauthenticated: false });
  });
});
