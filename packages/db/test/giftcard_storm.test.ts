/**
 * Phase-5 MONEY CONCURRENCY STORM gate (WS-3b): gift-card double-spend. A gift
 * card is a bearer instrument; app.redeem_gift_card (migration 0039) claims to
 * be race-free by SERIALIZATION — it row-locks the card FOR UPDATE, recomputes
 * the append-only-ledger balance under that lock, and refuses an over-redeem.
 * Attack-suite block 31 proves the SEQUENTIAL refusal; this proves the same
 * ceiling holds under GENUINE parallelism — N distinct redemptions of ONE card
 * whose balance covers only M < N, fired simultaneously on separate pool
 * connections. If a future edit drops the FOR UPDATE, two concurrent redemptions
 * could each see the full balance and double-spend; here that fails the test.
 *
 * Runs ONLY when DATABASE_URL is set (CI `db` job, migrations applied by
 * scripts/db-test.sh). The connecting role is the CI postgres superuser: with
 * auth.uid() null the RPC's actor/role checks are bypassed (they gate on
 * `auth.uid() is not null`), but the balance/lock logic under test still runs.
 * Self-cleaning + reclaims orphans from a crashed prior run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_SLUG = "gc-storm-test";
const CODE = "GC-STORM-CARD";
const BALANCE = 3000;
const AMOUNT = 1000; // → exactly 3 redemptions fit
const N = 10; // 3 win, 7 refuse
const OVER_BALANCE = "22023"; // invalid_parameter_value ('redemption exceeds gift card balance')

type PgError = Error & { code?: string };

async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>("select id from public.tenants where slug = $1", [TENANT_SLUG]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  await admin.query("delete from public.gift_card_ledger where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.gift_cards where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenant_users where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
  await admin.query("delete from auth.users where email = 'gc-storm-operator@example.test'");
}

describe.skipIf(!DATABASE_URL)("gift-card redemption storm (requires DATABASE_URL)", () => {
  let admin: Client;
  let pool: Pool;
  let tenantId: string;
  let operatorId: string;
  let cardId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('GC Storm', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;
    const u = await admin.query<{ id: string }>(
      "insert into auth.users (id, email) values (gen_random_uuid(), 'gc-storm-operator@example.test') returning id",
    );
    operatorId = u.rows[0]!.id;
    await admin.query("insert into public.tenant_users (tenant_id, user_id, role) values ($1, $2, 'owner')", [
      tenantId,
      operatorId,
    ]);

    // Seed a card + its 'issue' ledger entry directly (the redeem RPC is the
    // path under test; the grant RPC's actor check is out of scope here).
    const card = await admin.query<{ id: string }>(
      `insert into public.gift_cards (tenant_id, code_hash, status)
       values ($1, encode(extensions.digest($2, 'sha256'), 'hex'), 'active') returning id`,
      [tenantId, CODE],
    );
    cardId = card.rows[0]!.id;
    await admin.query(
      `insert into public.gift_card_ledger (tenant_id, gift_card_id, entry_type, amount_cents, reason, actor_user_id)
       values ($1, $2, 'issue', $3, 'storm seed', $4)`,
      [tenantId, cardId, BALANCE, operatorId],
    );

    pool = new Pool({ connectionString: DATABASE_URL, max: 16 });
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
      if (admin) await purge(admin);
    } finally {
      if (admin) await admin.end();
    }
  });

  it(`REDEMPTION STORM: ${N} parallel redeems of a ${BALANCE}¢ card → exactly ${BALANCE / AMOUNT} win, the rest refuse, balance floors at 0`, async () => {
    const calls = Array.from({ length: N }, (_, i) =>
      pool.query<{ redeem: unknown }>("select app.redeem_gift_card($1, $2, $3, $4, $5) as redeem", [
        tenantId,
        operatorId,
        CODE,
        AMOUNT,
        `gc-storm-${i}`, // distinct key per call → genuine concurrent redemptions, not replays
      ]),
    );
    const settled = await Promise.allSettled(calls);
    const winners = settled.filter((s) => s.status === "fulfilled");
    const losers = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];

    // The card funded exactly BALANCE/AMOUNT redemptions; the rest are refused.
    expect(winners).toHaveLength(BALANCE / AMOUNT);
    expect(losers).toHaveLength(N - BALANCE / AMOUNT);
    // EVERY failure is the over-balance refusal — no deadlock, no other error leaks.
    for (const l of losers) {
      const err = l.reason as PgError;
      expect(err.code).toBe(OVER_BALANCE);
      expect(err.message).toMatch(/exceeds gift card balance/i);
    }

    // The persisted truth: balance never went below 0, and exactly the winners
    // appended a 'redeem' entry (append-only ledger — no mutable balance column).
    const bal = await admin.query<{ b: number }>("select public.gift_card_balance($1, $2)::int as b", [
      tenantId,
      cardId,
    ]);
    expect(bal.rows[0]!.b).toBe(0);
    expect(bal.rows[0]!.b).toBeGreaterThanOrEqual(0);

    const redeems = await admin.query<{ n: number; total: number }>(
      "select count(*)::int as n, coalesce(sum(amount_cents), 0)::int as total from public.gift_card_ledger where gift_card_id = $1 and entry_type = 'redeem'",
      [cardId],
    );
    expect(redeems.rows[0]!.n).toBe(BALANCE / AMOUNT);
    expect(redeems.rows[0]!.total).toBe(-BALANCE); // 3 × −1000, never over-drawn
  });
});
