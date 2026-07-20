import type { Booking, MemberApiError, MemberResult } from "@kelo/member-core";
import type { MemberAccount } from "@kelo/contracts";
import type {
  AccountLoad,
  BookFailureReason,
  BookOutcome,
  WaitlistOutcome,
} from "../components/booking-panel.jsx";

/**
 * Pure adapters from member-core results → the BookingPanel's outcome types.
 * Extracted from the route so the CRITICAL status/code → behavior mapping is
 * unit-testable without React or the TanStack Start server (the route just
 * pipes member-core calls through these). No DOM, no network, no side effects.
 *
 * The book mapping branches on the API's structured `error.code` (not a bare
 * status), because one status carries several conditions — 409 is both the
 * capacity ceiling (session_at_capacity → the honest waitlist) AND an
 * idempotency-key conflict (idempotency_key_conflict → a safe same-key retry).
 * Codes are the authoritative contract in apps/api/src/data-bookings.ts.
 */

export function toAccountLoad(res: MemberResult<MemberAccount>): AccountLoad {
  if (res.ok) {
    return {
      ok: true,
      creditBalance: res.value.credit_balance,
      waiverNeedsSignature: res.value.waiver.needs_signature,
      // The API returns ONLY live (booked/checked_in) bookings for this member.
      bookedSessionIds: res.value.bookings.map((b) => b.session_id),
    };
  }
  // 401 ⇒ no live session ⇒ the member must Identify first.
  const unauthenticated = res.error.kind === "http_error" && res.error.status === 401;
  return { ok: false, unauthenticated };
}

export function toBookOutcome(res: MemberResult<Booking>): BookOutcome {
  if (res.ok) return { ok: true };
  return { ok: false, reason: bookFailureReason(res.error) };
}

export function toWaitlistOutcome(res: MemberResult<{ position: number }>): WaitlistOutcome {
  return res.ok ? { ok: true, position: res.value.position } : { ok: false };
}

function bookFailureReason(error: MemberApiError): BookFailureReason {
  // Non-HTTP failures (network/shape/envelope) are transient/opaque → retry.
  if (error.kind !== "http_error") return "retry";
  switch (error.code) {
    case "session_at_capacity": // 409 — the no-oversell ceiling: the seat filled.
      return "race";
    case "insufficient_credits": // 422 — balance dropped below cost.
      return "no_credits";
    case "booking_waiver_required": // 403 — unsigned waiver blocks booking.
      return "waiver";
    case "booking_invalid": // 422 — session unpublished/started/not-ready.
    case "booking_target_not_found": // 404 — the session/hold is gone.
      return "unavailable";
    // idempotency_key_conflict (409), booking_forbidden (403), and anything
    // unmapped fall here: a same-key retry replays idempotently, so it's safe.
    default:
      return "retry";
  }
}
