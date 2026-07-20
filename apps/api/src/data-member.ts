import { z } from "zod";
import { toE164US } from "@kelo/comms";
import type { KeloSupabaseClient } from "@kelo/db";

/**
 * The member data layer (plan-member-app §3.4, unit 8.2b) — the ONLY way
 * member routes and the resolveMember middleware touch the database. Every
 * query goes through the service-role client with EXPLICIT tenant/person
 * filters (member_sessions, member_otp_challenges, and
 * member_verification_events are service-role-only tables by design — RLS
 * denies every client role, so this client is the sole reader; the explicit
 * filters keep tenant discipline in the query itself).
 *
 * Scope rule (§3.4): every exported function whose work happens inside a
 * session takes `{ tenantId, personId }` as its FIRST parameter. The auth
 * functions (pre-session) take the contact or its hash instead. Raw contacts,
 * codes, and tokens are NEVER passed here in a form that could be persisted:
 * the route layer hashes first and these functions see only sha256 hex.
 *
 * OTP verdicts come EXCLUSIVELY from public.consume_member_otp (the PostgREST
 * wrapper over app.consume_member_otp, migration 0044) — no attempt counting,
 * expiry, or comparison logic exists here.
 */

interface QueryError {
  message: string;
  code?: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

/** The exact PostgREST builder surface this module uses. */
interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  insert(values: unknown): TableBuilder;
  update(values: unknown): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  gte(column: string, value: unknown): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

/** The GoTrue admin surface used by the staff-email hygiene check. */
interface AuthAdminClient {
  auth: {
    admin: {
      listUsers(params: { page: number; perPage: number }): PromiseLike<{
        data: { users: { id: string; email?: string | undefined }[] };
        error: { message: string } | null;
      }>;
    };
  };
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
 * (schema drift) → plain Error (→ 500 + Sentry), never a client-facing 422.
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

const uuid = z.string().uuid();

/** Tenant + person pair — the FIRST parameter of every session-scoped fn. */
export interface MemberScope {
  tenantId: string;
  personId: string;
}

// -- contact normalization (pure; hashing happens in the route layer) --------

export interface NormalizedContact {
  channel: "email" | "sms";
  /** Canonical form: lowercased email, or E.164 phone (people.phone_e164). */
  normalized: string;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Normalize a typed contact to its canonical match form — the same
 * canonicalization the people table carries (people.email is citext, i.e.
 * case-insensitive; people.phone_e164 is the toE164US generated column), so
 * the exact-match lookups below line up with what was typed. Returns null
 * when the contact can be neither an email nor a US phone.
 */
export function normalizeMemberContact(raw: string): NormalizedContact | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (!EMAIL_SHAPE.test(email)) return null;
    return { channel: "email", normalized: email };
  }
  const phone = toE164US(trimmed);
  if (phone === null) return null;
  return { channel: "sms", normalized: phone };
}

// -- session path (resolveMember) ---------------------------------------------

const memberSessionRowSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  person_id: uuid,
  expires_at: z.string(),
  absolute_expires_at: z.string(),
  revoked_at: z.string().nullable(),
  step_up_at: z.string().nullable(),
});
export type MemberSessionRow = z.infer<typeof memberSessionRowSchema>;

/**
 * Session lookup by token HASH (the sole entry point to the session path —
 * the scope is unknown until the row resolves, which is why this one function
 * takes the hash instead of a MemberScope). Service-role only: the table has
 * no client-readable policy at all.
 */
export async function findMemberSessionByTokenHash(
  client: KeloSupabaseClient,
  tokenHash: string,
): Promise<MemberSessionRow | null> {
  const data = await run(
    from(client, "member_sessions")
      .select("id, tenant_id, person_id, expires_at, absolute_expires_at, revoked_at, step_up_at")
      .eq("token_hash", tokenHash)
      .limit(1),
    "findMemberSessionByTokenHash",
  );
  const rows = parseInternal(z.array(memberSessionRowSchema), data ?? [], "findMemberSessionByTokenHash");
  return rows[0] ?? null;
}

/** Slide activity: last_seen_at = now, expires_at = now + 90d (rolling). */
export async function slideMemberSession(
  scope: MemberScope,
  client: KeloSupabaseClient,
  sessionId: string,
  nowIso: string,
  rollingExpiresIso: string,
): Promise<void> {
  await run(
    from(client, "member_sessions")
      .update({ last_seen_at: nowIso, expires_at: rollingExpiresIso })
      .eq("id", sessionId)
      .eq("tenant_id", scope.tenantId)
      .eq("person_id", scope.personId),
    "slideMemberSession",
  );
}

export const memberClaimStatusDbSchema = z.enum([
  "active",
  "needs_resolution",
  "frozen",
  "revoked",
]);
export type MemberClaimStatusDb = z.infer<typeof memberClaimStatusDbSchema>;

/**
 * The claim state for the session's person. An ACTIVE claim wins when one
 * exists (a person can carry revoked/needs_resolution history alongside it);
 * otherwise the latest non-active row describes the held state; null means no
 * claim at all. resolveMember admits ONLY 'active'.
 */
export async function findPersonClaimStatus(
  scope: MemberScope,
  client: KeloSupabaseClient,
): Promise<{ status: MemberClaimStatusDb } | null> {
  const active = await run(
    from(client, "person_claims")
      .select("status")
      .eq("tenant_id", scope.tenantId)
      .eq("person_id", scope.personId)
      .eq("status", "active")
      .limit(1),
    "findPersonClaimStatus.active",
  );
  const activeRows = parseInternal(
    z.array(z.object({ status: memberClaimStatusDbSchema })),
    active ?? [],
    "findPersonClaimStatus.active",
  );
  const activeRow = activeRows[0];
  if (activeRow !== undefined) return { status: activeRow.status };

  const latest = await run(
    from(client, "person_claims")
      .select("status")
      .eq("tenant_id", scope.tenantId)
      .eq("person_id", scope.personId)
      .order("created_at", { ascending: false })
      .limit(1),
    "findPersonClaimStatus.latest",
  );
  const latestRows = parseInternal(
    z.array(z.object({ status: memberClaimStatusDbSchema })),
    latest ?? [],
    "findPersonClaimStatus.latest",
  );
  const latestRow = latestRows[0];
  return latestRow !== undefined ? { status: latestRow.status } : null;
}

// -- OTP challenges (pre-session; keyed by hashes only) ------------------------

export interface RecentChallengeCounts {
  byContact: number;
  byIp: number;
}

/**
 * The send-rate counters behind the §3.1 caps (5/contact/hour, 20/IP/hour).
 * Counts are over challenge rows created in the window — one row per /start
 * that passed the caps, so "sends" and "rows" are the same thing.
 */
export async function countRecentOtpChallenges(
  client: KeloSupabaseClient,
  tenantId: string,
  hashes: { contactHash: string; ipHash: string },
  sinceIso: string,
): Promise<RecentChallengeCounts> {
  const [contactData, ipData] = await Promise.all([
    run(
      from(client, "member_otp_challenges")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_hash", hashes.contactHash)
        .gte("created_at", sinceIso),
      "countRecentOtpChallenges.contact",
    ),
    run(
      from(client, "member_otp_challenges")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("ip_hash", hashes.ipHash)
        .gte("created_at", sinceIso),
      "countRecentOtpChallenges.ip",
    ),
  ]);
  const ids = z.array(z.object({ id: uuid }));
  return {
    byContact: parseInternal(ids, contactData ?? [], "countRecentOtpChallenges.contact").length,
    byIp: parseInternal(ids, ipData ?? [], "countRecentOtpChallenges.ip").length,
  };
}

export interface NewOtpChallenge {
  contactHash: string;
  channel: "email" | "sms";
  codeHash: string;
  /** ISO instant — the route sets now + 10 minutes. */
  expiresAt: string;
  ipHash: string;
}

/** Persist a challenge. Hashes only — no column can hold a raw contact/code. */
export async function insertOtpChallenge(
  client: KeloSupabaseClient,
  tenantId: string,
  challenge: NewOtpChallenge,
): Promise<void> {
  await run(
    from(client, "member_otp_challenges").insert({
      tenant_id: tenantId,
      contact_hash: challenge.contactHash,
      channel: challenge.channel,
      code_hash: challenge.codeHash,
      expires_at: challenge.expiresAt,
      ip_hash: challenge.ipHash,
    }),
    "insertOtpChallenge",
  );
}

const otpVerdictSchema = z.object({
  success: z.boolean(),
  remaining_attempts: z.number().int(),
  locked: z.boolean(),
});
export type OtpVerdict = z.infer<typeof otpVerdictSchema>;

/**
 * THE ONLY OTP verdict path: public.consume_member_otp (PostgREST wrapper over
 * app.consume_member_otp, 0044). Atomic — FOR UPDATE row lock, 5-attempt cap,
 * single consume, neutral unknown/expired failure — all in the DB; this
 * function only forwards hashes and validates the verdict shape.
 */
export async function consumeMemberOtp(
  client: KeloSupabaseClient,
  params: {
    tenantId: string;
    contactHash: string;
    channel: "email" | "sms";
    codeHash: string;
    ipHash: string;
  },
): Promise<OtpVerdict> {
  const { data, error } = await (client as unknown as RpcClient).rpc("consume_member_otp", {
    p_tenant: params.tenantId,
    p_contact_hash: params.contactHash,
    p_channel: params.channel,
    p_code_hash: params.codeHash,
    p_ip_hash: params.ipHash,
  });
  if (error !== null) {
    throw new Error(`consume_member_otp RPC failed: ${error.message}`);
  }
  const rows = parseInternal(z.array(otpVerdictSchema), data ?? [], "consumeMemberOtp");
  const verdict = rows[0];
  if (verdict === undefined) {
    throw new Error("consumeMemberOtp: RPC returned no verdict row");
  }
  return verdict;
}

// -- contact → person resolution (verify path) ---------------------------------

const personMatchRowSchema = z.object({
  id: uuid,
  first_name: z.string().nullable(),
  source: z.enum(["native", "glofox"]),
  claim_frozen: z.boolean(),
  created_at: z.string(),
});
export type PersonMatchRow = z.infer<typeof personMatchRowSchema>;

/**
 * Exact contact → person match on the canonical columns (people.email citext
 * / people.phone_e164), oldest first so ambiguity handling is deterministic.
 * Email is structurally unambiguous (partial unique index, 0008); a shared
 * phone can match several people.
 */
export async function findPeopleByContact(
  client: KeloSupabaseClient,
  tenantId: string,
  contact: NormalizedContact,
): Promise<PersonMatchRow[]> {
  const builder = from(client, "people")
    .select("id, first_name, source, claim_frozen, created_at")
    .eq("tenant_id", tenantId)
    .eq(contact.channel === "email" ? "email" : "phone_e164", contact.normalized)
    .order("created_at", { ascending: true });
  const data = await run(builder, "findPeopleByContact");
  return parseInternal(z.array(personMatchRowSchema), data ?? [], "findPeopleByContact");
}

const claimRowSchema = z.object({
  id: uuid,
  person_id: uuid,
  status: memberClaimStatusDbSchema,
});
export type ClaimRow = z.infer<typeof claimRowSchema>;

/** Every claim row bound to a verified contact (any status) — the conflict,
 * recycled-contact, and duplicate-needs_resolution checks all read this. */
export async function findClaimsByContact(
  client: KeloSupabaseClient,
  tenantId: string,
  normalizedContact: string,
): Promise<ClaimRow[]> {
  const data = await run(
    from(client, "person_claims")
      .select("id, person_id, status")
      .eq("tenant_id", tenantId)
      .eq("verified_contact", normalizedContact),
    "findClaimsByContact",
  );
  return parseInternal(z.array(claimRowSchema), data ?? [], "findClaimsByContact");
}

export type InsertClaimResult = { ok: true } | { ok: false; reason: "conflict" };

/**
 * Insert a claim. The partial-active uniques (0044) are the race backstop: a
 * concurrent second ACTIVE claim on the same person/contact loses with 23505,
 * which this function reports as `conflict` so the route can route the loser
 * to needs_resolution instead of 500ing. Every other failure is a defect.
 */
export async function insertPersonClaim(
  scope: MemberScope,
  client: KeloSupabaseClient,
  input: {
    verifiedContact: string;
    channel: "email" | "sms";
    status: "active" | "needs_resolution";
    claimedVia: "self_email" | "self_sms";
  },
): Promise<InsertClaimResult> {
  const { error } = await from(client, "person_claims").insert({
    tenant_id: scope.tenantId,
    person_id: scope.personId,
    verified_contact: input.verifiedContact,
    channel: input.channel,
    status: input.status,
    claimed_via: input.claimedVia,
  });
  if (error === null) return { ok: true };
  if (error.code === "23505") return { ok: false, reason: "conflict" };
  throw new Error(`insertPersonClaim query failed: ${error.message}`);
}

/**
 * The new-member signup path: a verified contact with NO person match becomes
 * a native people row, claimed in the same request. The phone column takes
 * the E.164 form (phone_e164 is generated from it, so the canonical identity
 * round-trips exactly).
 */
export async function createNativePerson(
  client: KeloSupabaseClient,
  tenantId: string,
  contact: NormalizedContact,
): Promise<{ id: string }> {
  const data = await run(
    from(client, "people")
      .insert({
        tenant_id: tenantId,
        email: contact.channel === "email" ? contact.normalized : null,
        phone: contact.channel === "sms" ? contact.normalized : null,
        first_name: null,
        source: "native",
      })
      .select("id")
      .limit(1),
    "createNativePerson",
  );
  const rows = parseInternal(z.array(z.object({ id: uuid })), data ?? [], "createNativePerson");
  const row = rows[0];
  if (row === undefined) throw new Error("createNativePerson: insert returned no row");
  return row;
}

// -- session minting ------------------------------------------------------------

export interface NewMemberSession {
  tokenHash: string;
  /** ISO instant — mint + 90 days. */
  expiresAt: string;
  /** ISO instant — mint + 12 months. */
  absoluteExpiresAt: string;
  platform: "web" | "ios" | "android";
  deviceLabel: string | null;
}

/** Persist a session. ONLY the sha256 token hash is stored — the raw `kmb_…`
 * token exists solely in the route layer and the one response/cookie. */
export async function insertMemberSession(
  scope: MemberScope,
  client: KeloSupabaseClient,
  session: NewMemberSession,
): Promise<{ id: string }> {
  const data = await run(
    from(client, "member_sessions")
      .insert({
        tenant_id: scope.tenantId,
        person_id: scope.personId,
        token_hash: session.tokenHash,
        expires_at: session.expiresAt,
        absolute_expires_at: session.absoluteExpiresAt,
        platform: session.platform,
        device_label: session.deviceLabel,
      })
      .select("id")
      .limit(1),
    "insertMemberSession",
  );
  const rows = parseInternal(z.array(z.object({ id: uuid })), data ?? [], "insertMemberSession");
  const row = rows[0];
  if (row === undefined) throw new Error("insertMemberSession: insert returned no row");
  return row;
}

// -- audit (append-only) ---------------------------------------------------------

export type MemberVerificationEventKind =
  | "otp_sent"
  | "claim_attempt"
  | "claim_conflict";

/** Append to the member auth/claim ledger. Hashes only; the table is
 * append-only for every application role (UPDATE/DELETE revoked, 0044). The
 * RPC itself appends otp_verified/otp_failed — routes never duplicate those. */
export async function appendMemberVerificationEvent(
  client: KeloSupabaseClient,
  tenantId: string,
  event: {
    kind: MemberVerificationEventKind;
    contactHash: string | null;
    ipHash: string | null;
    personId?: string | undefined;
  },
): Promise<void> {
  await run(
    from(client, "member_verification_events").insert({
      tenant_id: tenantId,
      kind: event.kind,
      contact_hash: event.contactHash,
      ip_hash: event.ipHash,
      person_id: event.personId ?? null,
    }),
    "appendMemberVerificationEvent",
  );
}

// -- dispatch (the existing transactional-send path) -----------------------------

const tenantNameRowSchema = z.object({ name: z.string() });

/** Studio name for the OTP message body (server-side; never from the client). */
export async function fetchTenantName(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const data = await run(
    from(client, "tenants").select("name").eq("id", tenantId).limit(1),
    "fetchTenantName",
  );
  const rows = parseInternal(z.array(tenantNameRowSchema), data ?? [], "fetchTenantName");
  return rows[0]?.name ?? null;
}

/**
 * Dispatch a member message through the EXISTING transactional path: a queued
 * comms_log row + a `comms.send` job (the 0039 receipt pattern). The ONE tick
 * drains it (invariant #4); the worker's canSend gate classifies a
 * non-campaign, non-dunning row as kind 'transactional' — consent-exempt and
 * quiet-hours-exempt, but still subject to suppression (hard bounce / SMS
 * STOP) — and the adapters dry-run until Resend/Twilio go live (owner gate
 * P3-2). The jobs insert mirrors app.enqueue_job's (kind, idempotency_key)
 * dedupe; a 23505 means the send is already queued, not a failure.
 */
export async function enqueueMemberMessage(
  client: KeloSupabaseClient,
  tenantId: string,
  message: {
    personId: string | null;
    channel: "email" | "sms";
    toAddress: string;
    subject: string | null;
    body: string;
    templateKey: string;
  },
): Promise<void> {
  const inserted = await run(
    from(client, "comms_log")
      .insert({
        tenant_id: tenantId,
        person_id: message.personId,
        channel: message.channel,
        direction: "outbound",
        template_key: message.templateKey,
        subject: message.subject,
        // body_preview is the complete v1 send body (cap 200, migration 0022).
        body_preview: message.body.slice(0, 200),
        to_address: message.toAddress,
        status: "queued",
      })
      .select("id")
      .limit(1),
    "enqueueMemberMessage.log",
  );
  const logs = parseInternal(
    z.array(z.object({ id: uuid })),
    inserted ?? [],
    "enqueueMemberMessage.log",
  );
  const log = logs[0];
  if (log === undefined) throw new Error("enqueueMemberMessage: comms_log insert returned no row");

  const { error } = await from(client, "jobs").insert({
    kind: "comms.send",
    payload: { comms_log_id: log.id },
    tenant_id: tenantId,
    idempotency_key: `comms.send:${log.id}`,
  });
  if (error !== null && error.code !== "23505") {
    throw new Error(`enqueueMemberMessage job insert failed: ${error.message}`);
  }
}

// -- staff-contact hygiene ---------------------------------------------------

/**
 * Is this email linked to an ACTIVE tenant_users staff member? Hygiene for
 * /auth/start (a staff contact gets a "use the staff app" note instead of an
 * OTP — §3.3), NOT a security control: the response is the neutral 202 either
 * way. Staff emails live in auth.users (not PostgREST-reachable), so the
 * check intersects the tenant's active tenant_users ids with the GoTrue admin
 * user list under the service client.
 */
export async function isStaffEmail(
  client: KeloSupabaseClient,
  tenantId: string,
  email: string,
): Promise<boolean> {
  const memberData = await run(
    from(client, "tenant_users").select("user_id").eq("tenant_id", tenantId).eq("status", "active"),
    "isStaffEmail.members",
  );
  const members = parseInternal(
    z.array(z.object({ user_id: uuid })),
    memberData ?? [],
    "isStaffEmail.members",
  );
  if (members.length === 0) return false;
  const staffIds = new Set(members.map((member) => member.user_id));

  const { data, error } = await (client as unknown as AuthAdminClient).auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error !== null) {
    throw new Error(`isStaffEmail listUsers failed: ${error.message}`);
  }
  const wanted = email.toLowerCase();
  return data.users.some(
    (user) => staffIds.has(user.id) && user.email?.toLowerCase() === wanted,
  );
}
