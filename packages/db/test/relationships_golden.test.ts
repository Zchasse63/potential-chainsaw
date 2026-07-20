/**
 * WS-4b — relationship typing GOLDEN suite (CRITICAL #2). The load-bearing
 * derivation: app.recompute_all_relationships (migration 0012) classifies each
 * person into people.primary_relationship by the precedence recurring_member >
 * pack_holder > aggregator > guest (any activity) > lead (none), and appends to
 * the APPEND-ONLY person_relationship_log ONLY when the primary actually
 * changes. member_count and MRR read exactly the recurring_member cohort, and
 * the log is what "new members" / churn key off — so a spurious or missing log
 * row is a silently-wrong headline number.
 *
 * Executes the REAL function on real Postgres and asserts the two properties the
 * audit named: the classification/precedence, and that the log fires EXACTLY
 * ONCE on a real transition and NEVER on an idempotent re-run.
 *
 * Runs ONLY when DATABASE_URL is set (CI `db` job). Superuser connection.
 * Self-cleaning + reclaims orphans from a crashed prior run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_SLUG = "rel-golden-test";

async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>("select id from public.tenants where slug = $1", [TENANT_SLUG]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  await admin.query("delete from public.person_relationship_log where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.person_relationships where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.glofox_bookings where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.people where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
}

describe.skipIf(!DATABASE_URL)("relationship typing golden (requires DATABASE_URL)", () => {
  let admin: Client;
  let tenantId: string;
  let leadId: string; // bare person, no activity → lead
  let guestId: string; // an attended visit, no member/pack/aggregator → guest

  async function primaryOf(personId: string): Promise<string | null> {
    const r = await admin.query<{ primary_relationship: string | null }>(
      "select primary_relationship from public.people where id = $1",
      [personId],
    );
    return r.rows[0]?.primary_relationship ?? null;
  }
  async function logCount(personId: string): Promise<number> {
    const r = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.person_relationship_log where person_id = $1",
      [personId],
    );
    return r.rows[0]!.n;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('Rel Golden', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;
    await admin.query("insert into public.locations (tenant_id, name, timezone) values ($1, 'HQ', 'America/New_York')", [
      tenantId,
    ]);

    const l = await admin.query<{ id: string }>(
      "insert into public.people (tenant_id, first_name, source, external_ref, active) values ($1, 'Lee Lead', 'glofox', 'ext-L', true) returning id",
      [tenantId],
    );
    leadId = l.rows[0]!.id;

    const g = await admin.query<{ id: string }>(
      "insert into public.people (tenant_id, first_name, source, external_ref, active) values ($1, 'Gia Guest', 'glofox', 'ext-G', true) returning id",
      [tenantId],
    );
    guestId = g.rows[0]!.id;
    await admin.query(
      "insert into public.glofox_bookings (tenant_id, external_ref, person_external_ref, status, attended, time_start) values ($1, 'gb-G', 'ext-G', 'BOOKED', true, now() - interval '3 days')",
      [tenantId],
    );

    // Run ONCE up front — the classification + the first (null→X) transition log.
    await admin.query("select app.recompute_all_relationships($1)", [tenantId]);
  });

  afterAll(async () => {
    try {
      await purge(admin);
    } finally {
      await admin.end();
    }
  });

  it("classifies a bare person as lead and a person with activity as guest (precedence)", async () => {
    expect(await primaryOf(leadId)).toBe("lead");
    expect(await primaryOf(guestId)).toBe("guest");
  });

  it("appends exactly one relationship-log row per real transition (null → classification)", async () => {
    expect(await logCount(leadId)).toBe(1);
    expect(await logCount(guestId)).toBe(1);
    // The first log row is the null → classified transition.
    const r = await admin.query<{ from_primary: string | null; to_primary: string }>(
      "select from_primary, to_primary from public.person_relationship_log where person_id = $1",
      [guestId],
    );
    expect(r.rows[0]?.from_primary).toBeNull();
    expect(r.rows[0]?.to_primary).toBe("guest");
  });

  it("an idempotent re-run with identical evidence appends NO new log rows", async () => {
    await admin.query("select app.recompute_all_relationships($1)", [tenantId]);
    // Still exactly one — the log fires on the transition, never on a no-op recompute.
    expect(await logCount(leadId)).toBe(1);
    expect(await logCount(guestId)).toBe(1);
  });
});
