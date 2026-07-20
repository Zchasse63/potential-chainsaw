import {
  memberAccountSchema,
  memberBookResponse,
  memberCancelResponse,
  memberHoldResponse,
  memberLogoutResponse,
  memberWaitlistResponse,
  type EnvelopeMeta,
  type MemberAccount,
  type MemberPlatform,
} from "@kelo/contracts";
import type { FetchImpl } from "./client.js";
import { MemberApiError } from "./errors.js";
import { memberRequest } from "./http.js";

// A minimal structural mirror of the zod schema surface member-core relies on
// (safeParse) — member-core stays zod-free (it consumes contract schemas).
interface ParseLike<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: ParseError };
}
interface ParseError {
  issues: { message: string }[];
}

/**
 * The session-scoped member booking client (units 8.3a/8.3b) — the SAME code
 * web and mobile call. The API scopes every action to the session's person;
 * this module only transports intent + the money-mutation idempotency key.
 */

interface SessionCall {
  origin: string;
  /** Mobile session token; omit on web (the cookie carries it). */
  token?: string;
  fetchImpl?: FetchImpl;
}
interface BookingCall extends SessionCall {
  /** booked_via channel label (not a security boundary). */
  platform?: MemberPlatform;
}
interface MutationCall extends BookingCall {
  /** Per-intent Idempotency-Key — rotate whenever the submission content changes. */
  idempotencyKey: string;
}

export interface Hold {
  id: string;
  expires_at: string | null;
  frozen: boolean;
}
export interface Booking {
  booking_id: string;
  replayed?: boolean;
}
export interface Cancellation {
  booking_id: string;
  status: string;
  branch: "refund" | "forfeit" | null;
  refunded: boolean;
}

export type MemberResult<T> =
  | { ok: true; value: T; meta: EnvelopeMeta }
  | { ok: false; error: MemberApiError };

function validated<P, T>(
  outcome: Awaited<ReturnType<typeof memberRequest>>,
  schema: ParseLike<P>,
  pick: (parsed: P) => T,
  label: string,
): MemberResult<T> {
  if (!outcome.ok) return outcome;
  const parsed = schema.safeParse(outcome.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "shape_invalid",
        `${label} response failed the contract: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }
  return { ok: true, value: pick(parsed.data), meta: outcome.meta };
}

/** POST /member/holds — reserve a seat (the API caps live holds at 2/member). */
export async function holdSeat(
  params: BookingCall & { sessionId: string },
  clientFetch?: FetchImpl,
): Promise<MemberResult<Hold>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/holds",
      method: "POST",
      body: { session_id: params.sessionId, platform: params.platform ?? "web" },
      token: params.token,
      fetchImpl: params.fetchImpl,
      label: "hold",
    },
    clientFetch,
  );
  return validated(out, memberHoldResponse, (d) => d.hold, "hold");
}

/** POST /member/bookings — book (debits one credit; Idempotency-Key required). */
export async function bookSeat(
  params: MutationCall & { sessionId: string; holdId?: string | null },
  clientFetch?: FetchImpl,
): Promise<MemberResult<Booking>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/bookings",
      method: "POST",
      body: {
        session_id: params.sessionId,
        platform: params.platform ?? "web",
        ...(params.holdId != null ? { hold_id: params.holdId } : {}),
      },
      token: params.token,
      idempotencyKey: params.idempotencyKey,
      fetchImpl: params.fetchImpl,
      label: "book",
    },
    clientFetch,
  );
  return validated(out, memberBookResponse, (d) => d.booking, "book");
}

/** POST /member/bookings/:id/cancel — 12h refund-vs-forfeit (the API enforces
 * ownership + policy). */
export async function cancelBooking(
  params: MutationCall & { bookingId: string },
  clientFetch?: FetchImpl,
): Promise<MemberResult<Cancellation>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: `/api/v1/member/bookings/${encodeURIComponent(params.bookingId)}/cancel`,
      method: "POST",
      body: { platform: params.platform ?? "web" },
      token: params.token,
      idempotencyKey: params.idempotencyKey,
      fetchImpl: params.fetchImpl,
      label: "cancel",
    },
    clientFetch,
  );
  return validated(out, memberCancelResponse, (d) => d.cancellation, "cancel");
}

/** POST /member/waitlist — join a full session's waitlist (FIFO position). */
export async function joinWaitlist(
  params: MutationCall & { sessionId: string },
  clientFetch?: FetchImpl,
): Promise<MemberResult<{ position: number }>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/waitlist",
      method: "POST",
      body: { session_id: params.sessionId, platform: params.platform ?? "web" },
      token: params.token,
      idempotencyKey: params.idempotencyKey,
      fetchImpl: params.fetchImpl,
      label: "waitlist",
    },
    clientFetch,
  );
  return validated(out, memberWaitlistResponse, (d) => d.waitlist, "waitlist");
}

/** POST /member/auth/logout — revoke THIS session (the API also clears the web
 * cookie). Idempotent; not a money mutation, so no idempotency key. */
export async function logoutMember(
  params: SessionCall,
  clientFetch?: FetchImpl,
): Promise<MemberResult<{ revoked: boolean }>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/auth/logout",
      method: "POST",
      token: params.token,
      fetchImpl: params.fetchImpl,
      label: "logout",
    },
    clientFetch,
  );
  return validated(out, memberLogoutResponse, (d) => d, "logout");
}

/** GET /member/account — live credit balance, waiver status, active bookings. */
export async function fetchAccount(
  params: SessionCall,
  clientFetch?: FetchImpl,
): Promise<MemberResult<MemberAccount>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/account",
      method: "GET",
      token: params.token,
      fetchImpl: params.fetchImpl,
      label: "account",
    },
    clientFetch,
  );
  return validated(out, memberAccountSchema, (d) => d, "account");
}
