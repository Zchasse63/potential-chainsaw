/**
 * WS-4d — /ask fill-rate GOLDEN suite (CRITICAL #2). The ask_* SQL functions
 * (migration 0021) power the demand heatmap and had ZERO executed coverage. The
 * /ask "digit fence" trusts these rows as ground truth, so a wrong ratio — or a
 * divide-by-zero on a zero-capacity slot — is a silently-wrong number the model
 * would then narrate as fact.
 *
 * Executes ask_fill_rate_by_daypart on real Postgres and asserts the exact fill
 * for a normal daypart AND the divide-by-zero-safe fill (0, not NaN/error) on a
 * zero-capacity daypart — the guard the audit named (coalesce(.../nullif(cap,0),0)).
 *
 * Runs ONLY when DATABASE_URL is set (CI `db` job). Superuser connection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_SLUG = "ask-golden-test";

async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>("select id from public.tenants where slug = $1", [TENANT_SLUG]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  await admin.query("delete from public.glofox_bookings where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.glofox_sessions where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
}

describe.skipIf(!DATABASE_URL)("ask fill-rate golden (requires DATABASE_URL)", () => {
  let admin: Client;
  let tenantId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('Ask Golden', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;
    await admin.query("insert into public.locations (tenant_id, name, timezone) values ($1, 'HQ', 'America/New_York')", [
      tenantId,
    ]);

    // MORNING session (8am studio-local today), capacity 4, two BOOKED → fill 0.5.
    await admin.query(
      `insert into public.glofox_sessions (tenant_id, external_ref, capacity, time_start)
       values ($1, 'sess-1', 4, ((now() at time zone 'America/New_York')::date + interval '8 hours') at time zone 'America/New_York')`,
      [tenantId],
    );
    await admin.query(
      `insert into public.glofox_bookings (tenant_id, external_ref, person_external_ref, session_external_ref, status)
       values ($1, 'b1', 'p1', 'sess-1', 'BOOKED'), ($1, 'b2', 'p2', 'sess-1', 'BOOKED')`,
      [tenantId],
    );
    // EVENING session (6pm), capacity 0, no bookings → the divide-by-zero case.
    await admin.query(
      `insert into public.glofox_sessions (tenant_id, external_ref, capacity, time_start)
       values ($1, 'sess-2', 0, ((now() at time zone 'America/New_York')::date + interval '18 hours') at time zone 'America/New_York')`,
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

  async function daypart(dp: string) {
    const r = await admin.query<{ booked: number; capacity: number; fill: string }>(
      `select booked, capacity, fill
         from public.ask_fill_rate_by_daypart(
           $1,
           (now() at time zone 'America/New_York')::date - 1,
           (now() at time zone 'America/New_York')::date + 1)
        where daypart = $2`,
      [tenantId, dp],
    );
    return r.rows[0];
  }

  it("computes the exact fill for a normal daypart (2 booked / 4 capacity = 0.5)", async () => {
    const m = await daypart("morning");
    expect(m?.booked).toBe(2);
    expect(m?.capacity).toBe(4);
    expect(Number(m?.fill)).toBe(0.5);
  });

  it("returns fill 0 (not NaN/error) on a zero-capacity daypart — divide-by-zero guarded", async () => {
    const e = await daypart("evening");
    expect(e?.capacity).toBe(0);
    expect(Number(e?.fill)).toBe(0);
  });
});
