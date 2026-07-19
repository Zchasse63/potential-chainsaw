import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for the NATIVE booking engine (migration 0040) — ALWAYS through
 * the user-scoped client (RLS enforced, invariant #7). Every mutation is a
 * definer Postgres RPC (hold / freeze / book / cancel) that serializes on the
 * session row, enforces the waiver, and debits the append-only credit ledger.
 * There is NO client write path to bookings/booking_holds and NO optimistic
 * booking UI — the RPC is the authority. Reads (availability) are ordinary
 * member SELECT-via-invoker-function. Every result is Zod-validated at the
 * boundary; a shape mismatch is a server defect.
 *
 * The RPCs re-check tenancy/role in-body and RAISE typed SQLSTATEs; this layer
 * maps them onto the structured ApiError contract:
 *   42501 waiver_required        → 403 booking_waiver_required
 *   42501 (other)                → 403 booking_forbidden   (role/actor/hold owner)
 *   22023 insufficient_credits   → 422 insufficient_credits
 *   22023 (other)                → 422 booking_invalid     (published/started/ttl/…)
 *   23514 (capacity)             → 409 session_at_capacity (the no-oversell ceiling)
 *   P0002 (no_data_found)        → 404 booking_target_not_found
 *   23505 (unique_violation)     → 409 idempotency_key_conflict
 */

interface QueryError {
  message: string;
  code?: string;
}
interface QueryResult {
  data: unknown;
  error: QueryError | null;
}
interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

/** The minimal PostgREST read builder used for the server-authoritative hold
 *  read-back (F4). Cast the user client through it, mirroring data-booking.ts. */
interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  limit(count: number): TableBuilder;
}

function parseInternal<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  return parsed.data;
}

/** Map a raised RPC SQLSTATE onto the structured error contract. */
function mapRpcError(error: QueryError, label: string): ApiError {
  const message = error.message ?? "";
  switch (error.code) {
    case "42501":
      // The waiver enforcer raises 42501 with the literal 'waiver_required' so a
      // member surface can prompt signing; all other 42501s are role/actor/owner.
      if (message.includes("waiver_required")) {
        return new ApiError(403, "booking_waiver_required", "an active waiver signature is required before booking");
      }
      return new ApiError(403, "booking_forbidden", "database authorization denied the operation");
    case "22023":
      if (message.includes("insufficient_credits")) {
        return new ApiError(422, "insufficient_credits", "the member has no credit balance for this booking");
      }
      return new ApiError(422, "booking_invalid", message);
    case "23514":
      return new ApiError(409, "session_at_capacity", "the session is at capacity");
    case "P0002":
      return new ApiError(404, "booking_target_not_found", message);
    case "23505":
      return new ApiError(409, "idempotency_key_conflict", message);
    default:
      throw new Error(`${label} RPC failed: ${error.message}`);
  }
}

async function callRpc<S extends z.ZodTypeAny>(
  client: KeloSupabaseClient,
  name: string,
  params: Record<string, unknown>,
  schema: S,
  label: string,
): Promise<z.output<S>> {
  const { data, error } = await (client as unknown as RpcClient).rpc(name, params);
  if (error !== null) throw mapRpcError(error, label);
  return parseInternal(schema, data, label);
}

const uuid = z.string().uuid();
const timestamp = z.string().min(1);

// -- hold ---------------------------------------------------------------------

export interface HoldArgs {
  tenantId: string;
  sessionId: string;
  personId: string;
  actorId: string;
  ttlSeconds: number;
}

/** The server-authoritative hold the desk countdown anchors on (F4). */
export interface HoldRecord {
  id: string;
  expires_at: string | null;
  frozen: boolean;
}

const holdRowSchema = z.object({
  expires_at: timestamp.nullable(),
  frozen: z.boolean(),
});

/**
 * app.hold_session returns the bare hold id (uuid); its return type MUST NOT
 * change (0040 is applied live). To hand the client a server-authoritative
 * expiry instead of forcing a client-anchored countdown, we read the persisted
 * hold back with the SAME user client — same-tenant staff RLS allows the SELECT
 * (attack block 32 proves cross-tenant refusal). If the read-back is
 * unexpectedly empty the hold still exists, so we return null expiry and let the
 * client fall back to its own anchor rather than failing the reservation.
 */
export async function holdSession(client: KeloSupabaseClient, args: HoldArgs): Promise<HoldRecord> {
  const holdId = await callRpc(
    client,
    "hold_session",
    {
      p_tenant: args.tenantId,
      p_session: args.sessionId,
      p_person: args.personId,
      p_actor: args.actorId,
      p_ttl_seconds: args.ttlSeconds,
    },
    uuid,
    "holdSession",
  );
  const builder = (client as unknown as { from(table: string): TableBuilder })
    .from("booking_holds")
    .select("expires_at, frozen")
    .eq("id", holdId)
    .limit(1);
  const { data, error } = await builder;
  if (error !== null) throw new Error(`holdSession expiry read failed: ${error.message}`);
  const parsed = z.array(holdRowSchema).safeParse(data ?? []);
  const row = parsed.success ? parsed.data[0] : undefined;
  return {
    id: holdId,
    expires_at: row?.expires_at ?? null,
    frozen: row?.frozen ?? false,
  };
}

// -- freeze -------------------------------------------------------------------

/** app.freeze_hold returns void (null). */
export async function freezeHold(
  client: KeloSupabaseClient,
  args: { tenantId: string; holdId: string },
): Promise<void> {
  await callRpc(
    client,
    "freeze_hold",
    { p_tenant: args.tenantId, p_hold: args.holdId },
    z.unknown(),
    "freezeHold",
  );
}

// -- release (REVIEW FIX 6.1-crit-2) ------------------------------------------

/** app.release_hold deletes the hold REGARDLESS of frozen (operator remediation
 * for an abandoned tender). Returns whether a row was deleted. */
export async function releaseHold(
  client: KeloSupabaseClient,
  args: { tenantId: string; holdId: string; actorId: string },
): Promise<boolean> {
  return callRpc(
    client,
    "release_hold",
    { p_tenant: args.tenantId, p_hold: args.holdId, p_actor: args.actorId },
    z.boolean(),
    "releaseHold",
  );
}

// -- book ---------------------------------------------------------------------

export interface BookArgs {
  tenantId: string;
  personId: string;
  sessionId: string;
  actorId: string;
  idempotencyKey: string;
  via: "desk" | "member_web" | "member_ios" | "member_android" | "import";
  holdId?: string | null;
  useCredit: boolean;
}

export const bookResultSchema = z.object({
  booking_id: uuid,
  credit_entry_id: uuid.nullable().optional(),
  replayed: z.boolean().optional(),
});
export type BookResult = z.infer<typeof bookResultSchema>;

export async function bookSession(client: KeloSupabaseClient, args: BookArgs): Promise<BookResult> {
  return callRpc(
    client,
    "book_session",
    {
      p_tenant: args.tenantId,
      p_person: args.personId,
      p_session: args.sessionId,
      p_actor: args.actorId,
      p_idempotency_key: args.idempotencyKey,
      p_via: args.via,
      p_hold: args.holdId ?? null,
      p_use_credit: args.useCredit,
    },
    bookResultSchema,
    "bookSession",
  );
}

// -- cancel -------------------------------------------------------------------

export interface CancelArgs {
  tenantId: string;
  bookingId: string;
  actorId: string;
  idempotencyKey: string;
  now: string;
}

export const cancelResultSchema = z.object({
  booking_id: uuid,
  status: z.literal("cancelled"),
  branch: z.enum(["refund", "forfeit"]).nullable(),
  refunded: z.boolean(),
  credit_entry_id: uuid.nullable().optional(),
  replayed: z.boolean().optional(),
});
export type CancelResult = z.infer<typeof cancelResultSchema>;

export async function cancelBooking(client: KeloSupabaseClient, args: CancelArgs): Promise<CancelResult> {
  return callRpc(
    client,
    "cancel_booking",
    {
      p_tenant: args.tenantId,
      p_booking: args.bookingId,
      p_actor: args.actorId,
      p_idempotency_key: args.idempotencyKey,
      p_now: args.now,
    },
    cancelResultSchema,
    "cancelBooking",
  );
}

// -- availability read --------------------------------------------------------

export const availabilityRowSchema = z.object({
  session_id: uuid,
  starts_at: timestamp,
  capacity: z.number().int().nonnegative(),
  booked: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  readiness_ok: z.boolean(),
});
export type AvailabilityRow = z.infer<typeof availabilityRowSchema>;

/**
 * public.session_availability (SECURITY INVOKER): per published session in the
 * window, capacity vs active bookings + live holds. RLS scopes it to the
 * caller's tenant, so a foreign p_tenant yields zero rows.
 */
export async function fetchSessionAvailability(
  client: KeloSupabaseClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<AvailabilityRow[]> {
  return callRpc(
    client,
    "session_availability",
    { p_tenant: tenantId, p_from: from, p_to: to },
    z.array(availabilityRowSchema),
    "fetchSessionAvailability",
  );
}
