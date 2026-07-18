// samples: docs/glofox/samples/events.get.limit2.json · bookings.get.limit3.json · analytics.report.30d.json
/**
 * Phase 1 · unit 3 — shared types for the bookings/sessions/transactions
 * fact mappers (migration 0009). LOCAL COPIES of MapperResult/QuarantineRow —
 * merged with mappers/types.ts by the director at integration (unit 1.2 owns
 * that file; do not edit it here).
 *
 * Mappers are PURE and deterministic: parsed contracts in, rows + quarantine
 * out; no I/O, no clock, no randomness. Unknowns are never silently
 * classified (CLAUDE.md invariant #8) — they surface as quarantine rows, and
 * where a row is still usable it is emitted VISIBLY flagged alongside the
 * quarantine entry.
 */
import type { ClassifiedGlofoxEvent } from "@kelo/contracts";

/** Bump on any mapping-logic change; the sync layer records it per run. */
export const MAPPER_VERSION = 1;

/** Per-tenant mapping context (no hidden globals — purity lives here). */
export interface MapperContext {
  readonly tenantId: string;
  /**
   * IANA timezone of the tenant's Glofox branch (locations.timezone; live
   * value `America/New_York` per docs/glofox/samples/branch.get.json). The
   * bookings/transactions endpoint generations emit ISO-ish wall-time STRINGS
   * ("2026-07-17 04:32:52", README §1) with no offset — they are branch-local
   * wall time (a 07:00 class is 07:00 in the studio, not UTC), so conversion
   * to an instant requires the branch zone. Throws RangeError on a bogus zone:
   * a config defect, not a data row to quarantine.
   */
  readonly timezone: string;
}

/**
 * One import_quarantine insert (migration 0007), minus server columns
 * (id, tenant_id, sync_run_id, status/timestamps — the sync layer stamps
 * those). `payload` is the offending source object, kept as evidence.
 */
export interface QuarantineRow {
  readonly entity: string;
  readonly external_ref: string | null;
  readonly reason: string;
  readonly payload: unknown;
}

/**
 * Mapper output: the upsertable row (null when the source is unusable) plus
 * zero or more quarantine rows. Row AND quarantine can both be present — e.g.
 * an unknown booking status is stored (status_known=false) AND flagged.
 */
export interface MapperResult<TRow> {
  readonly row: TRow | null;
  readonly quarantine: readonly QuarantineRow[];
}

/** Insert shape for public.glofox_sessions, minus server columns (id, created_at, updated_at). */
export interface GlofoxSessionRow {
  readonly tenant_id: string;
  readonly external_ref: string;
  readonly program_external_ref: string | null;
  readonly name: string | null;
  readonly time_start: Date | null;
  readonly duration_minutes: number | null;
  readonly capacity: number | null;
  readonly booked_count: number | null;
  readonly waiting_count: number | null;
  readonly trainer_refs: readonly string[];
  readonly facility_ref: string | null;
  readonly is_private: boolean | null;
  readonly status: string | null;
  readonly raw: unknown;
}

/** Insert shape for public.glofox_bookings, minus server columns and the generated status_known. */
export interface GlofoxBookingRow {
  readonly tenant_id: string;
  readonly external_ref: string;
  readonly person_external_ref: string;
  readonly session_external_ref: string | null;
  readonly booking_type: string | null;
  readonly model: string | null;
  /** RAW Glofox status string — never rejected, see migration 0009. */
  readonly status: string;
  readonly attended: boolean | null;
  readonly paid: boolean | null;
  readonly payment_method: string | null;
  readonly time_start: Date | null;
  readonly time_finish: Date | null;
  readonly is_first: boolean | null;
  readonly is_from_waiting_list: boolean | null;
  readonly is_late_cancellation: boolean | null;
  readonly guest_bookings: number | null;
  readonly canceled_at: Date | null;
  readonly origin: string | null;
  readonly raw: unknown;
}

/** Insert shape for public.glofox_transactions, minus server columns (id, created_at, updated_at). */
export interface GlofoxTransactionRow {
  readonly tenant_id: string;
  readonly external_ref: string;
  /** The wrapper key — only "StripeCharge" reaches a row (unknown wrappers quarantine). */
  readonly provider: string;
  readonly transaction_status: "PAID" | "ERROR" | "REFUNDED";
  readonly amount: number;
  readonly currency: string;
  readonly amount_refunded: number | null;
  /** The RAW metadata.glofox_event value, kept verbatim. */
  readonly glofox_event: string | null;
  /** Mirrors the contracts classifier vocabulary (single source of truth). */
  readonly glofox_event_class: ClassifiedGlofoxEvent;
  readonly person_external_ref: string | null;
  readonly plan_code: string | null;
  readonly stripe_subscription_id: string | null;
  readonly payment_method: string | null;
  readonly invoice_external_ref: string | null;
  readonly event_external_ref: string | null;
  readonly transaction_created_at: Date | null;
  readonly raw: unknown;
}

export function quarantine(
  entity: string,
  externalRef: string | null,
  reason: string,
  payload: unknown,
): QuarantineRow {
  return { entity, external_ref: externalRef, reason, payload };
}

/** Empty/whitespace strings are not references — null them (documented normalization, not a guess). */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Branch-local wall time ("2023-12-17 07:00:00") → UTC instant in `timeZone`.
 * Returns null when the string is not in the observed ISO-ish format — the
 * caller emits the row with a null timestamp AND quarantines it (visible and
 * flagged, never guessed). DST-safe to the second via a two-pass Intl offset
 * refinement; the nonexistent wall times of a spring-forward gap land on the
 * post-transition offset, which is the honest reading of vendor data.
 */
export function branchWallTimeToUtc(value: string, timeZone: string): Date | null {
  const match = WALL_TIME_RE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const wallAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
  );
  if (Number.isNaN(wallAsUtc)) return null;
  const firstOffset = zoneOffsetMs(wallAsUtc, timeZone);
  const secondOffset = zoneOffsetMs(wallAsUtc - firstOffset, timeZone);
  return new Date(wallAsUtc - secondOffset);
}

/** Offset (wall − UTC) of `timeZone` at the whole-second instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const wallAsUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return wallAsUtc - utcMs;
}
