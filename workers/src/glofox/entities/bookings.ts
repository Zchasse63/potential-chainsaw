import { glofoxBookingSchema } from "@kelo/contracts";
import { FACTS_MAPPER_VERSION, mapBooking, type GlofoxBookingRow } from "@kelo/glofox";
import { extractStyleBRows, styleBNextPage, toUnixSeconds, withQuery } from "../envelopes.js";
import type { EntitySpec, SyncWindow } from "../types.js";
import { iso, strictRow } from "./shared.js";

/**
 * Bookings sync — INCREMENTAL (README §7.1: `modified_start_date` is the
 * watermark param). Window = [committed − 5-minute overlap guard, now] (same
 * guard as members: absorbs vendor modified-clock skew; upserts are
 * idempotent). A null committed watermark = full backfill. Style B pagination
 * (meta.totalCount page math).
 *
 * The mapper needs the branch timezone for wall-time strings — resolved from
 * the tenant's locations row (external_ref = branch) by the pipeline, falling
 * back to branch.get() with a logged warning.
 *
 * plausible_zero = false: zero modified bookings across every window for
 * consecutive runs is freeze-shaped.
 */

const OVERLAP_GUARD_MS = 5 * 60 * 1000; // 5 minutes (same guard as members)
const PAGE_LIMIT = 100;
const ENTITY = "bookings";

export const bookingsSpec: EntitySpec<GlofoxBookingRow> = {
  entity: ENTITY,
  mapperVersion: FACTS_MAPPER_VERSION,
  defaults: { plausibleZero: false, emptyAlarmThreshold: 3 },
  fullListEveryRun: false,
  needsTimezone: true,

  windows: (state, ctx) => {
    const end = ctx.now();
    const committed =
      state.committed_watermark === null ? null : new Date(state.committed_watermark);
    return [
      {
        start: committed === null ? null : new Date(committed.getTime() - OVERLAP_GUARD_MS),
        end,
      },
    ];
  },

  pages: async function* (_pool, client, window, ctx) {
    if (ctx.branchId === undefined) throw new Error("bookings sync requires ctx.branchId");
    const firstPage = 1;
    let page = firstPage;
    for (;;) {
      const query: Record<string, string | number | boolean> = { page, limit: PAGE_LIMIT };
      if (window.start !== null) query["modified_start_date"] = toUnixSeconds(window.start);
      const path = withQuery(`/2.2/branches/${encodeURIComponent(ctx.branchId)}/bookings`, query);
      const payload = await client.fetch(path);
      yield {
        endpoint: "/2.2/branches/{id}/bookings",
        requestMeta: { method: "GET", path, query, page },
        payload,
      };
      const next = styleBNextPage(payload, page, firstPage);
      if (next === null) return;
      page = next;
    }
  },

  extractRows: extractStyleBRows,

  mapRow: (rawRow, mapCtx) => {
    const { parsed, quarantine } = strictRow(glofoxBookingSchema, ENTITY, rawRow);
    if (parsed === null) return { rows: [], quarantine: [...quarantine] };
    const result = mapBooking(parsed, mapCtx);
    return {
      rows: result.row === null ? [] : [result.row],
      quarantine: [...result.quarantine],
    };
  },

  upsertBatch: async (tx, rows, ctx) => {
    for (const row of rows) {
      await tx.query(
        `insert into public.glofox_bookings (
           tenant_id, external_ref, person_external_ref, session_external_ref, booking_type,
           model, status, attended, paid, payment_method, time_start, time_finish, is_first,
           is_from_waiting_list, is_late_cancellation, guest_bookings, canceled_at, origin, raw
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (tenant_id, external_ref)
         do update set
           person_external_ref = excluded.person_external_ref,
           session_external_ref = excluded.session_external_ref,
           booking_type = excluded.booking_type,
           model = excluded.model,
           status = excluded.status,
           attended = excluded.attended,
           paid = excluded.paid,
           payment_method = excluded.payment_method,
           time_start = excluded.time_start,
           time_finish = excluded.time_finish,
           is_first = excluded.is_first,
           is_from_waiting_list = excluded.is_from_waiting_list,
           is_late_cancellation = excluded.is_late_cancellation,
           guest_bookings = excluded.guest_bookings,
           canceled_at = excluded.canceled_at,
           origin = excluded.origin,
           raw = excluded.raw`,
        [
          ctx.tenantId,
          row.external_ref,
          row.person_external_ref,
          row.session_external_ref,
          row.booking_type,
          row.model,
          row.status,
          row.attended,
          row.paid,
          row.payment_method,
          iso(row.time_start),
          iso(row.time_finish),
          row.is_first,
          row.is_from_waiting_list,
          row.is_late_cancellation,
          row.guest_bookings,
          iso(row.canceled_at),
          row.origin,
          JSON.stringify(row.raw ?? null),
        ],
      );
    }
    return { upserted: rows.length, quarantine: [] };
  },

  candidateFor: (window: SyncWindow) => window.end,
};
