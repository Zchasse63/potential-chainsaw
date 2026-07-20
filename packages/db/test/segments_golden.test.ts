/**
 * WS-4a — segment engine GOLDEN suite (CRITICAL #2). app.recompute_segments
 * (migration 0018) is the outreach spine: it assigns each active person to the
 * marketing segments and the read path reduces to the single highest-priority
 * one. Before this, the derivation was validated only by migration-text grep /
 * mocked RPCs — a wrong assignment (or a broken priority rule) shipped green.
 *
 * This executes the REAL function on real Postgres and asserts EXACT membership
 * for two engineered people, plus the two properties the audit named:
 *   • the priority-COMPLEMENT — a recurring member who is also at_risk must NOT
 *     also be active_recurring (active_recurring, priority 13, explicitly
 *     excludes anyone assigned payment_risk / at_risk / cooling in the run);
 *   • the single-highest-priority REDUCTION the outreach queue applies.
 *
 * Runs ONLY when DATABASE_URL is set (CI `db` job, migrations applied by
 * scripts/db-test.sh). Superuser connection: recompute is service-role-only.
 * Self-cleaning + reclaims orphans from a crashed prior run.
 *
 * Segment predicates exercised (0018): recurring = people.primary_relationship
 * = 'recurring_member'; an attended visit = glofox_bookings.attended; at_risk =
 * recurring with last attendance ≥ 21 studio-local days ago.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_SLUG = "seg-golden-test";

async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>("select id from public.tenants where slug = $1", [TENANT_SLUG]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  // segment_assignments cascade from segment_runs; delete both explicitly, then
  // the source rows, then the tenant (cascades locations).
  await admin.query("delete from public.segment_assignments where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.segment_runs where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.glofox_bookings where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.people where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
}

describe.skipIf(!DATABASE_URL)("segment engine golden (requires DATABASE_URL)", () => {
  let admin: Client;
  let tenantId: string;
  let personA: string; // recurring + recent attendance → active_recurring
  let personB: string; // recurring + stale attendance  → at_risk (not active_recurring)
  let runId: string;

  async function seedRecurring(label: string, extRef: string, lastAttendedDaysAgo: number) {
    const p = await admin.query<{ id: string }>(
      `insert into public.people (tenant_id, first_name, source, external_ref, primary_relationship, active)
       values ($1, $2, 'glofox', $3, 'recurring_member', true) returning id`,
      [tenantId, label, extRef],
    );
    await admin.query(
      `insert into public.glofox_bookings (tenant_id, external_ref, person_external_ref, status, attended, time_start)
       values ($1, $2, $3, 'BOOKED', true, now() - ($4 || ' days')::interval)`,
      [tenantId, `gb-${extRef}`, extRef, String(lastAttendedDaysAgo)],
    );
    return p.rows[0]!.id;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('Seg Golden', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;
    // recompute derives the studio-local day from the tenant's first location tz.
    await admin.query("insert into public.locations (tenant_id, name, timezone) values ($1, 'HQ', 'America/New_York')", [
      tenantId,
    ]);

    personA = await seedRecurring("Ada Active", "ext-A", 5); // 5 days ago → healthy
    personB = await seedRecurring("Bo Atrisk", "ext-B", 40); // 40 days ago → ≥21 → at_risk

    const run = await admin.query<{ recompute_segments: string }>("select app.recompute_segments($1) as recompute_segments", [
      tenantId,
    ]);
    runId = run.rows[0]!.recompute_segments;
  });

  afterAll(async () => {
    try {
      await purge(admin);
    } finally {
      await admin.end();
    }
  });

  async function keysFor(personId: string): Promise<string[]> {
    const r = await admin.query<{ segment_key: string }>(
      "select segment_key from public.segment_assignments where run_id = $1 and person_id = $2 order by segment_key",
      [runId, personId],
    );
    return r.rows.map((row) => row.segment_key);
  }

  it("a recurring member with a recent attended visit is active_recurring (and NOT at_risk)", async () => {
    const keys = await keysFor(personA);
    expect(keys).toContain("active_recurring");
    expect(keys).not.toContain("at_risk");
  });

  it("a recurring member stale ≥21 days is at_risk and — priority-complement — NOT active_recurring", async () => {
    const keys = await keysFor(personB);
    expect(keys).toContain("at_risk");
    expect(keys).not.toContain("active_recurring");
  });

  it("the outreach reduction picks the single highest-priority segment (at_risk over any lower)", async () => {
    const r = await admin.query<{ segment_key: string }>(
      `select a.segment_key
         from public.segment_assignments a
         join public.segment_definitions d on d.key = a.segment_key
        where a.run_id = $1 and a.person_id = $2
        order by d.priority
        limit 1`,
      [runId, personB],
    );
    expect(r.rows[0]?.segment_key).toBe("at_risk");
  });

  it("the run row records the evaluation (both seeded people counted)", async () => {
    const r = await admin.query<{ status: string; people_evaluated: number }>(
      "select status, people_evaluated from public.segment_runs where id = $1",
      [runId],
    );
    expect(r.rows[0]?.status).toBe("success");
    expect(r.rows[0]?.people_evaluated).toBeGreaterThanOrEqual(2);
  });
});
