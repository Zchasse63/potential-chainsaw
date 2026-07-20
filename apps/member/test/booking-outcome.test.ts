import { describe, expect, it } from "vitest";
import { MemberApiError, type Booking, type MemberResult } from "@kelo/member-core";
import type { MemberAccount } from "@kelo/contracts";
import { toAccountLoad, toBookOutcome, toWaitlistOutcome } from "../src/lib/booking-outcome.js";

/**
 * The status/code → outcome mapping is the SAFETY-CRITICAL boundary of the
 * booking flow — it decides whether a lost capacity race offers the waitlist or
 * dead-ends. These tests pin it against the authoritative API error contract in
 * apps/api/src/data-bookings.ts (SQLSTATE → HTTP + code), so a drift in either
 * side breaks a test rather than a member's booking.
 */

const META = {
  as_of: "2026-07-20T12:00:00.000Z",
  source: "native" as const,
  stale: false,
  definition_version: "member-booking:v1",
  correlation_id: "corr-1",
};

/** An http_error MemberResult with the API's structured code, as member-core builds it. */
function httpErr<T>(status: number, code?: string): MemberResult<T> {
  return {
    ok: false,
    error: new MemberApiError("http_error", `HTTP ${status}`, {
      status,
      ...(code !== undefined ? { code } : {}),
    }),
  };
}

describe("toBookOutcome — the code → reason contract (data-bookings.ts)", () => {
  it("ok result → ok", () => {
    const res: MemberResult<Booking> = { ok: true, value: { booking_id: "b1" }, meta: META };
    expect(toBookOutcome(res)).toEqual({ ok: true });
  });

  it("409 session_at_capacity → race (offer the honest waitlist)", () => {
    expect(toBookOutcome(httpErr(409, "session_at_capacity"))).toEqual({ ok: false, reason: "race" });
  });

  it("409 idempotency_key_conflict → retry, NOT race (a different 409)", () => {
    // The bug this whole fix exists to prevent: the two 409s must not collapse.
    expect(toBookOutcome(httpErr(409, "idempotency_key_conflict"))).toEqual({
      ok: false,
      reason: "retry",
    });
  });

  it("422 insufficient_credits → no_credits", () => {
    expect(toBookOutcome(httpErr(422, "insufficient_credits"))).toEqual({
      ok: false,
      reason: "no_credits",
    });
  });

  it("403 booking_waiver_required → waiver", () => {
    expect(toBookOutcome(httpErr(403, "booking_waiver_required"))).toEqual({
      ok: false,
      reason: "waiver",
    });
  });

  it("422 booking_invalid and 404 booking_target_not_found → unavailable (terminal)", () => {
    expect(toBookOutcome(httpErr(422, "booking_invalid"))).toEqual({ ok: false, reason: "unavailable" });
    expect(toBookOutcome(httpErr(404, "booking_target_not_found"))).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("403 booking_forbidden and unknown/absent codes → retry (safe: same-key replay)", () => {
    expect(toBookOutcome(httpErr(403, "booking_forbidden"))).toEqual({ ok: false, reason: "retry" });
    expect(toBookOutcome(httpErr(500))).toEqual({ ok: false, reason: "retry" });
  });

  it("non-HTTP failures (network/shape) → retry", () => {
    const net: MemberResult<Booking> = {
      ok: false,
      error: new MemberApiError("network_error", "offline"),
    };
    expect(toBookOutcome(net)).toEqual({ ok: false, reason: "retry" });
  });
});

describe("toAccountLoad", () => {
  it("maps a live account into the gate inputs", () => {
    const account: MemberAccount = {
      credit_balance: 7,
      waiver: { needs_signature: false },
      bookings: [
        { booking_id: "bk1", session_id: "s1", status: "booked" },
        { booking_id: "bk2", session_id: "s2", status: "checked_in" },
      ],
    };
    const res: MemberResult<MemberAccount> = { ok: true, value: account, meta: META };
    expect(toAccountLoad(res)).toEqual({
      ok: true,
      creditBalance: 7,
      waiverNeedsSignature: false,
      bookedSessionIds: ["s1", "s2"],
    });
  });

  it("401 → unauthenticated (send to Identify)", () => {
    expect(toAccountLoad(httpErr(401))).toEqual({ ok: false, unauthenticated: true });
  });

  it("any other failure → not unauthenticated (a retryable account error)", () => {
    expect(toAccountLoad(httpErr(500))).toEqual({ ok: false, unauthenticated: false });
    const net: MemberResult<MemberAccount> = {
      ok: false,
      error: new MemberApiError("network_error", "offline"),
    };
    expect(toAccountLoad(net)).toEqual({ ok: false, unauthenticated: false });
  });
});

describe("toWaitlistOutcome", () => {
  it("ok → the FIFO position", () => {
    const res: MemberResult<{ position: number }> = { ok: true, value: { position: 5 }, meta: META };
    expect(toWaitlistOutcome(res)).toEqual({ ok: true, position: 5 });
  });

  it("failure → ok:false", () => {
    expect(toWaitlistOutcome(httpErr(500))).toEqual({ ok: false });
  });
});
