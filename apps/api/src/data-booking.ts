import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for the booking desk surface (phase 6 · unit 6.2: waitlist,
 * check-in, roster) — ALWAYS through the user-scoped client (RLS enforced,
 * invariant #7). Every mutation is a definer RPC (app.join_waitlist /
 * app.accept_waitlist_offer / app.decline_waitlist_offer / app.check_in) that
 * re-checks tenancy + role in-body and threads an idempotency key; there is NO
 * client write path to bookings/booking_holds/waitlist_entries. Reads are
 * ordinary member SELECTs. Every result is Zod-validated at the boundary.
 *
 * The RPCs RAISE typed SQLSTATEs; this layer maps them onto ApiError:
 *   42501 (insufficient_privilege) → 403   role/actor re-check refused
 *   22023 (invalid_parameter_value)→ 422   full/open/window/offer-state violation
 *   P0002 (no_data_found)          → 404   session / entry / booking / person absent
 *   23505 (unique_violation)       → 409   idempotency-key reuse for another op
 */

interface QueryError {
  message: string;
  code?: string;
}
interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  in(column: string, values: readonly unknown[]): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

async function run(query: PromiseLike<QueryResult>, label: string): Promise<unknown> {
  const { data, error } = await query;
  if (error !== null) throw new Error(`${label} query failed: ${error.message}`);
  return data;
}

function parseInternal<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  return parsed.data;
}

async function rows<S extends z.ZodTypeAny>(
  query: TableBuilder,
  schema: S,
  label: string,
): Promise<z.output<S>[]> {
  const data = await run(query, label);
  return parseInternal(z.array(schema), data ?? [], label);
}

const uuid = z.string().uuid();
const timestamp = z.string().min(1);

/** Map a raised RPC SQLSTATE onto the structured error contract. */
function mapRpcError(error: QueryError, label: string): ApiError {
  switch (error.code) {
    case "42501":
      return new ApiError(403, "booking_forbidden", "database authorization denied the operation");
    case "22023":
      return new ApiError(422, "booking_invalid", error.message);
    case "P0002":
      return new ApiError(404, "booking_target_not_found", error.message);
    case "23505":
      return new ApiError(409, "idempotency_key_conflict", error.message);
    default:
      throw new Error(`${label} RPC failed: ${error.message}`);
  }
}

async function callRpc(
  client: KeloSupabaseClient,
  name: string,
  params: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const { data, error } = await (client as unknown as RpcClient).rpc(name, params);
  if (error !== null) throw mapRpcError(error, label);
  return data;
}

// -- waitlist: join ----------------------------------------------------------

export interface JoinWaitlistArgs {
  tenantId: string;
  actorId: string;
  sessionId: string;
  personId: string;
  idempotencyKey: string;
}

const positionResult = z.object({ position: z.number().int().positive() });
export type JoinWaitlistResult = z.infer<typeof positionResult>;

/** Enqueue a person on a FULL session's waitlist; returns the FIFO position. */
export async function joinWaitlist(
  client: KeloSupabaseClient,
  args: JoinWaitlistArgs,
): Promise<JoinWaitlistResult> {
  const data = await callRpc(
    client,
    "join_waitlist",
    {
      p_tenant: args.tenantId,
      p_session: args.sessionId,
      p_person: args.personId,
      p_actor: args.actorId,
      p_idempotency_key: args.idempotencyKey,
    },
    "joinWaitlist",
  );
  return parseInternal(positionResult, { position: data }, "joinWaitlist");
}

// -- waitlist: accept an offer -----------------------------------------------

export interface AcceptOfferArgs {
  tenantId: string;
  actorId: string;
  entryId: string;
  idempotencyKey: string;
  via: string;
}

const acceptResult = z.object({ booking_id: uuid });
export type AcceptOfferResult = z.infer<typeof acceptResult>;

/** Claim a waitlist offer — books through app.book_session (waiver enforced). */
export async function acceptWaitlistOffer(
  client: KeloSupabaseClient,
  args: AcceptOfferArgs,
): Promise<AcceptOfferResult> {
  const data = await callRpc(
    client,
    "accept_waitlist_offer",
    {
      p_tenant: args.tenantId,
      p_entry: args.entryId,
      p_actor: args.actorId,
      p_idempotency_key: args.idempotencyKey,
      p_via: args.via,
    },
    "acceptWaitlistOffer",
  );
  return parseInternal(acceptResult, { booking_id: data }, "acceptWaitlistOffer");
}

// -- waitlist: decline an offer ----------------------------------------------

export interface DeclineOfferArgs {
  tenantId: string;
  actorId: string;
  entryId: string;
}

/** Decline a waitlist offer — releases the hold and cascades to the next waiter. */
export async function declineWaitlistOffer(
  client: KeloSupabaseClient,
  args: DeclineOfferArgs,
): Promise<void> {
  await callRpc(
    client,
    "decline_waitlist_offer",
    { p_tenant: args.tenantId, p_entry: args.entryId, p_actor: args.actorId },
    "declineWaitlistOffer",
  );
}

// -- waitlist: honesty read (position) ---------------------------------------

export const waitlistPositionSchema = z.object({
  position: z.number().int().positive(),
  total_waiting: z.number().int().nonnegative(),
  offer_expires_at: timestamp.nullable(),
  status: z.enum(["waiting", "offered"]),
});
export type WaitlistPositionRow = z.infer<typeof waitlistPositionSchema>;

/** The member surface reads their true position + offer window (null if none). */
export async function fetchWaitlistPosition(
  client: KeloSupabaseClient,
  tenantId: string,
  sessionId: string,
  personId: string,
): Promise<WaitlistPositionRow | null> {
  const data = await callRpc(
    client,
    "waitlist_position",
    { p_tenant: tenantId, p_session: sessionId, p_person: personId },
    "fetchWaitlistPosition",
  );
  const list = parseInternal(z.array(waitlistPositionSchema), data ?? [], "fetchWaitlistPosition");
  return list[0] ?? null;
}

// -- check-in ----------------------------------------------------------------

export interface CheckInArgs {
  tenantId: string;
  actorId: string;
  bookingId: string;
  now: string;
}

const checkInResult = z.object({ status: z.literal("checked_in") });
export type CheckInResult = z.infer<typeof checkInResult>;

/** Desk check-in within the arrival window; idempotent re-check-in no-ops. */
export async function checkIn(
  client: KeloSupabaseClient,
  args: CheckInArgs,
): Promise<CheckInResult> {
  const data = await callRpc(
    client,
    "check_in",
    {
      p_tenant: args.tenantId,
      p_booking: args.bookingId,
      p_actor: args.actorId,
      p_now: args.now,
    },
    "checkIn",
  );
  return parseInternal(checkInResult, { status: data }, "checkIn");
}

// -- roster read (bookings + waitlist for the desk) --------------------------

const personName = z.object({ first_name: z.string().nullable() }).nullable();

export const rosterBookingSchema = z.object({
  id: uuid,
  person_id: uuid.nullable(),
  status: z.string(),
  checked_in_at: timestamp.nullable(),
  people: personName,
});
export type RosterBookingRow = z.infer<typeof rosterBookingSchema>;

export const rosterWaitlistSchema = z.object({
  id: uuid,
  person_id: uuid,
  position: z.number().int().positive(),
  status: z.string(),
  offer_expires_at: timestamp.nullable(),
  people: personName,
});
export type RosterWaitlistRow = z.infer<typeof rosterWaitlistSchema>;

export interface Roster {
  bookings: RosterBookingRow[];
  waitlist: RosterWaitlistRow[];
}

/**
 * The desk roster: the session's active bookings (booked/checked_in) + its live
 * waitlist (waiting/offered), names resolved under RLS. Read via the user client
 * so cross-tenant rows are structurally invisible.
 */
export async function fetchRoster(
  client: KeloSupabaseClient,
  tenantId: string,
  sessionId: string,
): Promise<Roster> {
  const bookings = await rows(
    from(client, "bookings")
      .select("id, person_id, status, checked_in_at, people(first_name)")
      .eq("tenant_id", tenantId)
      .eq("session_id", sessionId)
      .in("status", ["booked", "checked_in"])
      .order("checked_in_at", { ascending: true }),
    rosterBookingSchema,
    "fetchRoster.bookings",
  );
  const waitlist = await rows(
    from(client, "waitlist_entries")
      .select("id, person_id, position, status, offer_expires_at, people(first_name)")
      .eq("tenant_id", tenantId)
      .eq("session_id", sessionId)
      .in("status", ["waiting", "offered"])
      .order("position", { ascending: true }),
    rosterWaitlistSchema,
    "fetchRoster.waitlist",
  );
  return { bookings, waitlist };
}
