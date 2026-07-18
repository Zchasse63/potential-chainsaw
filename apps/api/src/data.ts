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
  delete(): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  lt(column: string, value: unknown): TableBuilder;
  in(column: string, values: readonly unknown[]): TableBuilder;
  or(filters: string): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

function from(client: KeloSupabaseClient, table: string): TableBuilder {
  return client.from(table) as unknown as TableBuilder;
}

async function rpc(
  client: KeloSupabaseClient,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await (client as unknown as RpcClient).rpc(name, params);
  if (error !== null) {
    if (error.code === "42501") {
      throw new ApiError(403, "rpc_forbidden", "database authorization denied the operation");
    }
    throw new Error(`${name} RPC failed: ${error.message}`);
  }
  return data;
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

/** One member row by auth.users id, scoped to the resolved tenant. */
export async function fetchTenantUserByUserId(
  client: KeloSupabaseClient,
  tenantId: string,
  userId: string,
): Promise<TenantUserRow | null> {
  const data = await run(
    from(client, "tenant_users")
      .select(TENANT_USER_COLUMNS)
      .eq("user_id", userId)
      .eq("tenant_id", tenantId),
    "fetchTenantUserByUserId",
  );
  const rows = parseInternal(z.array(tenantUserRowSchema), data ?? [], "fetchTenantUserByUserId");
  return rows[0] ?? null;
}

// -- staff step-up auth (migration 0026) -------------------------------------

const staffMemberDbSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: tenantRoleSchema,
  status: memberStatusSchema,
  step_up_pin_set_at: z.string().nullable(),
  step_up_locked_until: z.string().nullable(),
  step_up_fail_count: z.number().int().nonnegative(),
  created_at: z.string(),
});

const stepUpEventRowSchema = z.object({
  tenant_user_id: z.string().uuid(),
  kind: z.enum(["set", "rotate", "verify_success", "verify_fail", "lockout"]),
  created_at: z.string(),
});

export interface StaffRosterRow {
  id: string;
  user_id: string;
  role: TenantRole;
  status: MemberStatus;
  pin_set: boolean;
  locked_until: string | null;
  fail_count: number;
  last_step_up_at: string | null;
  last_step_up_kind: z.infer<typeof stepUpEventRowSchema>["kind"] | null;
  created_at: string;
}

/**
 * Manager roster. Only explicit safe columns are selected: the credential
 * hash is intentionally absent and therefore cannot enter the response.
 */
export async function fetchStaffRoster(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<StaffRosterRow[]> {
  const [memberData, eventData] = await Promise.all([
    run(
      from(client, "tenant_users")
        .select(
          "id, user_id, role, status, step_up_pin_set_at, step_up_locked_until, step_up_fail_count, created_at",
        )
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true }),
      "fetchStaffRoster.members",
    ),
    run(
      from(client, "step_up_events")
        .select("tenant_user_id, kind, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }),
      "fetchStaffRoster.events",
    ),
  ]);
  const members = parseInternal(z.array(staffMemberDbSchema), memberData ?? [], "fetchStaffRoster");
  const events = parseInternal(
    z.array(stepUpEventRowSchema),
    eventData ?? [],
    "fetchStaffRoster.events",
  );
  const latest = new Map<string, z.infer<typeof stepUpEventRowSchema>>();
  for (const event of events) {
    const current = latest.get(event.tenant_user_id);
    if (
      current === undefined ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.kind === "lockout")
    ) {
      latest.set(event.tenant_user_id, event);
    }
  }
  const now = Date.now();
  return members.map((member) => {
    const event = latest.get(member.id);
    const lockedUntil =
      member.step_up_locked_until !== null && Date.parse(member.step_up_locked_until) > now
        ? member.step_up_locked_until
        : null;
    return {
      id: member.id,
      user_id: member.user_id,
      role: member.role,
      status: member.status,
      pin_set: member.step_up_pin_set_at !== null,
      locked_until: lockedUntil,
      fail_count:
        lockedUntil === null && member.step_up_locked_until !== null
          ? 0
          : member.step_up_fail_count,
      last_step_up_at: event?.created_at ?? null,
      last_step_up_kind: event?.kind ?? null,
      created_at: member.created_at,
    };
  });
}

const stepUpStatusSchema = z.object({
  pin_set: z.boolean(),
  locked_until: z.string().nullable(),
  fail_count: z.number().int().nonnegative(),
});
export type StepUpStatus = z.infer<typeof stepUpStatusSchema>;

export async function fetchStepUpStatus(
  client: KeloSupabaseClient,
  tenantId: string,
  userId: string,
): Promise<StepUpStatus | null> {
  const data = await rpc(client, "step_up_status", { p_tenant: tenantId, p_user: userId });
  const rows = parseInternal(z.array(stepUpStatusSchema), data ?? [], "step_up_status");
  return rows[0] ?? null;
}

const stepUpCredentialSchema = z.object({ step_up_pin_hash: z.string().nullable() });

/** Server-only credential read used solely by POST /staff/step-up/verify. */
export async function fetchStepUpCredential(
  client: KeloSupabaseClient,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const data = await run(
    from(client, "tenant_users")
      .select("step_up_pin_hash")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .eq("status", "active"),
    "fetchStepUpCredential",
  );
  const rows = parseInternal(z.array(stepUpCredentialSchema), data ?? [], "fetchStepUpCredential");
  return rows[0]?.step_up_pin_hash ?? null;
}

export async function setStepUpPin(
  client: KeloSupabaseClient,
  input: { tenantId: string; userId: string; pinHash: string; actorId: string },
): Promise<void> {
  await rpc(client, "set_step_up_pin", {
    p_tenant: input.tenantId,
    p_user: input.userId,
    p_pin_hash: input.pinHash,
    p_actor: input.actorId,
  });
}

const stepUpAttemptStateSchema = z.object({
  locked_until: z.string().nullable(),
  fail_count: z.number().int().nonnegative(),
  remaining_attempts: z.number().int().nonnegative(),
  attempt_recorded: z.boolean(),
});
export type StepUpAttemptState = z.infer<typeof stepUpAttemptStateSchema>;

export async function recordStepUpAttempt(
  client: KeloSupabaseClient,
  input: {
    tenantId: string;
    userId: string;
    success: boolean;
    context: string;
    ipHash: string | null;
  },
): Promise<StepUpAttemptState> {
  const data = await rpc(client, "record_step_up_attempt", {
    p_tenant: input.tenantId,
    p_user: input.userId,
    p_success: input.success,
    p_context: input.context,
    p_ip_hash: input.ipHash,
  });
  const rows = parseInternal(
    z.array(stepUpAttemptStateSchema),
    data ?? [],
    "record_step_up_attempt",
  );
  const state = rows[0];
  if (state === undefined) throw new Error("record_step_up_attempt returned no lock state");
  return state;
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

// -- import review (migration 0007) -------------------------------------------

export const quarantineStatusSchema = z.enum(["open", "resolved", "dismissed"]);
export type QuarantineStatus = z.infer<typeof quarantineStatusSchema>;

/**
 * One import_quarantine row as the LIST sees it. `payload` is deliberately
 * excluded — it is the raw evidence document and can be large; only the
 * detail fetch (fetchQuarantineItem) reads it.
 */
export const quarantineRowSchema = z.object({
  id: z.string().uuid(),
  entity: z.string(),
  external_ref: z.string().nullable(),
  reason: z.string(),
  status: quarantineStatusSchema,
  sync_run_id: z.string().uuid().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  resolution_note: z.string().nullable(),
});
export type QuarantineRow = z.infer<typeof quarantineRowSchema>;

const QUARANTINE_LIST_COLUMNS =
  "id, entity, external_ref, reason, status, sync_run_id, created_at, resolved_at, resolution_note";

/** The detail row adds `payload` (the before/after "what came in" preview). */
export const quarantineDetailSchema = quarantineRowSchema.extend({
  payload: z.unknown(),
});
export type QuarantineDetail = z.infer<typeof quarantineDetailSchema>;

const QUARANTINE_DETAIL_COLUMNS = `${QUARANTINE_LIST_COLUMNS}, payload`;

export interface QuarantineListOptions {
  status?: QuarantineStatus;
  entity?: string;
  limit?: number;
  /** Keyset cursor: the created_at of the previous page's last row. */
  cursor?: string;
}

export const QUARANTINE_LIST_DEFAULT_LIMIT = 50;

/** One page of the review queue, keyset-paginated by created_at desc. */
export async function fetchQuarantine(
  client: KeloSupabaseClient,
  tenantId: string,
  opts: QuarantineListOptions = {},
): Promise<QuarantineRow[]> {
  let builder = from(client, "import_quarantine")
    .select(QUARANTINE_LIST_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (opts.status !== undefined) builder = builder.eq("status", opts.status);
  if (opts.entity !== undefined) builder = builder.eq("entity", opts.entity);
  if (opts.cursor !== undefined) builder = builder.lt("created_at", opts.cursor);
  const data = await run(
    builder.limit(opts.limit ?? QUARANTINE_LIST_DEFAULT_LIMIT),
    "fetchQuarantine",
  );
  return parseInternal(z.array(quarantineRowSchema), data ?? [], "fetchQuarantine");
}

/** One quarantine row WITH payload, scoped to the resolved tenant. */
export async function fetchQuarantineItem(
  client: KeloSupabaseClient,
  tenantId: string,
  id: string,
): Promise<QuarantineDetail | null> {
  const data = await run(
    from(client, "import_quarantine")
      .select(QUARANTINE_DETAIL_COLUMNS)
      .eq("id", id)
      .eq("tenant_id", tenantId),
    "fetchQuarantineItem",
  );
  const rows = parseInternal(z.array(quarantineDetailSchema), data ?? [], "fetchQuarantineItem");
  return rows[0] ?? null;
}

export interface QuarantineCause {
  entity: string;
  reason: string;
  open_count: number;
}

// PostgREST cannot GROUP BY without an RPC, and migrations are out of this
// unit's scope — the grouping happens here over the open rows' two small
// columns. Bounded scan: if a failed import ever quarantines more rows than
// this, open_count is a LOWER BOUND (the queue itself stays correct).
const QUARANTINE_CAUSE_SCAN_LIMIT = 5000;

const quarantineCauseRowSchema = z.object({
  entity: z.string(),
  reason: z.string(),
});

/**
 * "Exceptions grouped by cause" (UX plan §3G): open rows grouped by
 * (entity, reason), most common first — the batch-decision unit for the
 * review UI.
 */
export async function fetchQuarantineCauses(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<QuarantineCause[]> {
  const data = await run(
    from(client, "import_quarantine")
      .select("entity, reason")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .limit(QUARANTINE_CAUSE_SCAN_LIMIT),
    "fetchQuarantineCauses",
  );
  const rows = parseInternal(
    z.array(quarantineCauseRowSchema),
    data ?? [],
    "fetchQuarantineCauses",
  );
  const groups = new Map<string, QuarantineCause>();
  for (const row of rows) {
    const key = `${row.entity} ${row.reason}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.open_count += 1;
    } else {
      groups.set(key, { entity: row.entity, reason: row.reason, open_count: 1 });
    }
  }
  return [...groups.values()].sort((a, b) => b.open_count - a.open_count);
}

/** Hard bound on one batch decision (route schema mirrors this → 422). */
export const QUARANTINE_RESOLVE_MAX_IDS = 200;

export interface QuarantineResolution {
  status: "resolved" | "dismissed";
  note?: string;
}

/**
 * Commit a batch decision. Writes ONLY the four resolution columns — the
 * migration-0007 column-list grant (status, resolved_by, resolved_at,
 * resolution_note) makes payload/reason/identity client-immutable, and this
 * function is the one write path behind it. FORWARD-ONLY in v1: the
 * status='open' filter means an already-resolved/dismissed row is never
 * re-opened or re-decided; ids that are foreign, missing, or no longer open
 * simply don't match (RLS + filter) and are absent from the returned rows —
 * the response is exactly what durably changed, nothing more.
 */
export async function resolveQuarantine(
  client: KeloSupabaseClient,
  tenantId: string,
  ids: string[],
  resolution: QuarantineResolution,
  actorUserId: string,
): Promise<QuarantineRow[]> {
  if (ids.length > QUARANTINE_RESOLVE_MAX_IDS) {
    throw new ApiError(
      422,
      "batch_too_large",
      `a batch decision is bounded to ${QUARANTINE_RESOLVE_MAX_IDS} ids`,
    );
  }
  const data = await run(
    from(client, "import_quarantine")
      .update({
        status: resolution.status,
        resolved_by: actorUserId,
        resolved_at: new Date().toISOString(),
        resolution_note: resolution.note ?? null,
      })
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .in("id", [...new Set(ids)])
      .select(QUARANTINE_LIST_COLUMNS),
    "resolveQuarantine",
  );
  return parseInternal(z.array(quarantineRowSchema), data ?? [], "resolveQuarantine");
}

// -- reconciliation (unit 1.5, built in PARALLEL — see the bridge note) -------

/**
 * The pinned read-shape of public.reconciliations (unit 1.5 owns the table;
 * this unit reads it so both converge — the director reconciles at merge).
 * Member-SELECT RLS like sync_runs; sums are Postgres numerics (JSON numbers).
 */
export const reconciliationRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  entity: z.string(),
  window_start: z.string().nullable(),
  window_end: z.string().nullable(),
  glofox_count: z.number().int().nullable(),
  kelo_count: z.number().int().nullable(),
  glofox_sum: z.number().nullable(),
  kelo_sum: z.number().nullable(),
  drift_count: z.number().int().nullable(),
  drift_sum: z.number().nullable(),
  status: z.enum(["match", "drift", "error"]),
  detail: z.unknown(),
  checked_at: z.string(),
  created_at: z.string(),
});
export type ReconciliationRow = z.infer<typeof reconciliationRowSchema>;

const RECONCILIATION_COLUMNS =
  "id, tenant_id, entity, window_start, window_end, glofox_count, kelo_count, glofox_sum, kelo_sum, drift_count, drift_sum, status, detail, checked_at, created_at";

export interface ReconciliationsResult {
  rows: ReconciliationRow[];
  /**
   * true when the reconciliations table does not exist YET. BRIDGE (the
   * director removes this when unit 1.5 merges): 1.5 builds the table in
   * parallel, so until it lands every read hits Postgres 42P01 "relation
   * does not exist". That is a PENDING pipeline, not a server defect — the
   * API answers 200 with an empty list and this flag (surfaced as
   * meta.reconciliation_pending / data.reconciliation_pending) instead of
   * 500ing, and the UI renders the honest pending banner. Any OTHER error
   * still throws (→ 500 + Sentry).
   */
  pending: boolean;
}

export async function fetchReconciliations(
  client: KeloSupabaseClient,
  tenantId: string,
  opts: { entity?: string; limit?: number } = {},
): Promise<ReconciliationsResult> {
  let builder = from(client, "reconciliations")
    .select(RECONCILIATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("checked_at", { ascending: false })
    .limit(opts.limit ?? 10);
  if (opts.entity !== undefined) builder = builder.eq("entity", opts.entity);
  const { data, error } = await builder;
  if (error !== null) {
    if (error.code === "42P01") {
      return { rows: [], pending: true };
    }
    throw new Error(`fetchReconciliations query failed: ${error.message}`);
  }
  return {
    rows: parseInternal(z.array(reconciliationRowSchema), data ?? [], "fetchReconciliations"),
    pending: false,
  };
}

// -- marketing campaigns (phase 3 · unit 2) ----------------------------------

export const campaignStatusSchema = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "sending",
  "sent",
  "cancelled",
]);
export const channelSchema = z.enum(["email", "sms"]);
export const messageKindSchema = z.enum([
  "marketing",
  "transactional",
  "transactional_quiet",
]);
export const plannedStatusSchema = z.enum([
  "eligible",
  "skip_no_consent",
  "skip_suppressed",
  "skip_quiet_hours",
  "skip_no_address",
]);

export const campaignRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  segment_key: z.string(),
  template_key: z.string(),
  channel: channelSchema,
  kind: messageKindSchema,
  draft_subject: z.string().nullable(),
  draft_body: z.string(),
  draft_source: z.enum(["template", "ai"]),
  status: campaignStatusSchema,
  created_by: z.string().uuid().nullable(),
  approved_by: z.string().uuid().nullable(),
  approved_at: z.string().nullable(),
  scheduled_for: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CampaignRow = z.infer<typeof campaignRowSchema>;

const CAMPAIGN_COLUMNS =
  "id, name, segment_key, template_key, channel, kind, draft_subject, draft_body, draft_source, status, created_by, approved_by, approved_at, scheduled_for, created_at, updated_at";

export const messageTemplateSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  key: z.string(),
  version: z.number().int(),
  channel: channelSchema,
  kind: messageKindSchema,
  subject: z.string().nullable(),
  body: z.string(),
  segment_key: z.string().nullable(),
  created_at: z.string(),
});
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

const TEMPLATE_COLUMNS =
  "id, tenant_id, key, version, channel, kind, subject, body, segment_key, created_at";

const sendPersonSchema = z.object({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
const sendPersonRelationSchema = z.union([sendPersonSchema, z.array(sendPersonSchema)]);
const campaignSendDbSchema = z.object({
  id: z.string().uuid(),
  person_id: z.string().uuid(),
  channel: channelSchema,
  planned_status: plannedStatusSchema,
  comms_log_id: z.string().uuid().nullable(),
  created_at: z.string(),
  person: sendPersonRelationSchema,
});

export interface CampaignSendView {
  id: string;
  person_id: string;
  channel: "email" | "sms";
  planned_status: z.infer<typeof plannedStatusSchema>;
  comms_log_id: string | null;
  created_at: string;
  person: z.infer<typeof sendPersonSchema>;
}

const attributionSchema = z.object({
  id: z.string().uuid(),
  campaign_send_id: z.string().uuid(),
  person_id: z.string().uuid(),
  event_type: z.enum(["booking", "purchase"]),
  event_ref: z.string(),
  occurred_at: z.string(),
  attributed_at: z.string(),
  window_days: z.number().int(),
});

export async function fetchCampaigns(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<CampaignRow[]> {
  const data = await run(
    from(client, "campaigns")
      .select(CAMPAIGN_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    "fetchCampaigns",
  );
  return parseInternal(z.array(campaignRowSchema), data ?? [], "fetchCampaigns");
}

export async function fetchTemplates(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<MessageTemplate[]> {
  const data = await run(
    from(client, "message_templates")
      .select(TEMPLATE_COLUMNS)
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .order("version", { ascending: false }),
    "fetchTemplates",
  );
  return parseInternal(z.array(messageTemplateSchema), data ?? [], "fetchTemplates");
}

function latestTemplate(
  rows: MessageTemplate[],
  tenantId: string,
  key: string,
  channel: "email" | "sms",
): MessageTemplate | null {
  return (
    rows
      .filter((row) => row.key === key && row.channel === channel)
      .sort((a, b) => {
        const tenantOrder = Number(b.tenant_id === tenantId) - Number(a.tenant_id === tenantId);
        return tenantOrder !== 0 ? tenantOrder : b.version - a.version;
      })[0] ?? null
  );
}

export async function createCampaign(
  client: KeloSupabaseClient,
  input: {
    tenantId: string;
    actorId: string;
    name: string;
    segmentKey: string;
    templateKey: string;
    channel: "email" | "sms";
  },
): Promise<CampaignRow> {
  const template = latestTemplate(
    await fetchTemplates(client, input.tenantId),
    input.tenantId,
    input.templateKey,
    input.channel,
  );
  if (template === null) {
    throw new ApiError(422, "template_not_found", "no matching template exists for this channel");
  }
  if (template.segment_key !== null && template.segment_key !== input.segmentKey) {
    throw new ApiError(422, "template_segment_mismatch", "template is not mapped to this segment");
  }
  const data = await run(
    from(client, "campaigns")
      .insert({
        tenant_id: input.tenantId,
        name: input.name,
        segment_key: input.segmentKey,
        template_key: input.templateKey,
        channel: input.channel,
        kind: template.kind,
        draft_subject: template.subject,
        draft_body: template.body,
        draft_source: "template",
        status: "draft",
        created_by: input.actorId,
      })
      .select(CAMPAIGN_COLUMNS),
    "createCampaign",
  );
  const row = parseInternal(z.array(campaignRowSchema), data ?? [], "createCampaign")[0];
  if (row === undefined) throw new Error("createCampaign returned no row");
  return row;
}

export interface CampaignDetail {
  campaign: CampaignRow;
  sends: CampaignSendView[];
  breakdown: Record<z.infer<typeof plannedStatusSchema>, number>;
  resolved_sample: { subject: string | null; body: string; person_id: string } | null;
  attributions: z.infer<typeof attributionSchema>[];
  attribution_note: string;
}

function resolvePreview(
  value: string,
  person: z.infer<typeof sendPersonSchema>,
  studioName: string,
): string {
  return value
    .replaceAll("{{first_name}}", person.first_name?.trim() || "there")
    .replaceAll("{{studio_name}}", studioName);
}

export async function fetchCampaignDetail(
  client: KeloSupabaseClient,
  tenantId: string,
  campaignId: string,
): Promise<CampaignDetail | null> {
  const campaignData = await run(
    from(client, "campaigns")
      .select(CAMPAIGN_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("id", campaignId),
    "fetchCampaignDetail.campaign",
  );
  const campaign = parseInternal(
    z.array(campaignRowSchema),
    campaignData ?? [],
    "fetchCampaignDetail.campaign",
  )[0];
  if (campaign === undefined) return null;

  const sendsData = await run(
    from(client, "campaign_sends")
      .select(
        "id, person_id, channel, planned_status, comms_log_id, created_at, person:people!campaign_sends_person_id_fkey(first_name, last_name, email, phone)",
      )
      .eq("tenant_id", tenantId)
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: true }),
    "fetchCampaignDetail.sends",
  );
  const dbSends = parseInternal(
    z.array(campaignSendDbSchema),
    sendsData ?? [],
    "fetchCampaignDetail.sends",
  );
  const sends = dbSends.map((row) => ({
    ...row,
    person: Array.isArray(row.person) ? (row.person[0] ?? sendPersonSchema.parse({
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
    })) : row.person,
  }));
  const breakdown: CampaignDetail["breakdown"] = {
    eligible: 0,
    skip_no_consent: 0,
    skip_suppressed: 0,
    skip_quiet_hours: 0,
    skip_no_address: 0,
  };
  for (const send of sends) breakdown[send.planned_status] += 1;

  const tenantData = await run(
    from(client, "tenants").select("id, name").eq("id", tenantId),
    "fetchCampaignDetail.tenant",
  );
  const tenantName = parseInternal(
    z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    tenantData ?? [],
    "fetchCampaignDetail.tenant",
  )[0]?.name ?? "the studio";
  const sample = sends.find((send) => send.planned_status === "eligible") ?? null;
  const resolvedSample =
    sample === null
      ? null
      : {
          subject:
            campaign.draft_subject === null
              ? null
              : resolvePreview(campaign.draft_subject, sample.person, tenantName),
          body: resolvePreview(campaign.draft_body, sample.person, tenantName),
          person_id: sample.person_id,
        };

  let attributions: z.infer<typeof attributionSchema>[] = [];
  if (sends.length > 0) {
    const attributionData = await run(
      from(client, "campaign_attributions")
        .select(
          "id, campaign_send_id, person_id, event_type, event_ref, occurred_at, attributed_at, window_days",
        )
        .eq("tenant_id", tenantId)
        .in("campaign_send_id", sends.map((send) => send.id))
        .order("occurred_at", { ascending: false }),
      "fetchCampaignDetail.attributions",
    );
    attributions = parseInternal(
      z.array(attributionSchema),
      attributionData ?? [],
      "fetchCampaignDetail.attributions",
    );
  }
  return {
    campaign,
    sends,
    breakdown,
    resolved_sample: resolvedSample,
    attributions,
    attribution_note:
      "Bookings and purchases after a sent message within the stated window are correlated, not proven to have been caused by the campaign.",
  };
}

export async function planCampaign(
  client: KeloSupabaseClient,
  campaignId: string,
): Promise<number> {
  return z.number().int().nonnegative().parse(
    await rpc(client, "build_campaign_plan", { p_campaign: campaignId }),
  );
}

export async function approveCampaign(
  client: KeloSupabaseClient,
  campaignId: string,
  actorId: string,
): Promise<number> {
  return z.number().int().nonnegative().parse(
    await rpc(client, "approve_campaign", { p_campaign: campaignId, p_actor: actorId }),
  );
}

export async function cancelCampaign(
  client: KeloSupabaseClient,
  tenantId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const data = await run(
    from(client, "campaigns")
      .update({ status: "cancelled" })
      .eq("tenant_id", tenantId)
      .eq("id", campaignId)
      .in("status", ["draft", "pending_approval"])
      .select(CAMPAIGN_COLUMNS),
    "cancelCampaign",
  );
  return parseInternal(z.array(campaignRowSchema), data ?? [], "cancelCampaign")[0] ?? null;
}

// -- data rights (migration 0025) --------------------------------------------

export const retentionPolicySchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  data_class: z.enum([
    "comms_content",
    "ai_artifacts",
    "raw_payloads",
    "import_quarantine",
    "webhook_events",
    "reconciliations",
  ]),
  retention_days: z.number().int().nonnegative(),
  action: z.enum(["delete", "scrub_body", "pseudonymize"]),
  legal_basis: z.string(),
  preserves: z.string(),
  version: z.number().int().positive(),
  created_at: z.string(),
});
export type RetentionPolicyRow = z.infer<typeof retentionPolicySchema>;

const RETENTION_POLICY_COLUMNS =
  "id, tenant_id, data_class, retention_days, action, legal_basis, preserves, version, created_at";

/** Latest tenant policy wins over the latest global policy for each class. */
export async function fetchEffectiveRetentionPolicies(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<RetentionPolicyRow[]> {
  const data = await run(
    from(client, "retention_policies")
      .select(RETENTION_POLICY_COLUMNS)
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .order("version", { ascending: false }),
    "fetchEffectiveRetentionPolicies",
  );
  const rows = parseInternal(
    z.array(retentionPolicySchema),
    data ?? [],
    "fetchEffectiveRetentionPolicies",
  );
  const effective = new Map<RetentionPolicyRow["data_class"], RetentionPolicyRow>();
  // Rows arrive version-descending. Process globals first, then tenant rows so
  // the newest tenant-specific definition always replaces the default.
  for (const row of rows.filter((candidate) => candidate.tenant_id === null)) {
    if (!effective.has(row.data_class)) effective.set(row.data_class, row);
  }
  for (const row of rows.filter((candidate) => candidate.tenant_id === tenantId)) {
    // The legacy provider inbox has no tenant_id. Until that schema is
    // tenant-attributed, only its global policy can be safely effective.
    if (row.data_class === "webhook_events") continue;
    const current = effective.get(row.data_class);
    if (current?.tenant_id !== tenantId) effective.set(row.data_class, row);
  }
  return [...effective.values()].sort((a, b) => a.data_class.localeCompare(b.data_class));
}

export const personDeletionSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  person_id: z.string().uuid(),
  requested_by: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  mode: z.enum(["pseudonymize", "hard"]),
  scrubbed_fields: z.array(z.string()).nullable(),
  preserved_note: z.string().nullable(),
  executed_at: z.string().nullable(),
  created_at: z.string(),
});
export type PersonDeletionRow = z.infer<typeof personDeletionSchema>;

export async function pseudonymizePerson(
  client: KeloSupabaseClient,
  input: { tenantId: string; personId: string; actorId: string; reason: string | null },
): Promise<PersonDeletionRow> {
  const data = await rpc(client, "pseudonymize_person", {
    p_tenant: input.tenantId,
    p_person: input.personId,
    p_actor: input.actorId,
    p_reason: input.reason,
  });
  const result = z.union([personDeletionSchema, z.array(personDeletionSchema)]).safeParse(data);
  if (!result.success) {
    throw new Error(`pseudonymizePerson: unexpected RPC row shape (${result.error.message})`);
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (row === undefined) throw new Error("pseudonymizePerson returned no erasure audit");
  return row;
}

export async function requestPersonExport(
  client: KeloSupabaseClient,
  input: {
    tenantId: string;
    personId: string;
    actorId: string;
    idempotencyKey: string;
  },
): Promise<string> {
  return z.string().uuid().parse(
    await rpc(client, "request_person_export", {
      p_tenant: input.tenantId,
      p_person: input.personId,
      p_actor: input.actorId,
      p_idempotency_key: input.idempotencyKey,
    }),
  );
}

export const dataExportSchema = z.object({
  id: z.string().uuid(),
  subject_person_id: z.string().uuid().nullable(),
  requested_by: z.string().uuid().nullable(),
  status: z.enum(["queued", "running", "ready", "error", "expired"]),
  artifact: z.unknown().nullable(),
  row_counts: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DataExportRow = z.infer<typeof dataExportSchema>;

const DATA_EXPORT_COLUMNS =
  "id, subject_person_id, requested_by, status, artifact, row_counts, error, expires_at, created_at, updated_at";

export async function fetchDataExport(
  client: KeloSupabaseClient,
  tenantId: string,
  exportId: string,
): Promise<DataExportRow | null> {
  const data = await run(
    from(client, "data_exports")
      .select(DATA_EXPORT_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("id", exportId),
    "fetchDataExport",
  );
  const row = parseInternal(z.array(dataExportSchema), data ?? [], "fetchDataExport")[0];
  if (row === undefined) return null;
  // The bundle is visible only during its ready window. Status normalization
  // is response-only; a later cleanup worker may durably mark it expired.
  const isExpired =
    row.status === "ready" && row.expires_at !== null && Date.parse(row.expires_at) <= Date.now();
  return isExpired ? { ...row, status: "expired", artifact: null } : row;
}

// -- waiver engine (migration 0028) -----------------------------------------

export const waiverVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string().nullable(),
  body: z.string(),
  effective_from: z.string(),
  active: z.boolean(),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type WaiverVersionRow = z.infer<typeof waiverVersionSchema>;

const WAIVER_VERSION_COLUMNS =
  "id, version, title, body, effective_from, active, created_by, created_at";

export async function fetchWaiverVersions(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<WaiverVersionRow[]> {
  const data = await run(
    from(client, "waiver_versions")
      .select(WAIVER_VERSION_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("version", { ascending: false }),
    "fetchWaiverVersions",
  );
  return parseInternal(z.array(waiverVersionSchema), data ?? [], "fetchWaiverVersions");
}

export async function createWaiverVersion(
  client: KeloSupabaseClient,
  input: {
    tenantId: string;
    actorId: string;
    version: number;
    title: string | null;
    body: string;
    effectiveFrom?: string;
  },
): Promise<WaiverVersionRow> {
  const values = {
    tenant_id: input.tenantId,
    created_by: input.actorId,
    version: input.version,
    title: input.title,
    body: input.body,
    active: false,
    ...(input.effectiveFrom === undefined ? {} : { effective_from: input.effectiveFrom }),
  };
  const data = await run(
    from(client, "waiver_versions").insert(values).select(WAIVER_VERSION_COLUMNS),
    "createWaiverVersion",
  );
  const row = parseInternal(z.array(waiverVersionSchema), data ?? [], "createWaiverVersion")[0];
  if (row === undefined) throw new Error("createWaiverVersion returned no row");
  return row;
}

export async function updateWaiverVersion(
  client: KeloSupabaseClient,
  tenantId: string,
  versionId: string,
  patch: { title?: string | null; body?: string; effective_from?: string },
): Promise<WaiverVersionRow | null> {
  const data = await run(
    from(client, "waiver_versions")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("id", versionId)
      .select(WAIVER_VERSION_COLUMNS),
    "updateWaiverVersion",
  );
  return parseInternal(z.array(waiverVersionSchema), data ?? [], "updateWaiverVersion")[0] ?? null;
}

export async function deleteWaiverVersion(
  client: KeloSupabaseClient,
  tenantId: string,
  versionId: string,
): Promise<boolean> {
  const data = await run(
    from(client, "waiver_versions")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", versionId)
      .select("id"),
    "deleteWaiverVersion",
  );
  return parseInternal(
    z.array(z.object({ id: z.string().uuid() })),
    data ?? [],
    "deleteWaiverVersion",
  ).length === 1;
}

export async function activateWaiverVersion(
  client: KeloSupabaseClient,
  tenantId: string,
  versionId: string,
  actorId: string,
): Promise<boolean> {
  return z.boolean().parse(
    await rpc(client, "activate_waiver_version", {
      p_tenant: tenantId,
      p_version_id: versionId,
      p_actor: actorId,
    }),
  );
}

const waiverStatusSchema = z.object({
  has_current_signature: z.boolean(),
  signed_version: z.number().int().positive().nullable(),
  active_version: z.number().int().positive().nullable(),
  needs_signature: z.boolean(),
});

const waiverQueuePersonSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

export interface WaiverQueueRow extends z.infer<typeof waiverQueuePersonSchema> {
  has_current_signature: boolean;
  signed_version: number | null;
  active_version: number;
  needs_signature: true;
  reason: "never_signed" | "outdated_version";
}

export async function fetchWaiverQueue(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<WaiverQueueRow[]> {
  const peopleData = await run(
    from(client, "people")
      .select("id, first_name, last_name, email, phone")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("last_name", { ascending: true }),
    "fetchWaiverQueue.people",
  );
  const people = parseInternal(
    z.array(waiverQueuePersonSchema),
    peopleData ?? [],
    "fetchWaiverQueue.people",
  );
  const rows = await Promise.all(
    people.map(async (person) => {
      const value = await rpc(client, "current_waiver_status", {
        p_tenant: tenantId,
        p_person: person.id,
      });
      const statuses = parseInternal(
        z.array(waiverStatusSchema),
        value ?? [],
        "fetchWaiverQueue.status",
      );
      return { person, status: statuses[0] };
    }),
  );
  return rows.flatMap(({ person, status }) => {
    if (status?.needs_signature !== true || status.active_version === null) return [];
    return [{
      ...person,
      ...status,
      active_version: status.active_version,
      needs_signature: true as const,
      reason: status.signed_version === null ? "never_signed" as const : "outdated_version" as const,
    }];
  });
}

export async function recordWaiverSignature(
  client: KeloSupabaseClient,
  input: {
    tenantId: string;
    personId: string;
    waiverVersionId: string;
    typedName: string;
    acknowledged: boolean;
    source: "desk" | "pre_arrival_link";
    ipHash: string | null;
    userAgent: string | null;
    tokenHash?: string;
    actorId?: string;
  },
): Promise<string> {
  const { data, error } = await (client as unknown as RpcClient).rpc("record_waiver_signature", {
    p_tenant: input.tenantId,
    p_person: input.personId,
    p_waiver_version: input.waiverVersionId,
    p_typed_name: input.typedName,
    p_acknowledged: input.acknowledged,
    p_source: input.source,
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
    p_link_token_hash: input.tokenHash ?? null,
    p_actor: input.actorId ?? null,
  });
  if (error !== null) {
    if (error.code === "22023") {
      throw new ApiError(422, "invalid_waiver_acknowledgement", "typed name and acknowledgement are required");
    }
    if (error.code === "P0002" && input.source === "pre_arrival_link") {
      throw new ApiError(410, "waiver_link_unavailable", "this waiver link is invalid or no longer available");
    }
    if (error.code === "42501") {
      throw new ApiError(403, "waiver_signature_forbidden", "waiver signature capture was denied");
    }
    throw new Error(`record_waiver_signature RPC failed: ${error.message}`);
  }
  return z.string().uuid().parse(data);
}

export async function enqueueWaiverLinks(
  client: KeloSupabaseClient,
  input: {
    tenantId: string;
    actorId: string;
    idempotencyKey: string;
    personId?: string;
  },
): Promise<string> {
  return z.string().uuid().parse(
    await rpc(client, "enqueue_waiver_links", {
      p_tenant: input.tenantId,
      p_actor: input.actorId,
      p_idempotency_key: input.idempotencyKey,
      p_person: input.personId ?? null,
    }),
  );
}

const waiverTokenRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  person_id: z.string().uuid(),
  waiver_version_id: z.string().uuid(),
  expires_at: z.string(),
  consumed_at: z.string().nullable(),
});

export type PublicWaiverResolution =
  | { status: "missing" }
  | { status: "gone" }
  | {
      status: "valid";
      tenantId: string;
      personId: string;
      waiverVersionId: string;
      waiver: Pick<WaiverVersionRow, "version" | "title" | "body" | "effective_from">;
      signer: { first_name: string | null; last_initial: string | null };
    };

/** Service-scoped lookup for a high-entropy bearer token hash. The response
 * deliberately returns no email, phone, person id, tenant id, or raw token. */
export async function resolvePublicWaiver(
  client: KeloSupabaseClient,
  tokenHash: string,
  now = new Date(),
): Promise<PublicWaiverResolution> {
  const tokenData = await run(
    from(client, "waiver_link_tokens")
      .select("id, tenant_id, person_id, waiver_version_id, expires_at, consumed_at")
      .eq("token_hash", tokenHash)
      .limit(1),
    "resolvePublicWaiver.token",
  );
  const token = parseInternal(
    z.array(waiverTokenRowSchema), tokenData ?? [], "resolvePublicWaiver.token",
  )[0];
  if (token === undefined) return { status: "missing" };
  if (token.consumed_at !== null || Date.parse(token.expires_at) <= now.valueOf()) {
    return { status: "gone" };
  }

  const [versionData, personData] = await Promise.all([
    run(
      from(client, "waiver_versions")
        .select("id, version, title, body, effective_from")
        .eq("tenant_id", token.tenant_id)
        .eq("id", token.waiver_version_id),
      "resolvePublicWaiver.version",
    ),
    run(
      from(client, "people")
        .select("id, first_name, last_name")
        .eq("tenant_id", token.tenant_id)
        .eq("id", token.person_id),
      "resolvePublicWaiver.person",
    ),
  ]);
  const version = parseInternal(
    z.array(z.object({
      id: z.string().uuid(), version: z.number().int().positive(), title: z.string().nullable(),
      body: z.string(), effective_from: z.string(),
    })),
    versionData ?? [],
    "resolvePublicWaiver.version",
  )[0];
  const person = parseInternal(
    z.array(z.object({
      id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable(),
    })),
    personData ?? [],
    "resolvePublicWaiver.person",
  )[0];
  if (version === undefined || person === undefined) return { status: "missing" };
  return {
    status: "valid",
    tenantId: token.tenant_id,
    personId: token.person_id,
    waiverVersionId: token.waiver_version_id,
    waiver: {
      version: version.version,
      title: version.title,
      body: version.body,
      effective_from: version.effective_from,
    },
    signer: {
      first_name: person.first_name,
      last_initial: person.last_name?.trim().charAt(0) || null,
    },
  };
}
