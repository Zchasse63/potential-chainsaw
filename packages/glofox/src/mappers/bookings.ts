// sample: docs/glofox/samples/bookings.get.limit3.json
/**
 * Phase 1 · unit 3 — Glofox booking → public.glofox_bookings row (migration
 * 0009). Two endpoint-generation traps owned here:
 *  - time_start/time_finish/canceled_at are ISO-ish branch-local wall-time
 *    STRINGS (README §1) — converted with ctx.timezone, never guessed as UTC.
 *  - status is stored RAW. The vendor documents more statuses than the five
 *    observed live (SPEC "…"): an unknown status still emits its row (the
 *    generated status_known column reads false — VISIBLE) AND a quarantine
 *    row (FLAGGED). The known set comes from the contracts enum, the single
 *    source of truth — nothing declares it twice.
 */
import { glofoxBookingStatusSchema, type GlofoxBooking } from "@kelo/contracts";
import {
  blankToNull,
  branchWallTimeToUtc,
  MAPPER_VERSION,
  quarantine,
  type GlofoxBookingRow,
  type MapperContext,
  type MapperResult,
  type QuarantineRow,
} from "./facts-types.js";

export { MAPPER_VERSION };

const ENTITY = "glofox_bookings";

const KNOWN_STATUSES: ReadonlySet<string> = new Set(glofoxBookingStatusSchema.options);

export function mapBooking(
  booking: GlofoxBooking,
  ctx: MapperContext,
): MapperResult<GlofoxBookingRow> {
  const externalRef = blankToNull(booking._id);
  const personRef = blankToNull(booking.user_id);
  if (externalRef === null || personRef === null) {
    // No stable identity or no attendee → cannot upsert; quarantine the fact.
    const missing = externalRef === null ? "missing booking _id" : "missing booking user_id";
    return { row: null, quarantine: [quarantine(ENTITY, externalRef, missing, booking)] };
  }

  const quarantines: QuarantineRow[] = [];

  // Unknown statuses are kept verbatim and surfaced BOTH ways (invariant #8).
  if (!KNOWN_STATUSES.has(booking.status)) {
    quarantines.push(
      quarantine(ENTITY, externalRef, `unknown booking status: ${booking.status}`, booking),
    );
  }

  const timeStart = mapTimestamp(booking.time_start, "time_start", booking, ctx, quarantines);
  const timeFinish = mapTimestamp(booking.time_finish, "time_finish", booking, ctx, quarantines);
  const canceledAt =
    booking.canceled_at === null
      ? null
      : mapTimestamp(booking.canceled_at, "canceled_at", booking, ctx, quarantines);

  return {
    row: {
      tenant_id: ctx.tenantId,
      external_ref: externalRef,
      person_external_ref: personRef,
      session_external_ref: blankToNull(booking.event_id),
      booking_type: blankToNull(booking.type),
      model: blankToNull(booking.model),
      status: booking.status,
      attended: booking.attended,
      paid: booking.paid,
      payment_method: blankToNull(booking.payment_method),
      time_start: timeStart,
      time_finish: timeFinish,
      is_first: booking.is_first,
      is_from_waiting_list: booking.is_from_waiting_list,
      is_late_cancellation: booking.is_late_cancellation,
      guest_bookings: booking.guest_bookings,
      canceled_at: canceledAt,
      // Aggregator-channel candidate (must-answer #2): verbatim, null is fine —
      // the phase-1 distinct-value scan reads it as-imported.
      origin: booking.origin,
      raw: booking,
    },
    quarantine: quarantines,
  };
}

/**
 * Present-but-unparseable wall time → null the field AND quarantine: the row
 * stays importable (a booking without a parseable start is still a booking
 * fact) while the anomaly surfaces for review instead of passing silently.
 */
function mapTimestamp(
  value: string,
  field: string,
  booking: GlofoxBooking,
  ctx: MapperContext,
  quarantines: QuarantineRow[],
): Date | null {
  const parsed = branchWallTimeToUtc(value, ctx.timezone);
  if (parsed === null) {
    quarantines.push(
      quarantine(
        ENTITY,
        blankToNull(booking._id),
        `unparseable booking ${field}: ${JSON.stringify(value)}`,
        booking,
      ),
    );
  }
  return parsed;
}
