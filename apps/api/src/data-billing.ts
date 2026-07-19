import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";

/**
 * Billing data layer (migration 0033). This unit ships ONLY the request-level
 * idempotency persistence the mutation middleware needs — the money read/write
 * surface (plans, prices, payments) lands with the routes that use it in a
 * later Phase 5 unit, per invariant #9 (schema ships with its feature; no
 * speculative dead code).
 *
 * idempotency_keys is written by the SERVICE role (RLS member-SELECT; service
 * writes). The middleware threads a service client in; every call still filters
 * tenant explicitly — the tenant comes from resolveTenant, never the body.
 */

interface QueryError {
  message: string;
  code?: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

/** The exact PostgREST builder surface the idempotency helpers use. */
interface BillingBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): BillingBuilder;
  insert(values: unknown): BillingBuilder;
  update(values: unknown): BillingBuilder;
  delete(): BillingBuilder;
  eq(column: string, value: unknown): BillingBuilder;
  is(column: string, value: unknown): BillingBuilder;
  limit(count: number): BillingBuilder;
}

function from(client: KeloSupabaseClient, table: string): BillingBuilder {
  return client.from(table) as unknown as BillingBuilder;
}

const idempotencyRowSchema = z.object({
  request_hash: z.string(),
  response_status: z.number().int().nullable(),
  response_body: z.unknown().nullable(),
});

export interface IdempotencyArgs {
  tenantId: string;
  key: string;
}

export type IdempotencyReservation =
  | { outcome: "fresh" }
  | { outcome: "conflict" }
  | { outcome: "in_progress" }
  | { outcome: "replay"; status: number; body: unknown };

/**
 * RESERVE-then-execute (the crash-safe shape). Atomically INSERT the reservation
 * row (response null) BEFORE the handler runs, so exactly one concurrent request
 * wins the (tenant_id, key) unique index:
 *   - insert succeeds        → `fresh`: this caller executes once.
 *   - unique violation, and the existing row has …
 *       a DIFFERENT request_hash                 → `conflict` (→ 409).
 *       the same hash but no stored response yet → `in_progress` (→ 409).
 *       the same hash and a stored response      → `replay` (return it verbatim).
 */
export async function reserveIdempotencyKey(
  client: KeloSupabaseClient,
  args: IdempotencyArgs & { requestHash: string },
): Promise<IdempotencyReservation> {
  const { error } = await from(client, "idempotency_keys").insert({
    tenant_id: args.tenantId,
    key: args.key,
    request_hash: args.requestHash,
  });
  if (error === null) return { outcome: "fresh" };
  if (error.code !== "23505") {
    throw new Error(`reserveIdempotencyKey insert failed: ${error.message}`);
  }
  // The (tenant_id, key) row already exists — read it to decide replay vs 409.
  const { data: existingData, error: selectError } = await from(client, "idempotency_keys")
    .select("request_hash, response_status, response_body")
    .eq("tenant_id", args.tenantId)
    .eq("key", args.key)
    .limit(1);
  if (selectError !== null) {
    throw new Error(`reserveIdempotencyKey lookup failed: ${selectError.message}`);
  }
  const existing = z.array(idempotencyRowSchema).parse(existingData ?? [])[0];
  if (existing === undefined) {
    // Reservation vanished between the failed insert and this read (a concurrent
    // release). Never double-execute a money mutation: report in_progress; the
    // retry re-reserves cleanly.
    return { outcome: "in_progress" };
  }
  if (existing.request_hash !== args.requestHash) return { outcome: "conflict" };
  if (existing.response_status === null) return { outcome: "in_progress" };
  return { outcome: "replay", status: existing.response_status, body: existing.response_body };
}

/** Persist the completed response under the reservation for later replay. */
export async function storeIdempotentResponse(
  client: KeloSupabaseClient,
  args: IdempotencyArgs & { status: number; body: unknown },
): Promise<void> {
  const { error } = await from(client, "idempotency_keys")
    .update({ response_status: args.status, response_body: args.body })
    .eq("tenant_id", args.tenantId)
    .eq("key", args.key);
  if (error !== null) {
    throw new Error(`storeIdempotentResponse failed: ${error.message}`);
  }
}

/**
 * Release a reservation whose request did NOT durably complete (handler threw,
 * or a 5xx) so a legitimate retry can proceed. Guarded by `response_status is
 * null` so it can never delete an already-stored (completed) record in a race.
 */
export async function releaseIdempotencyKey(
  client: KeloSupabaseClient,
  args: IdempotencyArgs,
): Promise<void> {
  const { error } = await from(client, "idempotency_keys")
    .delete()
    .eq("tenant_id", args.tenantId)
    .eq("key", args.key)
    .is("response_status", null);
  if (error !== null) {
    throw new Error(`releaseIdempotencyKey failed: ${error.message}`);
  }
}
