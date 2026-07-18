#!/usr/bin/env node
/**
 * Phase 1.7 — the director's live backfill runner.
 *
 * Drives the REAL import path (enqueue → app.claim_jobs via runTick → entity
 * processors) against production, exactly as the Netlify scheduler tick will,
 * so the backfill itself exercises the watermark law, the raw zone, quarantine,
 * and the queue. Idempotent: safe to re-run (watermarks + hash-dedup + upserts).
 *
 * Requires env (never committed): SUPABASE_DB_URL, GLOFOX_* (5). Run:
 *   set -a; . ./.env; set +a; node scripts/backfill-runner.mjs
 *
 * Order: seed tenant/location → memberships → members → events/bookings →
 * transactions (windows march from BACKFILL_START) → credits (self-chaining
 * chunks) → recompute relationships → refresh balances → reconcile + snapshot
 * → evidence report. No PII is printed — counts, ids, and watermarks only.
 */
import { createDbPool } from "../packages/db/dist/index.js";
import { runTick } from "../workers/dist/index.js";

const BACKFILL_START = "2023-11-01"; // verified history edge ~Dec 2023 (README §5)
const BRANCH_ID = process.env.GLOFOX_BRANCH_ID;
if (!BRANCH_ID) throw new Error("GLOFOX_BRANCH_ID missing");

const pool = createDbPool();
const q = (text, values) => pool.query(text, values);

async function seedTenant() {
  const existing = await q(`select id from public.tenants where slug = 'sauna-guys'`);
  let tenantId = existing.rows[0]?.id;
  if (!tenantId) {
    const t = await q(
      `insert into public.tenants (name, slug, settings)
       values ('The Sauna Guys', 'sauna-guys', '{"grace_days": 14}'::jsonb)
       returning id`,
    );
    tenantId = t.rows[0].id;
    console.log(`seeded tenant ${tenantId}`);
  } else {
    console.log(`tenant exists ${tenantId}`);
  }
  await q(
    `insert into public.locations (tenant_id, name, timezone, currency, external_ref)
     select $1, 'The Sauna Guys — Tampa', 'America/New_York', 'USD', $2
     where not exists (
       select 1 from public.locations where tenant_id = $1 and external_ref = $2
     )`,
    [tenantId, BRANCH_ID],
  );
  return tenantId;
}

async function enqueue(kind, payload, tenantId, key) {
  await q(`select app.enqueue_job($1, $2::jsonb, $3, now(), 100, 5, $4)`, [
    kind,
    JSON.stringify(payload ?? {}),
    tenantId,
    key,
  ]);
}

async function drain(label) {
  // Drive ticks until the queue stays empty two ticks in a row (self-chaining
  // jobs — credits chunks — keep appearing between ticks).
  let empty = 0;
  let total = { claimed: 0, succeeded: 0, failed: 0 };
  for (let i = 0; i < 500; i += 1) {
    const r = await runTick(pool, { workerId: `backfill-${label}`, batch: 50 });
    total.claimed += r.claimed;
    total.succeeded += r.succeeded;
    total.failed += r.failed;
    if (r.claimed === 0) {
      empty += 1;
      if (empty >= 2) break;
      await new Promise((res) => setTimeout(res, 500));
    } else {
      empty = 0;
      process.stdout.write(
        `\r[${label}] ticks=${i + 1} claimed=${total.claimed} ok=${total.succeeded} failed=${total.failed}   `,
      );
    }
  }
  console.log(`\n[${label}] done: claimed=${total.claimed} ok=${total.succeeded} failed=${total.failed}`);
  return total;
}

async function committedWatermark(tenantId, entity) {
  const r = await q(
    `select committed_watermark from public.sync_state where tenant_id = $1 and entity = $2`,
    [tenantId, entity],
  );
  return r.rows[0]?.committed_watermark ?? null;
}

async function main() {
  const tenantId = await seedTenant();
  const stamp = Date.now();

  // Wave 1: catalog + people first (credits needs people rows).
  await enqueue("glofox.sync.memberships", {}, tenantId, `bf:${stamp}:memberships`);
  await enqueue("glofox.sync.members", {}, tenantId, `bf:${stamp}:members`);
  await drain("wave1");

  // Wave 2: facts.
  await enqueue("glofox.sync.events", {}, tenantId, `bf:${stamp}:events`);
  await enqueue("glofox.sync.bookings", {}, tenantId, `bf:${stamp}:bookings`);
  await enqueue(
    "glofox.sync.transactions",
    { backfillStart: BACKFILL_START },
    tenantId,
    `bf:${stamp}:tx:0`,
  );
  await drain("wave2");

  // March the transaction windows until caught up (<8 days behind now).
  for (let i = 1; i <= 60; i += 1) {
    const wm = await committedWatermark(tenantId, "transactions");
    const behindDays = wm ? (Date.now() - new Date(wm).getTime()) / 86_400_000 : Infinity;
    console.log(`[tx] committed=${wm} behind=${behindDays.toFixed(1)}d`);
    if (behindDays < 8) break;
    await enqueue(
      "glofox.sync.transactions",
      { backfillStart: BACKFILL_START },
      tenantId,
      `bf:${stamp}:tx:${i}`,
    );
    await drain(`tx-${i}`);
  }

  // Wave 3: credits (self-chaining chunks drain until the chain stops).
  await enqueue("glofox.sync.credits", {}, tenantId, `bf:${stamp}:credits:first`);
  await drain("credits");

  // Derivation + read models + trust engine.
  console.log("recompute_all_relationships…");
  const rec = await q(`select app.recompute_all_relationships($1) as n`, [tenantId]);
  console.log(`recomputed ${rec.rows[0].n} people`);
  await q(`select app.refresh_credit_balances()`);
  await enqueue("glofox.reconcile", {}, tenantId, `bf:${stamp}:reconcile`);
  await enqueue("glofox.detect_deletions", {}, tenantId, `bf:${stamp}:deletions`);
  await drain("trust");

  // Evidence report — counts and watermarks only, no PII.
  const report = {};
  for (const [k, sql] of Object.entries({
    people: `select count(*)::int n from public.people where tenant_id=$1`,
    plan_catalog: `select count(*)::int n from public.plan_catalog where tenant_id=$1`,
    glofox_sessions: `select count(*)::int n from public.glofox_sessions where tenant_id=$1`,
    glofox_bookings: `select count(*)::int n from public.glofox_bookings where tenant_id=$1`,
    glofox_transactions: `select count(*)::int n from public.glofox_transactions where tenant_id=$1`,
    credit_ledger: `select count(*)::int n from public.credit_ledger where tenant_id=$1`,
    glofox_raw_pages: `select count(*)::int n from public.glofox_raw where tenant_id=$1`,
    quarantine_open: `select count(*)::int n from public.import_quarantine where tenant_id=$1 and status='open'`,
  })) {
    report[k] = (await q(sql, [tenantId])).rows[0].n;
  }
  report.primary_relationship = (
    await q(
      `select coalesce(primary_relationship,'(null)') pr, count(*)::int n
       from public.people where tenant_id=$1 group by 1 order by n desc`,
      [tenantId],
    )
  ).rows;
  report.sync_state = (
    await q(
      `select entity, committed_watermark, consecutive_empty, health_state
       from public.sync_state where tenant_id=$1 order by entity`,
      [tenantId],
    )
  ).rows;
  report.reconciliations = (
    await q(
      `select entity, glofox_count, kelo_count, drift_count, status
       from public.reconciliations where tenant_id=$1 order by checked_at desc limit 10`,
      [tenantId],
    )
  ).rows;
  console.log("\n=== BACKFILL EVIDENCE REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error("BACKFILL FAILED:", err);
  process.exitCode = 1;
});
