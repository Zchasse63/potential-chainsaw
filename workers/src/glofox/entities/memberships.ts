import { glofoxMembershipSchema } from "@kelo/contracts";
import { CATALOG_MAPPER_VERSION, mapMembership, type PlanCatalogRow } from "@kelo/glofox";
import { extractStyleARows, styleAHasNextPage, withQuery } from "../envelopes.js";
import type { EntitySpec, SyncWindow } from "../types.js";
import { strictRow } from "./shared.js";

/**
 * Memberships (the plan catalog) sync — FULL LIST every run (6 catalog items;
 * no watermark semantics: candidate/committed are set to the run start, i.e.
 * "catalog known-current as of"). Style A pagination runs once for the public
 * catalog and once for private=true; rows are deduped by catalog _id across
 * both passes before mapping.
 *
 * kelo_type is OWNER-OWNED (the A8 mapping, edited through the column-list
 * grant): the upsert's DO UPDATE SET excludes it — re-import NEVER overwrites
 * the owner's mapping. plausible_zero = false: an empty catalog is never
 * plausible for a live studio.
 */

const PAGE_LIMIT = 100;
const ENTITY = "memberships";

// Keep raw payloads byte-for-byte faithful for glofox_raw while supplying the
// pipeline a deduped logical row stream. `pages` stages each payload's rows in
// this identity-keyed map; `extractRows` still validates the original envelope.
const dedupedRowsByPayload = new WeakMap<object, unknown[]>();

function stageDedupedRows(payload: unknown, seenIds: Set<string>): void {
  if (typeof payload !== "object" || payload === null) return;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return;

  const rows = data.filter((row) => {
    if (typeof row !== "object" || row === null) return true;
    const id = (row as { _id?: unknown })._id;
    if (typeof id !== "string") return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  dedupedRowsByPayload.set(payload, rows);
}

export const membershipsSpec: EntitySpec<PlanCatalogRow> = {
  entity: ENTITY,
  mapperVersion: CATALOG_MAPPER_VERSION,
  defaults: { plausibleZero: false, emptyAlarmThreshold: 3 },
  fullListEveryRun: true,
  needsTimezone: false,

  windows: (_state, ctx) => [{ start: null, end: ctx.now() }],

  pages: async function* (_pool, client) {
    const seenIds = new Set<string>();
    for (const privateCatalog of [undefined, true] as const) {
      let page = 1;
      for (;;) {
        const query: Record<string, string | number | boolean> =
          privateCatalog === true
            ? { private: true, page, limit: PAGE_LIMIT }
            : { page, limit: PAGE_LIMIT };
        const payload = await client.fetch(withQuery("/2.0/memberships", query));
        stageDedupedRows(payload, seenIds);
        yield {
          endpoint: "/2.0/memberships",
          requestMeta: { method: "GET", path: "/2.0/memberships", query, page },
          payload,
        };
        if (!styleAHasNextPage(payload)) break;
        page += 1;
      }
    }
  },

  extractRows: (payload) => {
    const parsedRows = extractStyleARows(payload);
    if (typeof payload !== "object" || payload === null) return parsedRows;
    return dedupedRowsByPayload.get(payload) ?? parsedRows;
  },

  mapRow: (rawRow, mapCtx) => {
    const { parsed, quarantine } = strictRow(glofoxMembershipSchema, ENTITY, rawRow);
    if (parsed === null) return { rows: [], quarantine: [...quarantine] };
    const result = mapMembership(parsed, { tenantId: mapCtx.tenantId });
    return { rows: [...result.rows], quarantine: [...result.quarantine] };
  },

  upsertBatch: async (tx, rows, ctx) => {
    for (const row of rows) {
      await tx.query(
        `insert into public.plan_catalog (
           tenant_id, external_ref, name, description, active, plan_code, plan_name,
           price, glofox_type, credits_granted, duration_days, kelo_type, raw
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (tenant_id, external_ref, plan_code)
         do update set
           name = excluded.name,
           description = excluded.description,
           active = excluded.active,
           plan_name = excluded.plan_name,
           price = excluded.price,
           glofox_type = excluded.glofox_type,
           credits_granted = excluded.credits_granted,
           duration_days = excluded.duration_days,
           raw = excluded.raw
         -- kelo_type DELIBERATELY ABSENT from the SET list: it is the owner's
         -- A8 mapping (migration 0008 column-list grant); imports never touch it.`,
        [
          ctx.tenantId,
          row.external_ref,
          row.name,
          row.description,
          row.active,
          row.plan_code,
          row.plan_name,
          row.price,
          row.glofox_type,
          row.credits_granted,
          row.duration_days,
          row.kelo_type,
          JSON.stringify(row.raw ?? null),
        ],
      );
    }
    return { upserted: rows.length, quarantine: [] };
  },

  candidateFor: (window: SyncWindow) => window.end,
};
