import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import type { TenantRole } from "./data.js";

/**
 * Launch-readiness reads + gate computation (Phase 7 · unit 7.1b; plan-ux-final
 * §G "Assisted onboarding"). EVERY read is through the user-scoped client (RLS
 * enforced, invariant #7) — a foreign tenant simply yields zero rows, which for
 * an existence gate is an HONEST fail, never a pass.
 *
 * NO new schema ships with this unit: every input already exists (reconciliations
 * 0011, payments 0033, waiver_versions 0028, resources/offering_templates 0027,
 * plan_catalog 0008, tenant_users 0002, comms_log 0022, bookings 0040). An
 * acknowledgment is an append-only `audit_events` row (0002), NOT a new table —
 * acks are read back by scanning audit_events for the gate key, latest wins.
 *
 * Completion is derived from REAL data (UX §G: "completion detected from real
 * data, not self-report") — the API never trusts a self-reported "done" flag.
 */

interface QueryError {
  message: string;
  code?: string;
}
interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

/** The exact PostgREST builder surface the readiness reads use. */
interface TableBuilder extends PromiseLike<QueryResult> {
  select(columns?: string): TableBuilder;
  insert(values: unknown): TableBuilder;
  eq(column: string, value: unknown): TableBuilder;
  in(column: string, values: readonly unknown[]): TableBuilder;
  order(column: string, options?: { ascending?: boolean }): TableBuilder;
  limit(count: number): TableBuilder;
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

// ---------------------------------------------------------------------------
// Gate + stage registry (plan-ux-final §G).
// ---------------------------------------------------------------------------

export type GateStatus = "pass" | "fail" | "warn";

export type GateKey =
  | "reconciliation_green"
  | "payment_verified"
  | "active_waiver"
  | "resources_configured"
  | "plans_configured"
  | "roles_assigned"
  | "delivery_tested"
  | "native_booking_exercised";

export type StageKey =
  | "studio_team"
  | "rooms_services"
  | "plans_prices_tax"
  | "import_reconciliation"
  | "payments_waivers_launch";

interface GateDef {
  key: GateKey;
  /** A HARD gate blocks launch on 'fail' (UX §G hard-gate list). */
  hard: boolean;
  stage: StageKey;
}

/**
 * The gate registry. HARD gates are the UX §G launch hard-gates. A hard gate is
 * pass/fail EXCEPT roles_assigned, which is pass (a second member exists) or
 * WARN (documented single-operator studio) — a single operator is a legitimate
 * launch posture, so it warns rather than failing. Soft (non-hard) gates never
 * fail: they are pass or warn, and only soft warns are acknowledgeable.
 */
export const GATE_DEFS: readonly GateDef[] = [
  { key: "roles_assigned", hard: true, stage: "studio_team" },
  { key: "resources_configured", hard: true, stage: "rooms_services" },
  { key: "native_booking_exercised", hard: false, stage: "rooms_services" },
  { key: "plans_configured", hard: true, stage: "plans_prices_tax" },
  { key: "reconciliation_green", hard: true, stage: "import_reconciliation" },
  { key: "payment_verified", hard: true, stage: "payments_waivers_launch" },
  { key: "active_waiver", hard: true, stage: "payments_waivers_launch" },
  { key: "delivery_tested", hard: true, stage: "payments_waivers_launch" },
];

interface StageDef {
  key: StageKey;
  label: string;
  gateKeys: readonly GateKey[];
}

/** The five UX §G stages, in checklist order. */
export const STAGE_DEFS: readonly StageDef[] = [
  { key: "studio_team", label: "Studio & team", gateKeys: ["roles_assigned"] },
  {
    key: "rooms_services",
    label: "Rooms & services",
    gateKeys: ["resources_configured", "native_booking_exercised"],
  },
  { key: "plans_prices_tax", label: "Plans, prices & tax", gateKeys: ["plans_configured"] },
  {
    key: "import_reconciliation",
    label: "Import & reconciliation",
    gateKeys: ["reconciliation_green"],
  },
  {
    key: "payments_waivers_launch",
    label: "Payments, waivers & launch readiness",
    gateKeys: ["payment_verified", "active_waiver", "delivery_tested"],
  },
];

const GATE_DEF_BY_KEY = new Map<GateKey, GateDef>(GATE_DEFS.map((g) => [g.key, g]));

export function gateDef(key: GateKey): GateDef | undefined {
  return GATE_DEF_BY_KEY.get(key);
}

export function isGateKey(value: string): value is GateKey {
  return GATE_DEF_BY_KEY.has(value as GateKey);
}

export interface GateEvidence {
  counts: Record<string, number>;
  /** ISO of the newest input that produced the gate result, or null when none. */
  as_of: string | null;
  /** Human-readable note (e.g. WHY a gate failed), or null. */
  detail: string | null;
}

export interface GateResult {
  status: GateStatus;
  evidence: GateEvidence;
}

// ---------------------------------------------------------------------------
// Per-gate row schemas (validated at the DB boundary).
// ---------------------------------------------------------------------------

const ts = z.string().min(1);

const reconciliationRow = z.object({
  entity: z.string(),
  status: z.enum(["match", "drift", "error"]),
  checked_at: ts,
});
const paymentRow = z.object({ id: z.string().uuid(), created_at: ts });
const waiverRow = z.object({
  id: z.string().uuid(),
  effective_from: ts.nullable(),
  created_at: ts.nullable(),
});
const idRow = z.object({ id: z.string().uuid() });
const memberRow = z.object({ user_id: z.string().uuid(), role: z.string() });
const commsRow = z.object({ id: z.string().uuid(), created_at: ts });
const bookingRow = z.object({ id: z.string().uuid(), created_at: ts });

// ---------------------------------------------------------------------------
// Per-gate compute functions. Each reads ONLY what it needs, under RLS.
// ---------------------------------------------------------------------------

/**
 * reconciliation_green — the LATEST reconciliation run per entity has no
 * critical/unexplained variance (status 'drift' or 'error'). ABSENCE IS NEVER A
 * PASS: with no reconciliation run at all the gate FAILS (an un-reconciled ledger
 * is not "green").
 */
async function computeReconciliationGreen(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const recent = await rows(
    from(client, "reconciliations")
      .select("entity, status, checked_at")
      .eq("tenant_id", tenantId)
      .order("checked_at", { ascending: false })
      .limit(200),
    reconciliationRow,
    "reconciliation_green",
  );
  if (recent.length === 0) {
    return {
      status: "fail",
      evidence: {
        counts: { runs: 0, entities: 0, variances: 0 },
        as_of: null,
        detail: "no reconciliation run exists — an un-reconciled ledger cannot be green",
      },
    };
  }
  // Rows are newest-first; the first row seen per entity is its latest run.
  const latestByEntity = new Map<string, (typeof recent)[number]>();
  for (const row of recent) {
    if (!latestByEntity.has(row.entity)) latestByEntity.set(row.entity, row);
  }
  const variances = [...latestByEntity.values()].filter(
    (r) => r.status === "drift" || r.status === "error",
  );
  const asOf = recent[0]?.checked_at ?? null;
  if (variances.length > 0) {
    return {
      status: "fail",
      evidence: {
        counts: { runs: recent.length, entities: latestByEntity.size, variances: variances.length },
        as_of: asOf,
        detail: `latest reconciliation shows unresolved variance for: ${variances
          .map((v) => v.entity)
          .join(", ")}`,
      },
    };
  }
  return {
    status: "pass",
    evidence: {
      counts: { runs: recent.length, entities: latestByEntity.size, variances: 0 },
      as_of: asOf,
      detail: null,
    },
  };
}

/**
 * payment_verified — at least one SUCCEEDED payment exists. This will honestly
 * FAIL until the first real Stripe payment lands (P0-5); a launch without a
 * verified charge path is not ready.
 */
async function computePaymentVerified(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const succeeded = await rows(
    from(client, "payments")
      .select("id, created_at")
      .eq("tenant_id", tenantId)
      .eq("status", "succeeded")
      .order("created_at", { ascending: false })
      .limit(1),
    paymentRow,
    "payment_verified",
  );
  const newest = succeeded[0];
  if (newest === undefined) {
    return {
      status: "fail",
      evidence: {
        counts: { succeeded: 0 },
        as_of: null,
        detail: "no SUCCEEDED payment yet — take one live/test charge to verify the money path",
      },
    };
  }
  return {
    status: "pass",
    evidence: { counts: { succeeded: 1 }, as_of: newest.created_at, detail: null },
  };
}

/** active_waiver — an active waiver_versions row exists (one per tenant, by index). */
async function computeActiveWaiver(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const active = await rows(
    from(client, "waiver_versions")
      .select("id, effective_from, created_at")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .limit(1),
    waiverRow,
    "active_waiver",
  );
  const row = active[0];
  if (row === undefined) {
    return {
      status: "fail",
      evidence: {
        counts: { active: 0 },
        as_of: null,
        detail: "no active waiver version — publish one before launch",
      },
    };
  }
  return {
    status: "pass",
    evidence: { counts: { active: 1 }, as_of: row.effective_from ?? row.created_at, detail: null },
  };
}

/** resources_configured — at least one active resource AND one active offering template. */
async function computeResourcesConfigured(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const [resources, offerings] = await Promise.all([
    rows(
      from(client, "resources")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .limit(1),
      idRow,
      "resources_configured.resources",
    ),
    rows(
      from(client, "offering_templates")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .limit(1),
      idRow,
      "resources_configured.offering_templates",
    ),
  ]);
  const hasResource = resources.length > 0;
  const hasOffering = offerings.length > 0;
  const counts = { resources: resources.length, offering_templates: offerings.length };
  if (hasResource && hasOffering) {
    return { status: "pass", evidence: { counts, as_of: null, detail: null } };
  }
  const missing = [
    ...(hasResource ? [] : ["a resource (room/equipment)"]),
    ...(hasOffering ? [] : ["an offering template"]),
  ];
  return {
    status: "fail",
    evidence: { counts, as_of: null, detail: `configure ${missing.join(" and ")}` },
  };
}

/** plans_configured — at least one active (sellable) plan_catalog item. */
async function computePlansConfigured(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const plans = await rows(
    from(client, "plan_catalog")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .limit(1),
    idRow,
    "plans_configured",
  );
  if (plans.length === 0) {
    return {
      status: "fail",
      evidence: {
        counts: { plans: 0 },
        as_of: null,
        detail: "no active plan/catalog item to sell",
      },
    };
  }
  return { status: "pass", evidence: { counts: { plans: 1 }, as_of: null, detail: null } };
}

/**
 * roles_assigned — HARD gate, but a single-operator studio is a legitimate
 * launch posture, so it WARNS (documented) rather than failing. Passes when a
 * second active member exists; warns when the owner is the only active member.
 * (It cannot reach zero — the owner is always present.)
 */
async function computeRolesAssigned(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  // NB: distinct from resolveTenant's membership read, which filters user_id;
  // this reads the WHOLE active roster for the tenant.
  const members = await rows(
    from(client, "tenant_users")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .eq("status", "active"),
    memberRow,
    "roles_assigned",
  );
  const distinct = new Set(members.map((m) => m.user_id)).size;
  if (distinct > 1) {
    return {
      status: "pass",
      evidence: { counts: { active_members: distinct }, as_of: null, detail: null },
    };
  }
  return {
    status: "warn",
    evidence: {
      counts: { active_members: distinct },
      as_of: null,
      detail: "single-operator studio — no delegate to cover the owner (acceptable, acknowledge to proceed)",
    },
  };
}

/** delivery_tested — at least one comms send reached a terminal delivered/sent state. */
async function computeDeliveryTested(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const delivered = await rows(
    from(client, "comms_log")
      .select("id, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["sent", "delivered"])
      .order("created_at", { ascending: false })
      .limit(1),
    commsRow,
    "delivery_tested",
  );
  const newest = delivered[0];
  if (newest === undefined) {
    return {
      status: "fail",
      evidence: {
        counts: { delivered: 0 },
        as_of: null,
        detail: "no delivered/sent message yet — send a test receipt/message to verify delivery",
      },
    };
  }
  return {
    status: "pass",
    evidence: { counts: { delivered: 1 }, as_of: newest.created_at, detail: null },
  };
}

/**
 * native_booking_exercised — WARN-level (non-hard): at least one native booking
 * row exists. Not required for launch, but a studio that has never rung a native
 * booking gets a nudge (warn), and an operator may acknowledge it.
 */
async function computeNativeBookingExercised(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<GateResult> {
  const booked = await rows(
    from(client, "bookings")
      .select("id, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["booked", "checked_in"])
      .order("created_at", { ascending: false })
      .limit(1),
    bookingRow,
    "native_booking_exercised",
  );
  const newest = booked[0];
  if (newest === undefined) {
    return {
      status: "warn",
      evidence: {
        counts: { bookings: 0 },
        as_of: null,
        detail: "no native booking rung yet — exercise the booking flow before opening",
      },
    };
  }
  return {
    status: "pass",
    evidence: { counts: { bookings: 1 }, as_of: newest.created_at, detail: null },
  };
}

const GATE_COMPUTERS: Record<
  GateKey,
  (client: KeloSupabaseClient, tenantId: string) => Promise<GateResult>
> = {
  reconciliation_green: computeReconciliationGreen,
  payment_verified: computePaymentVerified,
  active_waiver: computeActiveWaiver,
  resources_configured: computeResourcesConfigured,
  plans_configured: computePlansConfigured,
  roles_assigned: computeRolesAssigned,
  delivery_tested: computeDeliveryTested,
  native_booking_exercised: computeNativeBookingExercised,
};

export async function computeGate(
  client: KeloSupabaseClient,
  tenantId: string,
  key: GateKey,
): Promise<GateResult> {
  return GATE_COMPUTERS[key](client, tenantId);
}

export interface ComputedGate {
  key: GateKey;
  hard: boolean;
  status: GateStatus;
  evidence: GateEvidence;
}

/** Compute every gate (registry order preserved). */
export async function computeAllGates(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<ComputedGate[]> {
  return Promise.all(
    GATE_DEFS.map(async (def) => {
      const result = await computeGate(client, tenantId, def.key);
      return { key: def.key, hard: def.hard, status: result.status, evidence: result.evidence };
    }),
  );
}

// ---------------------------------------------------------------------------
// Acknowledgments — append-only audit_events rows (NO new schema).
// ---------------------------------------------------------------------------

/** The audit action that marks a readiness-gate acknowledgment. */
export const ACK_ACTION = "readiness.gate.acknowledged";
export const ACK_TARGET_TYPE = "readiness_gate";

export interface GateAck {
  at: string;
  note: string;
}

const ackRow = z.object({
  target_id: z.string().nullable(),
  metadata: z.record(z.unknown()),
  created_at: ts,
});

/**
 * Read the latest acknowledgment per gate by scanning audit_events for the ack
 * action, newest-first (latest wins). The ack IS the audit note — there is no
 * separate ack table.
 */
export async function fetchGateAcks(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<Map<GateKey, GateAck>> {
  const events = await rows(
    from(client, "audit_events")
      .select("target_id, metadata, created_at")
      .eq("tenant_id", tenantId)
      .eq("action", ACK_ACTION)
      .order("created_at", { ascending: false })
      .limit(500),
    ackRow,
    "fetchGateAcks",
  );
  const byGate = new Map<GateKey, GateAck>();
  for (const ev of events) {
    const target = ev.target_id;
    if (target === null || !isGateKey(target) || byGate.has(target)) continue;
    const note = typeof ev.metadata.note === "string" ? ev.metadata.note : "";
    byGate.set(target, { at: ev.created_at, note });
  }
  return byGate;
}

export interface WriteGateAckInput {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  gateKey: GateKey;
  note: string;
}

/**
 * Write an acknowledgment as an append-only audit_events row. actor_user_id is
 * ALWAYS the verified session user (never client-supplied); the DB WITH CHECK is
 * the backstop. Acknowledge ≠ resolve (UX §F): this records that the operator
 * saw the warn; it does NOT change the gate's computed status.
 */
export async function writeGateAck(
  client: KeloSupabaseClient,
  input: WriteGateAckInput,
): Promise<GateAck> {
  const created_at = new Date().toISOString();
  const { error } = await from(client, "audit_events").insert({
    tenant_id: input.tenantId,
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    action: ACK_ACTION,
    target_type: ACK_TARGET_TYPE,
    target_id: input.gateKey,
    metadata: { note: input.note },
    created_at,
  });
  if (error !== null) throw new Error(`writeGateAck query failed: ${error.message}`);
  return { at: created_at, note: input.note };
}
