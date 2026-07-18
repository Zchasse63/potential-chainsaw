// sample: docs/glofox/samples/events.get.limit2.json
/**
 * Phase 1 · unit 3 — Glofox event → public.glofox_sessions row (migration
 * 0009). Imported FACTS only: capacity/booked/waiting are Glofox's numbers,
 * mirrored for the demand heatmap — the native engine's no-cached-counts
 * invariant (plan-final §2) does not apply to this mirror. time_start arrives
 * as int unix seconds, already a Date from the Zod boundary
 * (contracts glofoxUnixTimestamp), so no timezone work happens here.
 */
import type { GlofoxEventSession } from "@kelo/contracts";
import {
  blankToNull,
  MAPPER_VERSION,
  quarantine,
  type GlofoxSessionRow,
  type MapperContext,
  type MapperResult,
} from "./facts-types.js";

export { MAPPER_VERSION };

const ENTITY = "glofox_sessions";

export function mapEvent(
  event: GlofoxEventSession,
  ctx: MapperContext,
): MapperResult<GlofoxSessionRow> {
  // No stable external identity → cannot upsert; quarantine the whole fact.
  if (blankToNull(event._id) === null) {
    return {
      row: null,
      quarantine: [quarantine(ENTITY, null, "missing event _id", event)],
    };
  }

  return {
    row: {
      tenant_id: ctx.tenantId,
      external_ref: event._id,
      program_external_ref: blankToNull(event.program_id),
      name: blankToNull(event.name),
      time_start: event.time_start,
      duration_minutes: event.duration,
      capacity: event.size,
      booked_count: event.booked,
      waiting_count: event.waiting,
      trainer_refs: event.trainers,
      facility_ref: blankToNull(event.facility),
      is_private: event.private,
      status: blankToNull(event.status),
      raw: event,
    },
    quarantine: [],
  };
}
