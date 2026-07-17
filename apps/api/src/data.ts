import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "./errors.js";

/**
 * Data access for the API — ALWAYS through the user-scoped client (RLS
 * enforced, invariant #7). Every query also filters tenant explicitly; RLS is
 * the structural backstop, not the only line.
 *
 * packages/db/src/database.types.ts is still the empty-schema stub (its own
 * TODO: generated types land once the CLI runs), so `from()` below describes
 * exactly the PostgREST surface this app uses and EVERY result is validated
 * with Zod at the boundary — these schemas are the code-side contract with
 * migrations 0002 (tenancy) + 0006 (observability).
 * TODO: drop the structural cast once generated DB types land.
 */

interface QueryError {
  message: string;
  code?: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

/** The exact PostgREST builder surface this app uses. */
interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  insert(values: unknown): TableBuilder;
  update(values: unknown): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

/** Await a query; a PostgREST error is a server defect (→ 500 + Sentry). */
async function run(builder: TableBuilder, label: string): Promise<unknown> {
  const { data, error } = await builder;
  if (error !== null) {
    throw new Error(`${label} query failed: ${error.message}`);
  }
  return data;
}

/**
 * Validate a DB result at the boundary. A shape mismatch is a SERVER defect
 * (schema drift), so this throws a plain Error (→ 500 + Sentry), never the
 * request-validation 422 reserved for client input.
 */
function parseInternal<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  label: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label}: unexpected DB row shape (${result.error.message})`);
  }
  return result.data;
}

// -- tenancy (migration 0002) -------------------------------------------------

export const tenantRoleSchema = z.enum(["owner", "manager", "front_desk", "trainer"]);
export type TenantRole = z.infer<typeof tenantRoleSchema>;

export const memberStatusSchema = z.enum(["active", "deactivated"]);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

const membershipRowSchema = z.object({
  tenant_id: z.string().uuid(),
  role: tenantRoleSchema,
});

export interface Membership {
  tenantId: string;
  role: TenantRole;
}

/**
 * The caller's ACTIVE memberships. Under RLS this returns exactly the rows for
 * user_id = auth.uid(); the explicit user_id filter documents intent. This is
 * the ONLY input to tenant resolution (threat model §1).
 */
export async function fetchMemberships(
  client: KeloSupabaseClient,
  userId: string,
): Promise<Membership[]> {
  const data = await run(
    from(client, "tenant_users")
      .select("tenant_id, role")
      .eq("user_id", userId)
      .eq("status", "active"),
    "fetchMemberships",
  );
  return parseInternal(z.array(membershipRowSchema), data ?? [], "fetchMemberships").map((row) => ({
    tenantId: row.tenant_id,
    role: row.role,
  }));
}

export const tenantRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  settings: z.record(z.unknown()),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TenantRow = z.infer<typeof tenantRowSchema>;

const TENANT_COLUMNS = "id, name, slug, settings, status, created_at, updated_at";

export async function fetchTenant(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<TenantRow | null> {
  const data = await run(
    from(client, "tenants").select(TENANT_COLUMNS).eq("id", tenantId),
    "fetchTenant",
  );
  const rows = parseInternal(z.array(tenantRowSchema), data ?? [], "fetchTenant");
  return rows[0] ?? null;
}

export interface TenantPatch {
  name?: string;
  settings?: Record<string, unknown>;
}

export async function updateTenant(
  client: KeloSupabaseClient,
  tenantId: string,
  patch: TenantPatch,
): Promise<TenantRow | null> {
  const data = await run(
    from(client, "tenants").update(patch).eq("id", tenantId).select(TENANT_COLUMNS),
    "updateTenant",
  );
  const rows = parseInternal(z.array(tenantRowSchema), data ?? [], "updateTenant");
  return rows[0] ?? null;
}

/**
 * Member listing. Explicit columns: step_up_pin_hash is credential material
 * and must never appear in an API response.
 */
export const tenantUserRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: tenantRoleSchema,
  status: memberStatusSchema,
  invited_by: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type TenantUserRow = z.infer<typeof tenantUserRowSchema>;

const TENANT_USER_COLUMNS = "id, user_id, role, status, invited_by, created_at";

export async function fetchTenantUsers(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<TenantUserRow[]> {
  const data = await run(
    from(client, "tenant_users")
      .select(TENANT_USER_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true }),
    "fetchTenantUsers",
  );
  return parseInternal(z.array(tenantUserRowSchema), data ?? [], "fetchTenantUsers");
}

/** One member row by tenant_users row id, scoped to the resolved tenant. */
export async function fetchTenantUser(
  client: KeloSupabaseClient,
  tenantId: string,
  memberId: string,
): Promise<TenantUserRow | null> {
  const data = await run(
    from(client, "tenant_users")
      .select(TENANT_USER_COLUMNS)
      .eq("id", memberId)
      .eq("tenant_id", tenantId),
    "fetchTenantUser",
  );
  const rows = parseInternal(z.array(tenantUserRowSchema), data ?? [], "fetchTenantUser");
  return rows[0] ?? null;
}

export interface MemberPatch {
  role?: TenantRole;
  status?: MemberStatus;
}

/** Update a member scoped to the resolved tenant (RLS + explicit filter). */
export async function updateTenantUser(
  client: KeloSupabaseClient,
  tenantId: string,
  memberId: string,
  patch: MemberPatch,
): Promise<TenantUserRow | null> {
  const data = await run(
    from(client, "tenant_users")
      .update(patch)
      .eq("id", memberId)
      .eq("tenant_id", tenantId)
      .select(TENANT_USER_COLUMNS),
    "updateTenantUser",
  );
  const rows = parseInternal(z.array(tenantUserRowSchema), data ?? [], "updateTenantUser");
  return rows[0] ?? null;
}

/** Invitation listing. Explicit columns: token_hash must never leave the DB. */
export const invitationRowSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: tenantRoleSchema,
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  expires_at: z.string(),
  invited_by: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type InvitationRow = z.infer<typeof invitationRowSchema>;

const INVITATION_COLUMNS = "id, email, role, status, expires_at, invited_by, created_at";

export async function fetchInvitations(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<InvitationRow[]> {
  const data = await run(
    from(client, "tenant_invitations")
      .select(INVITATION_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    "fetchInvitations",
  );
  return parseInternal(z.array(invitationRowSchema), data ?? [], "fetchInvitations");
}

export interface NewInvitation {
  tenant_id: string;
  email: string;
  role: TenantRole;
  token_hash: string;
  expires_at: string;
  invited_by: string;
}

export async function insertInvitation(
  client: KeloSupabaseClient,
  invitation: NewInvitation,
): Promise<InvitationRow> {
  const { data, error } = await from(client, "tenant_invitations")
    .insert(invitation)
    .select(INVITATION_COLUMNS);
  if (error !== null) {
    // Partial unique index on (tenant_id, email) where status = 'pending'.
    if (error.code === "23505") {
      throw new ApiError(
        409,
        "invitation_exists",
        "a pending invitation already exists for this email",
      );
    }
    throw new Error(`insertInvitation query failed: ${error.message}`);
  }
  const rows = parseInternal(z.array(invitationRowSchema), data ?? [], "insertInvitation");
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insertInvitation: insert returned no row");
  }
  return row;
}

/** Revoke a PENDING invitation, scoped to the resolved tenant. */
export async function revokeInvitation(
  client: KeloSupabaseClient,
  tenantId: string,
  invitationId: string,
): Promise<InvitationRow | null> {
  const data = await run(
    from(client, "tenant_invitations")
      .update({ status: "revoked" })
      .eq("id", invitationId)
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .select(INVITATION_COLUMNS),
    "revokeInvitation",
  );
  const rows = parseInternal(z.array(invitationRowSchema), data ?? [], "revokeInvitation");
  return rows[0] ?? null;
}

/**
 * Audit write (migration 0002; threat model 4b). actor_user_id is ALWAYS the
 * verified session user — never client-supplied (the hardened path the
 * intra-tenant audit follow-up relies on). Insert-only: UPDATE/DELETE are
 * revoked for every app role at the DB level.
 */
export interface AuditEventInput {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function insertAuditEvent(
  client: KeloSupabaseClient,
  input: AuditEventInput,
): Promise<void> {
  const { error } = await from(client, "audit_events").insert({
    tenant_id: input.tenantId,
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    metadata: input.metadata ?? {},
  });
  if (error !== null) {
    throw new Error(`insertAuditEvent query failed: ${error.message}`);
  }
}

// -- observability (migration 0006) -------------------------------------------

export const syncStateRowSchema = z.object({
  entity: z.string(),
  health_state: z.enum(["healthy", "stale", "error", "paused_auth_failed", "unknown"]),
  last_run_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  committed_watermark: z.string().nullable(),
  consecutive_empty: z.number().int(),
});
export type SyncStateRow = z.infer<typeof syncStateRowSchema>;

export async function fetchSyncStates(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<SyncStateRow[]> {
  const data = await run(
    from(client, "sync_state")
      .select(
        "entity, health_state, last_run_at, last_success_at, committed_watermark, consecutive_empty",
      )
      .eq("tenant_id", tenantId)
      .order("entity", { ascending: true }),
    "fetchSyncStates",
  );
  return parseInternal(z.array(syncStateRowSchema), data ?? [], "fetchSyncStates");
}

export const syncRunRowSchema = z.object({
  id: z.string().uuid(),
  entity: z.string(),
  status: z.enum(["running", "success", "error", "empty_suspect"]).nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  rows_fetched: z.number().int().nullable(),
  rows_upserted: z.number().int().nullable(),
  rows_quarantined: z.number().int().nullable(),
  window_start: z.string().nullable(),
  window_end: z.string().nullable(),
  error: z.string().nullable(),
});
export type SyncRunRow = z.infer<typeof syncRunRowSchema>;

const SYNC_RUN_COLUMNS =
  "id, entity, status, started_at, finished_at, rows_fetched, rows_upserted, rows_quarantined, window_start, window_end, error";

export async function fetchRecentSyncRuns(
  client: KeloSupabaseClient,
  tenantId: string,
  limit = 20,
): Promise<SyncRunRow[]> {
  const data = await run(
    from(client, "sync_runs")
      .select(SYNC_RUN_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("started_at", { ascending: false })
      .limit(limit),
    "fetchRecentSyncRuns",
  );
  return parseInternal(z.array(syncRunRowSchema), data ?? [], "fetchRecentSyncRuns");
}

export const alertRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  body: z.string().nullable(),
  status: z.enum(["open", "acknowledged", "resolved"]),
  created_at: z.string(),
});
export type AlertRow = z.infer<typeof alertRowSchema>;

export async function fetchOpenAlerts(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<AlertRow[]> {
  const data = await run(
    from(client, "alerts")
      .select("id, kind, severity, title, body, status, created_at")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .order("created_at", { ascending: false }),
    "fetchOpenAlerts",
  );
  return parseInternal(z.array(alertRowSchema), data ?? [], "fetchOpenAlerts");
}
