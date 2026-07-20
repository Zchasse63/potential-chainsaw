/**
 * WS-6 — subscription EVENT-TIME MONOTONICITY (F6, CRITICAL #3). The real
 * syncSubscriptionStatus (workers/src/billing/dunning.ts) gates its status write
 * on eventCreatedAt vs subscriptions.last_event_at, so an unordered/delayed
 * Stripe webhook can never regress a member. Prior coverage asserted only the
 * SQL SHAPE; this runs an ADVERSARIAL out-of-order schedule through the ACTUAL
 * function against real Postgres and asserts the resulting state.
 *
 * Runs ONLY when DATABASE_URL is set (CI `db` job, migrations applied). The
 * connecting role is the CI postgres superuser. Self-cleaning.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { syncSubscriptionStatus } from "../../src/billing/dunning.js";
import type { PooledQueryable } from "../../src/glofox/types.js";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_SLUG = "sub-mono-test";

async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>("select id from public.tenants where slug = $1", [TENANT_SLUG]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  await admin.query("delete from public.subscriptions where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.plan_prices where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.plans where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.customers where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.people where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
}

describe.skipIf(!DATABASE_URL)("subscription event-time monotonicity (requires DATABASE_URL)", () => {
  let admin: Client;
  let pool: PooledQueryable;
  let tenantId: string;
  let subId: string;

  async function statusNow(): Promise<string> {
    const r = await admin.query<{ status: string }>("select status from public.subscriptions where id = $1", [subId]);
    return r.rows[0]!.status;
  }
  function sub() {
    return { id: subId, tenantId };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    // The worker function only needs a `query` — the pg Client satisfies it.
    pool = { query: (text: string, params?: unknown[]) => admin.query(text, params) } as unknown as PooledQueryable;
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('Sub Mono', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;
    const p = await admin.query<{ id: string }>(
      "insert into public.people (tenant_id, first_name, source, active) values ($1, 'Member', 'native', true) returning id",
      [tenantId],
    );
    const cust = await admin.query<{ id: string }>(
      "insert into public.customers (tenant_id, person_id) values ($1, $2) returning id",
      [tenantId, p.rows[0]!.id],
    );
    const plan = await admin.query<{ id: string }>(
      "insert into public.plans (tenant_id, kelo_type, name) values ($1, 'recurring', 'Monthly') returning id",
      [tenantId],
    );
    const price = await admin.query<{ id: string }>(
      "insert into public.plan_prices (tenant_id, plan_id, amount_cents) values ($1, $2, 5000) returning id",
      [tenantId, plan.rows[0]!.id],
    );
    const s = await admin.query<{ id: string }>(
      "insert into public.subscriptions (tenant_id, customer_id, plan_id, plan_price_id, status) values ($1, $2, $3, $4, 'incomplete') returning id",
      [tenantId, cust.rows[0]!.id, plan.rows[0]!.id, price.rows[0]!.id],
    );
    subId = s.rows[0]!.id;
  });

  afterAll(async () => {
    try {
      await purge(admin);
    } finally {
      await admin.end();
    }
  });

  it("applies a fresh event, then an out-of-order schedule cannot regress state", async () => {
    // A) active @ t=100 (fresh) → active.
    await syncSubscriptionStatus(pool, { sub: sub(), status: "active", eventCreatedAt: 100 });
    expect(await statusNow()).toBe("active");

    // B) an OLDER past_due @ t=50 is a benign no-op — status stays active.
    await syncSubscriptionStatus(pool, { sub: sub(), status: "past_due", eventCreatedAt: 50 });
    expect(await statusNow()).toBe("active");

    // C) a NEWER past_due @ t=200 advances (monotonic).
    await syncSubscriptionStatus(pool, { sub: sub(), status: "past_due", eventCreatedAt: 200 });
    expect(await statusNow()).toBe("past_due");

    // D) a SAME-SECOND deleted @ t=200 still cancels (terminal uses <=, so an
    //    immediate cancellation emitting updated+deleted in one second lands).
    await syncSubscriptionStatus(pool, { sub: sub(), deleted: true, eventCreatedAt: 200 });
    expect(await statusNow()).toBe("cancelled");

    // E) a stale active @ t=150 can NEVER revive a cancelled member.
    await syncSubscriptionStatus(pool, { sub: sub(), status: "active", eventCreatedAt: 150 });
    expect(await statusNow()).toBe("cancelled");
  });
});
