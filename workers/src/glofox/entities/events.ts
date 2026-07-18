import { glofoxEventSessionSchema } from "@kelo/contracts";
import { FACTS_MAPPER_VERSION, mapEvent, type GlofoxSessionRow } from "@kelo/glofox";
import { extractStyleARows, styleAHasNextPage, withQuery } from "../envelopes.js";
import type { EntitySpec, SyncWindow } from "../types.js";
import { iso, strictRow } from "./shared.js";

/**
 * Events (class sessions) sync — Style A FULL LIST. The events endpoint takes
 * no date/modified params in our client (packages/glofox/src/endpoints.ts:
 * events.list accepts PageParams only), so there is no rolling window to
 * request: the run imports the full event list and candidate/committed are set
 * to the run start ("schedule known-current as of"). plausible_zero = false:
 * an operating studio never has zero events.
 */

const PAGE_LIMIT = 100;
const ENTITY = "events";

export const eventsSpec: EntitySpec<GlofoxSessionRow> = {
  entity: ENTITY,
  mapperVersion: FACTS_MAPPER_VERSION,
  defaults: { plausibleZero: false, emptyAlarmThreshold: 3 },
  fullListEveryRun: true,
  needsTimezone: true, // facts MapperContext requires it (unused by mapEvent itself)

  windows: (_state, ctx) => [{ start: null, end: ctx.now() }],

  pages: async function* (_pool, client, _window, ctx) {
    if (ctx.branchId === undefined) throw new Error("events sync requires ctx.branchId");
    let page = 1;
    for (;;) {
      const query = { page, limit: PAGE_LIMIT };
      const path = withQuery(`/2.0/branches/${encodeURIComponent(ctx.branchId)}/events`, query);
      const payload = await client.fetch(path);
      yield {
        endpoint: "/2.0/branches/{id}/events",
        requestMeta: { method: "GET", path, query, page },
        payload,
      };
      if (!styleAHasNextPage(payload)) return;
      page += 1;
    }
  },

  extractRows: extractStyleARows,

  mapRow: (rawRow, mapCtx) => {
    const { parsed, quarantine } = strictRow(glofoxEventSessionSchema, ENTITY, rawRow);
    if (parsed === null) return { rows: [], quarantine: [...quarantine] };
    const result = mapEvent(parsed, mapCtx);
    return {
      rows: result.row === null ? [] : [result.row],
      quarantine: [...result.quarantine],
    };
  },

  upsertBatch: async (tx, rows, ctx) => {
    for (const row of rows) {
      await tx.query(
        `insert into public.glofox_sessions (
           tenant_id, external_ref, program_external_ref, name, time_start, duration_minutes,
           capacity, booked_count, waiting_count, trainer_refs, facility_ref, is_private, status, raw
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (tenant_id, external_ref)
         do update set
           program_external_ref = excluded.program_external_ref,
           name = excluded.name,
           time_start = excluded.time_start,
           duration_minutes = excluded.duration_minutes,
           capacity = excluded.capacity,
           booked_count = excluded.booked_count,
           waiting_count = excluded.waiting_count,
           trainer_refs = excluded.trainer_refs,
           facility_ref = excluded.facility_ref,
           is_private = excluded.is_private,
           status = excluded.status,
           raw = excluded.raw`,
        [
          ctx.tenantId,
          row.external_ref,
          row.program_external_ref,
          row.name,
          iso(row.time_start),
          row.duration_minutes,
          row.capacity,
          row.booked_count,
          row.waiting_count,
          JSON.stringify(row.trainer_refs),
          row.facility_ref,
          row.is_private,
          row.status,
          JSON.stringify(row.raw ?? null),
        ],
      );
    }
    return { upserted: rows.length, quarantine: [] };
  },

  candidateFor: (window: SyncWindow) => window.end,
};
