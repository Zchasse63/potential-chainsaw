import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";

/**
 * Phase 4.3 — waiver engine data layer. The write path goes through the
 * migration-0028 SECURITY INVOKER wrappers (activate_waiver_version,
 * record_waiver_signature, current_waiver_status) so RLS + the in-body tenancy
 * checks both apply. waiver_signatures is append-only legal evidence; there is
 * no update/delete path here by construction.
 */

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
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
