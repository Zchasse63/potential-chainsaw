import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Phase 4.3 — waiver engine data layer. The write path goes through the
 * migration-0028 SECURITY INVOKER wrappers (activate_waiver_version,
 * record_waiver_signature, current_waiver_status) so RLS + the in-body tenancy
 * checks both apply. waiver_signatures is append-only legal evidence; there is
 * no update/delete path here by construction.
 */

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  insert(values: unknown): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

function rpc(client: KeloSupabaseClient, name: string, params: Record<string, unknown>) {
  return (client as unknown as RpcClient).rpc(name, params);
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

export const waiverVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string().nullable(),
  body: z.string(),
  active: z.boolean(),
  effective_from: z.string(),
  created_at: z.string(),
});
export type WaiverVersionRow = z.infer<typeof waiverVersionSchema>;

export const waiverStatusSchema = z.object({
  has_current_signature: z.boolean(),
  signed_version: z.number().int().nullable(),
  active_version: z.number().int().nullable(),
  needs_signature: z.boolean(),
});
export type WaiverStatusRow = z.infer<typeof waiverStatusSchema>;

export async function listWaiverVersions(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<WaiverVersionRow[]> {
  const data = await run(
    from(client, "waiver_versions")
      .select("id, version, title, body, active, effective_from, created_at")
      .eq("tenant_id", tenantId)
      .order("version", { ascending: false }),
    "listWaiverVersions",
  );
  return parseInternal(z.array(waiverVersionSchema), data ?? [], "listWaiverVersions");
}

/** Next version number for a new draft (rare admin action; the unique
 * (tenant_id, version) constraint is the race backstop → a duplicate 409s). */
export async function nextWaiverVersion(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<number> {
  const data = await run(
    from(client, "waiver_versions")
      .select("version")
      .eq("tenant_id", tenantId)
      .order("version", { ascending: false })
      .limit(1),
    "nextWaiverVersion",
  );
  const rows = parseInternal(z.array(z.object({ version: z.number().int() })), data ?? [], "nextWaiverVersion");
  return (rows[0]?.version ?? 0) + 1;
}

/** New versions are created INACTIVE — publishing is an explicit activate
 * (the migration enforces one active version per tenant). */
export async function createWaiverVersion(
  client: KeloSupabaseClient,
  input: { tenant_id: string; version: number; title: string | null; body: string; created_by: string },
): Promise<WaiverVersionRow> {
  const data = await run(
    from(client, "waiver_versions")
      .insert({ ...input, active: false })
      .select("id, version, title, body, active, effective_from, created_at"),
    "createWaiverVersion",
  );
  const rows = parseInternal(z.array(waiverVersionSchema), data ?? [], "createWaiverVersion");
  if (rows[0] === undefined) throw new Error("createWaiverVersion returned no row");
  return rows[0];
}

export async function activateWaiverVersion(
  client: KeloSupabaseClient,
  params: { p_tenant: string; p_version_id: string; p_actor: string },
): Promise<boolean> {
  const data = await run(rpc(client, "activate_waiver_version", params), "activateWaiverVersion");
  return parseInternal(z.boolean(), data, "activateWaiverVersion");
}

export async function personWaiverStatus(
  client: KeloSupabaseClient,
  params: { p_tenant: string; p_person: string },
): Promise<WaiverStatusRow | null> {
  const data = await run(rpc(client, "current_waiver_status", params), "personWaiverStatus");
  const rows = parseInternal(z.array(waiverStatusSchema), data ?? [], "personWaiverStatus");
  return rows[0] ?? null;
}

/** The tenant's ACTIVE waiver version (the one a member must sign), or null if
 * the studio has published none. Unit 8.3i. */
export async function fetchActiveWaiverVersion(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<WaiverVersionRow | null> {
  const data = await run(
    from(client, "waiver_versions")
      .select("id, version, title, body, active, effective_from, created_at")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .limit(1),
    "fetchActiveWaiverVersion",
  );
  const rows = parseInternal(z.array(waiverVersionSchema), data ?? [], "fetchActiveWaiverVersion");
  return rows[0] ?? null;
}

/** Maps the member_portal RPC's SQLSTATEs onto structured errors (mirrors
 * data-bookings.ts's mapRpcError). Unlike the desk path, members WILL hit the
 * "active version changed between read and sign" race routinely, so it gets a
 * distinguishable 409 the client reloads on — never a bare 500. */
function mapMemberWaiverRpcError(error: { message: string; code?: string }): ApiError {
  const message = error.message ?? "";
  switch (error.code) {
    case "42501":
      return new ApiError(403, "waiver_sign_forbidden", "the server refused this waiver signature");
    case "22023":
      if (message.includes("active waiver version")) {
        return new ApiError(409, "waiver_version_changed", "the waiver was updated — reload and try again");
      }
      return new ApiError(422, "waiver_sign_invalid", message);
    case "P0002":
      return new ApiError(404, "waiver_version_not_found", "the waiver version is no longer available");
    default:
      throw new Error(`recordMemberWaiverSignature RPC failed: ${message}`);
  }
}

/** Records a member self-serve (source 'member_portal') signature via the
 * definer RPC. person/actor come ONLY from the session at the route; the RPC's
 * in-body service-role gate is the forge defense (attack block 39). Unit 8.3i. */
export async function recordMemberWaiverSignature(
  client: KeloSupabaseClient,
  params: {
    p_tenant: string;
    p_person: string;
    p_waiver_version: string;
    p_typed_name: string;
    p_ip_hash: string | null;
    p_user_agent: string | null;
  },
): Promise<string> {
  const { data, error } = await rpc(client, "record_waiver_signature", {
    p_tenant: params.p_tenant,
    p_person: params.p_person,
    p_waiver_version: params.p_waiver_version,
    p_typed_name: params.p_typed_name,
    p_acknowledged: true,
    p_source: "member_portal",
    p_ip_hash: params.p_ip_hash,
    p_user_agent: params.p_user_agent,
    p_link_token_hash: null,
    p_actor: null,
  });
  if (error !== null) throw mapMemberWaiverRpcError(error);
  return parseInternal(z.string().uuid(), data, "recordMemberWaiverSignature");
}

/** Records the append-only signature via the definer RPC. source 'desk' is the
 * in-person capture (no token); the pre-arrival-link source is phase-4-deferred
 * with the provider-gated link worker. */
export async function recordWaiverSignature(
  client: KeloSupabaseClient,
  params: {
    p_tenant: string;
    p_person: string;
    p_waiver_version: string;
    p_typed_name: string;
    p_acknowledged: boolean;
    p_source: "desk";
    p_ip_hash: string | null;
    p_user_agent: string | null;
    p_actor: string;
  },
): Promise<string> {
  const data = await run(
    rpc(client, "record_waiver_signature", { ...params, p_link_token_hash: null }),
    "recordWaiverSignature",
  );
  return parseInternal(z.string().uuid(), data, "recordWaiverSignature");
}
