/**
 * WS-4c — KPI GOLDEN suite (CRITICAL #2: the money numbers). The revenue /
 * membership metrics (migration 0017) were validated only by definition text /
 * mocked RPCs. A wrong sign or cohort here is a silently-wrong HEADLINE figure.
 *
 * Executes the REAL kpi_* functions on Postgres and asserts exact values for the
 * boundary the audit named — the refund sign on a same-day PAID+REFUNDED pair
 * (gross 100, refunds −30, net 70) — plus the member_count cohort (ONLY
 * primary_relationship = recurring_member).
 *
 * Runs ONLY when DATABASE_URL is set (CI `db` job). Superuser connection.
 * Self-cleaning + reclaims orphans from a crashed prior run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_SLUG = "kpi-golden-test";

async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>("select id from public.tenants where slug = $1", [TENANT_SLUG]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  await admin.query("delete from public.glofox_transactions where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.people where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
}

describe.skipIf(!DATABASE_URL)("KPI golden (requires DATABASE_URL)", () => {
  let admin: Client;
  let tenantId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('KPI Golden', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;
    await admin.query("insert into public.locations (tenant_id, name, timezone) values ($1, 'HQ', 'America/New_York')", [
      tenantId,
    ]);

    // A same-day PAID 100 and REFUNDED 30 → the net-collected boundary.
    await admin.query(
      `insert into public.glofox_transactions (tenant_id, external_ref, transaction_status, amount, currency, glofox_event_class, transaction_created_at)
       values ($1, 'tx-paid', 'PAID', 100, 'USD', 'invoice_payment', now()),
              ($1, 'tx-refund', 'REFUNDED', 30, 'USD', 'invoice_payment', now())`,
      [tenantId],
    );

    // member_count reads ONLY the recurring_member cohort — the lead is excluded.
    await admin.query(
      `insert into public.people (tenant_id, first_name, source, external_ref, primary_relationship, active) values
         ($1, 'M1', 'glofox', 'ext-m1', 'recurring_member', true),
         ($1, 'M2', 'glofox', 'ext-m2', 'recurring_member', true),
         ($1, 'L1', 'glofox', 'ext-l1', 'lead', true)`,
      [tenantId],
    );
  });

  afterAll(async () => {
    try {
      await purge(admin);
    } finally {
      await admin.end();
    }
  });

  it("collected_revenue nets a same-day PAID+REFUNDED with the correct refund sign (gross 100, refunds −30, net 70)", async () => {
    const r = await admin.query<{ gross: string; refunds: string; net: string; txn_count: number }>(
      `select gross, refunds, net, txn_count
         from public.kpi_collected_revenue_totals(
           $1,
           (now() at time zone 'America/New_York')::date - 1,
           (now() at time zone 'America/New_York')::date + 1)`,
      [tenantId],
    );
    const row = r.rows[0]!;
    expect(Number(row.gross)).toBe(100);
    expect(Number(row.refunds)).toBe(-30); // refunds carry a NEGATIVE sign
    expect(Number(row.net)).toBe(70); // gross + refunds
  });

  it("the daily series carries the same net on today's studio-local row", async () => {
    const r = await admin.query<{ net: string }>(
      `select net from public.kpi_collected_revenue(
         $1,
         (now() at time zone 'America/New_York')::date - 1,
         (now() at time zone 'America/New_York')::date + 1)
       where day = (now() at time zone 'America/New_York')::date`,
      [tenantId],
    );
    expect(Number(r.rows[0]?.net)).toBe(70);
  });

  it("member_count counts ONLY the recurring_member cohort (the lead is excluded)", async () => {
    const r = await admin.query<{ n: number }>("select public.kpi_member_count($1)::int as n", [tenantId]);
    expect(r.rows[0]?.n).toBe(2);
  });
});
