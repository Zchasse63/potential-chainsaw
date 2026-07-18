import type { GlofoxPlanType } from "@kelo/contracts";

/**
 * Shared mapper contract (plan-final §4 "The pipeline" step 2: TRANSFORM
 * validates and routes unknowns to import_quarantine — never silently
 * classifies; CLAUDE.md invariant #8). Mappers are PURE: parsed-contract input
 * → row objects + a quarantine list. No DB, no network, no clock — fully
 * deterministic. Each mapper file exports its own MAPPER_VERSION (the sync
 * layer records it in sync_runs).
 *
 * Row types mirror the migration-0008 columns plus later import-owned additions
 * (snake_case). Server-generated
 * columns (id, created_at, updated_at) are omitted; FK columns the sync layer
 * resolves only AFTER insert (person_id, grant_id) are optional and documented
 * at the field. Timestamptz fields are `Date` — timestamps were parsed once at
 * the Zod boundary (invariant #8); serialization is the sync layer's job.
 */

/**
 * A record the mapper refused to guess at. The sync layer persists these to
 * public.import_quarantine (the merge/mapping review queues) — quarantine is
 * NEVER a hard import failure.
 */
export interface QuarantineRow {
  /**
   * Glofox entity vocabulary, matching sync_state.entity / sync_runs.entity:
   * 'members' | 'memberships' | 'credits'.
   */
  readonly entity: string;
  /** The source record's Glofox _id — null when that is exactly what's missing. */
  readonly external_ref: string | null;
  /** The offending source object (evidence — never edited by the mapper). */
  readonly payload: unknown;
  readonly reason: string;
}

export interface MapperResult<Row> {
  readonly rows: Row[];
  readonly quarantine: QuarantineRow[];
}

/** Every mapper takes the tenant it is importing for. */
export interface MapperContext {
  readonly tenantId: string;
}

/** Blank Glofox strings import as NULL — never '' (a blank email would poison
 * the partial unique index with junk). The stored value itself is verbatim. */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim() === "" ? null : value;
}

/** Guard shared by all mappers: the Glofox _id is the import key, so a record
 * without one cannot be keyed — quarantine, never a row without identity. */
export function hasExternalId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// --- people (migration 0008) --------------------------------------------------

/** people row. Mappers set every import-owned column explicitly; the native
 * pipeline/cohort surface (lead_status, next_action, pipeline_owner,
 * first_activity_at, cohort_anchor_basis) stays NULL at import. */
export interface PersonRow {
  readonly tenant_id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly source: "native" | "glofox";
  readonly external_ref: string | null;
  readonly active: boolean;
  readonly source_created_at: Date | null;
  readonly first_activity_at: Date | null;
  readonly cohort_anchor_basis: string | null;
  readonly date_quality: "verified" | "unverified" | "suspect";
  readonly lead_status: string | null;
  readonly next_action: string | null;
  readonly pipeline_owner: string | null;
  readonly consent_email: boolean | null;
  readonly consent_sms: boolean | null;
  readonly consent_push: boolean | null;
  readonly membership_type: string | null;
  readonly membership_status: string | null;
  readonly user_membership_id: string | null;
  readonly membership_started_at: Date | null;
}

export type ExternalRefSystem = "glofox" | "stripe" | "aggregator";

/** person_external_refs row. */
export interface PersonExternalRefRow {
  readonly tenant_id: string;
  readonly system: ExternalRefSystem;
  readonly external_ref: string;
  /**
   * Resolved by the SYNC LAYER after the people upsert (join on
   * (tenant_id, external_ref)) — mappers never know the people.id uuid.
   */
  readonly person_id?: string;
}

// --- plan_catalog (migration 0008) --------------------------------------------

export type KeloPlanType = "recurring" | "unlimited" | "pack" | "drop_in" | "intro";

/** plan_catalog row — one per (membership, plan) pair. */
export interface PlanCatalogRow {
  readonly tenant_id: string;
  /** The Glofox MEMBERSHIP _id (the plan's parent — see the unique key). */
  readonly external_ref: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  /** Numeric plan code AS TEXT — joins transactions' metadata.plan_code. */
  readonly plan_code: string;
  readonly plan_name: string;
  readonly price: number | null;
  readonly glofox_type: GlofoxPlanType;
  readonly credits_granted: number | null;
  readonly duration_days: number | null;
  /**
   * ALWAYS null from mappers — the owner's A8 catalog mapping fills it
   * (phase-1 owner task) through the column-list update grant; NULL = unmapped.
   */
  readonly kelo_type: KeloPlanType | null;
  /** The source Glofox plan object, verbatim (re-derivation evidence). */
  readonly raw: unknown;
}

// --- credit_ledger (migration 0008) -------------------------------------------

export type CreditEntryType = "grant" | "debit" | "refund_credit" | "expire" | "adjust";

/**
 * credit_ledger row. Mappers emit ONLY 'grant' and 'debit' in this unit —
 * 'adjust' is a human act (reason + actor mandatory, CHECK-enforced),
 * 'refund_credit'/'expire' are emitted by later sync/billing processes.
 */
export interface CreditLedgerRow {
  readonly tenant_id: string;
  readonly person_id: string;
  readonly entry_type: CreditEntryType;
  readonly delta: number;
  /**
   * Set ONLY by the sync layer: mappers emit `grant_external_ref` on debit
   * rows and the sync layer joins it to the inserted grant row's id
   * (earliest-expiring-first lot attribution).
   */
  readonly grant_id?: string;
  /** Grants only; absent Glofox end_date imports as NULL = no_expiry (README §5). */
  readonly expires_at: Date | null;
  readonly source: "native" | "glofox";
  /** Grants only: the Glofox credit _id (the idempotent-reimport key). */
  readonly external_ref: string | null;
  /** Per-booking debits only: the booking that consumed this session. */
  readonly booking_external_ref: string | null;
  readonly reason: string | null;
  readonly actor_user_id: string | null;
  /** Debit rows only: the Glofox credit _id of the grant they consume. */
  readonly grant_external_ref?: string;
}
