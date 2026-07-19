import { fetchEnvelope, postEnvelope } from "./api.js";
import { inspectEnvelope } from "./envelope.js";

/**
 * The booking + front-desk client (Phase 6 · unit 6.3). The exact shapes here
 * MIRROR the live API contracts owned by units 6.1/6.2
 * (apps/api/src/routes/bookings.ts + waitlist.ts, assembled from
 * apps/api/src/data-bookings.ts + data-booking.ts, migrations 0040/0041); a
 * drift against those is a one-file change and the screens stay presentational.
 *
 * INVARIANTS (CLAUDE.md #5, plan-ux §3C):
 *  - NO optimistic UI for bookings. Every result is reflected ONLY from the
 *    server-confirmed envelope; a hold/booking the server did not confirm is
 *    never shown.
 *  - PER-INTENT idempotency keys that ROTATE whenever submission content
 *    changes (the 5.8 double-charge lesson). `book_session` debits the
 *    append-only credit ledger keyed on the client Idempotency-Key, so a
 *    retried booking with the SAME key replays instead of debiting twice, and a
 *    CHANGED intent (different person/session/use_credit) must mint a NEW key or
 *    it would 409 against the server request-hash. See rotateIntentKey below.
 *  - Reads flow through DataBoundary (provenance-or-nothing); this module only
 *    unwraps the confirmed data for mutation responses (mirroring lib/pos.ts).
 *
 * CONTRACT NOTE — booking tender. The live `book_session` body is
 * { session_id, person_id, hold_id?, use_credit? } and takes NO payment
 * parameter. The honest tenders this contract supports are a CREDIT debit
 * (use_credit=true) and a NO-CHARGE/comp booking (use_credit=false). A paid
 * drop-in (cash / card-on-terminal) has no linkage in book_session — it is sold
 * at POS first, then booked as a comp — so it is deferred here rather than
 * faked (a "Charge and book" button that took no money would violate the
 * money-honesty invariant). See BookScreen's tender section.
 */

// -- shapes mirrored from the API Zod boundary --------------------------------

/** GET /sessions/availability row (data-bookings.ts availabilityRowSchema). */
export interface AvailabilityRow {
  session_id: string;
  starts_at: string;
  capacity: number;
  booked: number;
  held: number;
  available: number;
  readiness_ok: boolean;
}
export interface AvailabilityData {
  sessions: AvailabilityRow[];
}

/** POST /bookings/hold → { hold: { id, expires_at, frozen } } (F4). The route
 *  reads the persisted hold back with the SAME user client after the RPC, so the
 *  desk anchors its countdown on the SERVER's expires_at instead of guessing
 *  from the response instant. `expires_at` may be null if the read came back
 *  empty, in which case the client anchor is the documented fallback; the server
 *  sweep + book-time validation remain the real authority (see BookScreen). */
export interface Hold {
  id: string;
  expires_at: string | null;
  frozen: boolean;
}

/** POST /bookings → { booking: BookResult } (data-bookings.ts bookResultSchema). */
export interface BookResult {
  booking_id: string;
  credit_entry_id?: string | null;
  replayed?: boolean;
}

/** GET /sessions/:id/roster → { roster } (data-booking.ts fetchRoster). */
export interface RosterPerson {
  first_name: string | null;
}
export interface RosterBooking {
  id: string;
  person_id: string | null;
  status: string;
  checked_in_at: string | null;
  people: RosterPerson | null;
}
export interface RosterWaitlistEntry {
  id: string;
  person_id: string;
  position: number;
  status: string;
  offer_expires_at: string | null;
  people: RosterPerson | null;
}
export interface Roster {
  bookings: RosterBooking[];
  waitlist: RosterWaitlistEntry[];
}
export interface RosterData {
  roster: Roster;
}

/** POST /waitlist/join → { waitlist: { position } }. */
export interface WaitlistJoinResult {
  position: number;
}

/** POST /bookings/:id/check-in → { check_in: { status } }. */
export interface CheckInResult {
  status: "checked_in";
}

export interface HoldInput {
  session_id: string;
  person_id: string;
  ttl_seconds?: number;
}
export interface BookInput {
  session_id: string;
  person_id: string;
  hold_id?: string | null;
  use_credit: boolean;
}
export interface JoinWaitlistInput {
  session_id: string;
  person_id: string;
}

// -- per-intent idempotency key rotation --------------------------------------

/**
 * The one lesson the 5.8 double-charge taught: a client idempotency key is
 * PER INTENT, not per session. `signature` fingerprints everything that will be
 * submitted; while it is unchanged, every retry REUSES the same key so a
 * timeout-after-commit + retry replays the ledger debit instead of writing a
 * second one. The moment the content changes (different person, session, or
 * use_credit), the signature changes and a NEW key is minted — reusing the old
 * key for different content would 409 against the server's request-hash check
 * and lock the desk out of the booking.
 */
export interface IntentKey {
  signature: string;
  key: string;
}

export function rotateIntentKey(
  previous: IntentKey | null,
  signature: string,
  mint: () => string = () => crypto.randomUUID(),
): IntentKey {
  // Same intent (unchanged content) → same key: a retry must replay, never
  // ring a second debit.
  if (previous !== null && previous.signature === signature) {
    return previous;
  }
  // Content changed (or first submit) → a fresh key for the new intent.
  return { signature, key: mint() };
}

/** Build the booking intent signature — the exact tuple the server hashes a
 *  request against. Any change here rotates the key. */
export function bookIntentSignature(input: BookInput): string {
  return [input.person_id, input.session_id, input.hold_id ?? "no-hold", String(input.use_credit)].join(
    "|",
  );
}

// -- unwrap helper (mirrors lib/pos.ts checkout) ------------------------------

/** Unwrap a mutation envelope's nested field, refusing anything without a
 *  valid provenance record (never fabricate a confirmed result). */
function confirmed<T>(response: unknown, field: string, what: string): T {
  const inspection = inspectEnvelope<Record<string, T>>(response);
  if (!inspection.ok) {
    throw new Error(`The ${what} response was missing its provenance record; nothing is shown.`);
  }
  const value = inspection.data[field];
  if (value === undefined) {
    throw new Error(`The ${what} response was malformed; nothing is shown.`);
  }
  return value;
}

// -- reads (feed DataBoundary; return the raw envelope) -----------------------

/** GET /sessions/availability?from&to — the slot picker source. */
export async function fetchAvailability(
  accessToken: string,
  from: string,
  to: string,
): Promise<unknown> {
  return fetchEnvelope(
    `/sessions/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken,
  );
}

/** GET /sessions/:id/roster — bookings + ordered waitlist for the desk. */
export async function fetchRoster(accessToken: string, sessionId: string): Promise<unknown> {
  return fetchEnvelope(`/sessions/${encodeURIComponent(sessionId)}/roster`, accessToken);
}

// -- mutations (server-confirmed; explicit per-intent keys) -------------------

/**
 * POST /bookings/hold — reserve a seat. Self-idempotent server-side (one-live-
 * hold upsert), so a fresh random key per attempt is acceptable; the reserved
 * hold is reflected only from this confirmed response. Returns
 * { id, expires_at, frozen } — the server-authoritative expiry the desk
 * countdown anchors on (F4).
 */
export async function holdSession(accessToken: string, input: HoldInput): Promise<Hold> {
  const response = await postEnvelope("/bookings/hold", accessToken, input);
  return confirmed<Hold>(response, "hold", "hold");
}

/** POST /bookings/:id/freeze-hold — stop the sweep while tender is mid-flight
 *  (plan-ux §3C hold choreography). Self-idempotent; a random key is fine. */
export async function freezeHold(accessToken: string, holdId: string): Promise<void> {
  await postEnvelope(`/bookings/${encodeURIComponent(holdId)}/freeze-hold`, accessToken, {});
}

/** POST /bookings/:id/release-hold — operator remediation on abandon/back;
 *  deletes the hold regardless of frozen so a walked-away tender frees the seat. */
export async function releaseHold(accessToken: string, holdId: string): Promise<void> {
  await postEnvelope(`/bookings/${encodeURIComponent(holdId)}/release-hold`, accessToken, {});
}

/**
 * POST /bookings — the durable booking. `idempotencyKey` is the ONE key for
 * this booking intent (rotateIntentKey), reused across retries so a
 * timeout-after-commit + retry replays rather than double-debiting a credit.
 * Returns the server-confirmed { booking_id, credit_entry_id?, replayed? }.
 */
export async function bookSession(
  accessToken: string,
  input: BookInput,
  idempotencyKey: string,
): Promise<BookResult> {
  const response = await postEnvelope("/bookings", accessToken, input, undefined, idempotencyKey);
  return confirmed<BookResult>(response, "booking", "booking");
}

/** POST /waitlist/join — enqueue a person on a FULL session; returns position.
 *  Persisted-idempotent server-side; pass a per-intent key. */
export async function joinWaitlist(
  accessToken: string,
  input: JoinWaitlistInput,
  idempotencyKey: string,
): Promise<WaitlistJoinResult> {
  const response = await postEnvelope("/waitlist/join", accessToken, input, undefined, idempotencyKey);
  return confirmed<WaitlistJoinResult>(response, "waitlist", "waitlist");
}

/** POST /waitlist/:id/accept — claim an offer (books through book_session). */
export async function acceptWaitlistOffer(
  accessToken: string,
  entryId: string,
  idempotencyKey: string,
): Promise<BookResult> {
  const response = await postEnvelope(
    `/waitlist/${encodeURIComponent(entryId)}/accept`,
    accessToken,
    {},
    undefined,
    idempotencyKey,
  );
  return confirmed<BookResult>(response, "booking", "waitlist accept");
}

/** POST /waitlist/:id/decline — release the offer; cascades to the next waiter. */
export async function declineWaitlistOffer(
  accessToken: string,
  entryId: string,
  idempotencyKey: string,
): Promise<void> {
  await postEnvelope(
    `/waitlist/${encodeURIComponent(entryId)}/decline`,
    accessToken,
    {},
    undefined,
    idempotencyKey,
  );
}

/**
 * POST /bookings/:id/check-in — desk check-in. `idempotencyKey` is stable per
 * booking so the DEGRADED-mode queue can replay it safely: a re-check-in of an
 * already-checked-in booking no-ops server-side.
 */
export async function checkIn(
  accessToken: string,
  bookingId: string,
  idempotencyKey: string,
): Promise<CheckInResult> {
  const response = await postEnvelope(
    `/bookings/${encodeURIComponent(bookingId)}/check-in`,
    accessToken,
    {},
    undefined,
    idempotencyKey,
  );
  return confirmed<CheckInResult>(response, "check_in", "check-in");
}
