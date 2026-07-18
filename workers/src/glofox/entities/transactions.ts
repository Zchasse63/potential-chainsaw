import { buildAnalyticsReportRequest, FACTS_MAPPER_VERSION, mapTransactionRow } from "@kelo/glofox";
import type { GlofoxTransactionFactRow } from "@kelo/glofox";
import { extractTransactionsRows, toUnixSeconds } from "../envelopes.js";
import type { EntitySpec, SyncRunContext, SyncWindow } from "../types.js";
import { iso } from "./shared.js";

/**
 * Transactions sync — WINDOWED, no cursor (README §7.1: the Analytics report
 * returns the full window, keep windows small). The run marches 7-day windows
 * forward from min(committed, now-35d): every caught-up run overlaps the last
 * 35 days, then continues through the committed watermark to now, up to
 * MAX_WINDOWS_PER_RUN per run. Live sync proved that Glofox can expose a row
 * late with a `created` timestamp before our watermark; the overlap catches
 * those rows idempotently via upserts. candidateFor remains window.end, so the
 * committed watermark still advances to now rather than being held back.
 *
 * First run (no committed watermark): starts at payload.backfillStart (ISO
 * date) when the job carries one, else a single trailing 7-day window.
 *
 * plausible_zero = TRUE: quiet 7-day windows (holidays, pre-opening history)
 * legitimately return zero rows and the march must not stall on them. The
 * silently-empty trap this relaxes is trap 2 (missing namespace) — guarded
 * upstream: namespace is non-optional in the typed request builder, and every
 * raw page's request_meta records namespace_present.
 *
 * Rows: the report envelope leaves detail rows unknown; mapTransactionRow owns
 * wrapper-key detection + the strict StripeCharge parse per row (per-row
 * salvage already inside the mapper).
 */

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (spec)
const RESCAN_DAYS = 35; // late-appearing rows can carry pre-watermark `created` timestamps
const RESCAN_MS = RESCAN_DAYS * 24 * 60 * 60 * 1000;
const MAX_WINDOWS_PER_RUN = 8; // bounded loop for the serverless budget (spec)
const ENTITY = "transactions";

function backfillStart(ctx: SyncRunContext, now: Date): Date {
  const raw = ctx.payload["backfillStart"];
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`transactions backfillStart is not a valid date: ${raw}`);
    }
    return parsed;
  }
  return new Date(now.getTime() - WINDOW_MS);
}

export const transactionsSpec: EntitySpec<GlofoxTransactionFactRow> = {
  entity: ENTITY,
  mapperVersion: FACTS_MAPPER_VERSION,
  defaults: { plausibleZero: true, emptyAlarmThreshold: 3 },
  fullListEveryRun: false,
  needsTimezone: true,

  windows: (state, ctx) => {
    const now = ctx.now();
    const rescanStart = new Date(now.getTime() - RESCAN_MS);
    let cursor =
      state.committed_watermark === null
        ? backfillStart(ctx, now)
        : new Date(Math.min(new Date(state.committed_watermark).getTime(), rescanStart.getTime()));
    const windows: SyncWindow[] = [];
    while (cursor < now && windows.length < MAX_WINDOWS_PER_RUN) {
      const end = new Date(Math.min(cursor.getTime() + WINDOW_MS, now.getTime()));
      windows.push({ start: cursor, end });
      cursor = end;
    }
    return windows;
  },

  pages: async function* (_pool, client, window, ctx) {
    if (ctx.branchId === undefined || ctx.namespace === undefined) {
      // Trap 2 is a SILENT EMPTY report — missing identity config must be loud.
      throw new Error("transactions sync requires ctx.branchId and ctx.namespace");
    }
    if (window.start === null) throw new Error("transactions windows are bounded");
    // The typed builder (trap-2 guard): namespace is non-optional at the type
    // level AND re-checked by the schema parse at this boundary.
    const body = buildAnalyticsReportRequest({
      branch_id: ctx.branchId,
      namespace: ctx.namespace,
      start: String(toUnixSeconds(window.start)),
      end: String(toUnixSeconds(window.end)),
      model: "TransactionsList",
    });
    const payload = await client.fetch("/Analytics/report", { method: "POST", body });
    yield {
      endpoint: "/Analytics/report",
      requestMeta: { method: "POST", path: "/Analytics/report", body },
      payload,
    };
  },

  extractRows: extractTransactionsRows,

  mapRow: (rawRow, mapCtx) => {
    const result = mapTransactionRow(rawRow, mapCtx);
    return {
      rows: result.row === null ? [] : [result.row],
      quarantine: [...result.quarantine],
    };
  },

  upsertBatch: async (tx, rows, ctx) => {
    for (const row of rows) {
      await tx.query(
        `insert into public.glofox_transactions (
           tenant_id, external_ref, provider, transaction_status, amount, currency,
           amount_refunded, glofox_event, glofox_event_class, person_external_ref, plan_code,
           stripe_subscription_id, payment_method, invoice_external_ref, event_external_ref,
           transaction_created_at, raw
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (tenant_id, external_ref)
         do update set
           provider = excluded.provider,
           transaction_status = excluded.transaction_status,
           amount = excluded.amount,
           currency = excluded.currency,
           amount_refunded = excluded.amount_refunded,
           glofox_event = excluded.glofox_event,
           glofox_event_class = excluded.glofox_event_class,
           person_external_ref = excluded.person_external_ref,
           plan_code = excluded.plan_code,
           stripe_subscription_id = excluded.stripe_subscription_id,
           payment_method = excluded.payment_method,
           invoice_external_ref = excluded.invoice_external_ref,
           event_external_ref = excluded.event_external_ref,
           transaction_created_at = excluded.transaction_created_at,
           raw = excluded.raw
         -- Glofox rows CAN change (PAID→REFUNDED, migration 0009): this is the
         -- queryable projection; the immutable record is glofox_raw.`,
        [
          ctx.tenantId,
          row.external_ref,
          row.provider,
          row.transaction_status,
          row.amount,
          row.currency,
          row.amount_refunded,
          row.glofox_event,
          row.glofox_event_class,
          row.person_external_ref,
          row.plan_code,
          row.stripe_subscription_id,
          row.payment_method,
          row.invoice_external_ref,
          row.event_external_ref,
          iso(row.transaction_created_at),
          JSON.stringify(row.raw ?? null),
        ],
      );
    }
    return { upserted: rows.length, quarantine: [] };
  },

  candidateFor: (window: SyncWindow) => window.end,
};
