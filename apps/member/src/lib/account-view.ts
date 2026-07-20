import type { MemberAccount } from "@kelo/contracts";
import type { MemberResult } from "@kelo/member-core";

/**
 * Pure adapter: member-core account result + the public schedule → the read-only
 * account view (plan-member-app §6, "read-only account area"). Session start
 * times/names are NOT in the account payload by design (it carries no other
 * attendee's session data) — they're resolved here by joining the member's
 * bookings against the public schedule the route already SSR-loaded.
 *
 * No DOM, no network, no side effects → unit-testable in isolation.
 */

export interface SessionMeta {
  offering_name: string;
  starts_at: string;
  ends_at: string;
}

export interface AccountBookingRow {
  bookingId: string;
  sessionId: string;
  status: string;
  /** Offering name if the session is in the loaded window; a neutral fallback otherwise. */
  title: string;
  /** Formatted time range, or null when the session is outside the loaded window. */
  when: string | null;
  /** For deterministic ordering; null (→ sorts last) when unknown. */
  startsAt: string | null;
}

export type AccountView =
  | {
      ok: true;
      creditBalance: number;
      waiverNeedsSignature: boolean;
      bookings: AccountBookingRow[];
    }
  | { ok: false; unauthenticated: boolean };

export function toAccountView(
  res: MemberResult<MemberAccount>,
  sessionMeta: Record<string, SessionMeta>,
  formatWhen: (startsAt: string, endsAt: string) => string,
): AccountView {
  if (!res.ok) {
    // 401 ⇒ no live session ⇒ the member must Identify first.
    const unauthenticated = res.error.kind === "http_error" && res.error.status === 401;
    return { ok: false, unauthenticated };
  }

  const bookings: AccountBookingRow[] = res.value.bookings.map((b) => {
    const meta = sessionMeta[b.session_id];
    return {
      bookingId: b.booking_id,
      sessionId: b.session_id,
      status: b.status,
      title: meta?.offering_name ?? "Booked session",
      when: meta !== undefined ? formatWhen(meta.starts_at, meta.ends_at) : null,
      startsAt: meta?.starts_at ?? null,
    };
  });

  // Soonest first; sessions outside the loaded window (unknown start) sort last.
  bookings.sort((a, b) => {
    if (a.startsAt === null && b.startsAt === null) return 0;
    if (a.startsAt === null) return 1;
    if (b.startsAt === null) return -1;
    return a.startsAt.localeCompare(b.startsAt);
  });

  return {
    ok: true,
    creditBalance: res.value.credit_balance,
    waiverNeedsSignature: res.value.waiver.needs_signature,
    bookings,
  };
}
