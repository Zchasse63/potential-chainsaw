import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for the AUTHORITY MATRIX (migration 0042) — ALWAYS through the
 * user-scoped client (RLS enforced, invariant #7). The matrix READ is an ordinary
 * member SELECT over the SECURITY INVOKER view public.current_authority (RLS
 * scopes it to the caller's tenants); the flip is a definer Postgres RPC that
 * re-checks OWNER role in-body and APPENDS to the authority_flips ledger. There is
 * NO client write path to authority_flips — the RPC is the authority. Every result
 * is Zod-validated at the boundary; a shape mismatch is a server defect.
 *
 * The RPC raises typed SQLSTATEs; this layer maps them onto the ApiError contract:
 *   42501                 → 403 authority_forbidden   (role/actor)
 *   22023                 → 422 authority_invalid      (domain/authority/reason/key)
 *   P0002 (no_data_found) → 404 authority_target_not_found
 *   23505 (unique_viol)   → 409 idempotency_key_conflict
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
interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
}

function parseInternal<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label}: unexpected DB row shape (${parsed.error.message})`);
  return parsed.data;
}

function mapRpcError(error: QueryError, label: string): ApiError {
  const message = error.message ?? "";
  switch (error.code) {
    case "42501":
      return new ApiError(403, "authority_forbidden", "database authorization denied the operation");
    case "22023":
      return new ApiError(422, "authority_invalid", message);
    case "P0002":
      return new ApiError(404, "authority_target_not_found", message);
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

// -- the closed domain set + stable ordering ----------------------------------

/** The CLOSED set of capability domains (matches the 0042 check constraint). */
export const AUTHORITY_DOMAINS = [
  "people",
  "bookings",
  "schedule",
  "memberships",
  "payments",
  "comms",
  "waivers",
  "retail",
] as const;
export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number];

const DOMAIN_ORDER = new Map(AUTHORITY_DOMAINS.map((d, i) => [d, i]));

// -- the matrix read ----------------------------------------------------------

const matrixRowSchema = z.object({
  domain: z.enum(AUTHORITY_DOMAINS),
  authority: z.enum(["glofox", "kelo"]),
  flipped_at: z.string().min(1).nullable(),
  reason: z.string().nullable(),
});
export type AuthorityMatrixRow = z.infer<typeof matrixRowSchema>;

/**
 * The full authority matrix for a tenant — all eight domains, each defaulting to
 * 'glofox' when un-flipped (the view generates the defaults). RLS on the invoker
 * view scopes the read; the explicit tenant filter is the structural backstop.
 * Rows are returned in the closed-set order so the surface renders stably.
 */
export async function fetchAuthorityMatrix(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<AuthorityMatrixRow[]> {
  const builder = (client as unknown as { from(table: string): TableBuilder })
    .from("current_authority")
    .select("domain, authority, flipped_at, reason")
    .eq("tenant_id", tenantId);
  const { data, error } = await builder;
  if (error !== null) throw new Error(`fetchAuthorityMatrix failed: ${error.message}`);
  const rows = parseInternal(z.array(matrixRowSchema), data ?? [], "fetchAuthorityMatrix");
  return [...rows].sort(
    (a, b) => (DOMAIN_ORDER.get(a.domain) ?? 0) - (DOMAIN_ORDER.get(b.domain) ?? 0),
  );
}

// -- the flip -----------------------------------------------------------------

export interface FlipArgs {
  tenantId: string;
  domain: string;
  authority: string;
  reason: string;
  evidenceUrl: string | null;
  actorId: string;
  idempotencyKey: string;
}

/** app.flip_authority returns the flip id (uuid); idempotent on the key. */
export async function flipAuthority(client: KeloSupabaseClient, args: FlipArgs): Promise<string> {
  return callRpc(
    client,
    "flip_authority",
    {
      p_tenant: args.tenantId,
      p_domain: args.domain,
      p_authority: args.authority,
      p_reason: args.reason,
      p_actor: args.actorId,
      p_idempotency_key: args.idempotencyKey,
      p_evidence_url: args.evidenceUrl,
    },
    z.string().uuid(),
    "flipAuthority",
  );
}
