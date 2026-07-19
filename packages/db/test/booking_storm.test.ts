/**
 * Phase-6 CONCURRENCY STORM gate (plan-final §6: "Concurrency storm: zero
 * double-bookings"). The native booking engine (migration 0040) claims to be
 * race-free by SERIALIZATION — every seat-consuming path locks the session row
 * FOR UPDATE, then counts, and a belt-and-suspenders BEFORE INSERT trigger
 * re-verifies capacity under the same lock. Block 32 of the RLS attack suite
 * proves the SEQUENTIAL over-capacity refusal; this file proves the same
 * ceiling holds under GENUINE parallelism — 12 distinct people firing
 * book_session at one 3-seat session simultaneously, on separate pool
 * connections, via Promise.all.
 *
 * Runs ONLY when DATABASE_URL is set — the CI `db` job provides it (plain
 * Postgres, every migration incl. 0040/0041 applied by scripts/db-test.sh
 * before this runs). In the normal `pnpm -w test` run (no DATABASE_URL) the
 * suite self-skips. The connecting role is the CI postgres superuser, which
 * bypasses RLS and may execute the service-role-only app.* functions; with
 * auth.uid() null the RPCs' actor/role checks are bypassed for setup, but their
 * capacity / credit / waiver logic — the thing under test — still runs.
 *
 * Seed shapes are copied from attack-suite block 32 (resources → offering
 * templates → published future sessions → native people → 1-credit grants; NO
 * active waiver version, so nobody owes a signature and every person is
 * BOOKABLE). The suite is self-cleaning (ordered delete in afterAll) and
 * defensively wipes any orphan from a crashed prior run in beforeAll, so it is
 * rerunnable against the same database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

// A stable slug lets a crashed prior run be reclaimed before we re-seed.
const TENANT_SLUG = "storm-test-6-4";

/** The named no-oversell / session-full refusal (0040): SQLSTATE 23514. */
const SESSION_FULL = "23514";

type PgError = Error & { code?: string };

/** Delete every seeded row for our tenant in FK-dependency order (bookings and
 *  credit_ledger hold ON DELETE RESTRICT FKs onto people, so children first),
 *  then the tenant (cascades locations/etc.) and the operator auth user. */
async function purge(admin: Client): Promise<void> {
  const t = await admin.query<{ id: string }>(
    "select id from public.tenants where slug = $1",
    [TENANT_SLUG],
  );
  const tenantId = t.rows[0]?.id;
  if (!tenantId) return;
  await admin.query("delete from public.bookings where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.booking_holds where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.credit_ledger where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.scheduled_sessions where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.offering_templates where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.resources where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenant_users where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.people where tenant_id = $1", [tenantId]);
  await admin.query("delete from public.tenants where id = $1", [tenantId]);
  await admin.query(
    "delete from auth.users where email = 'storm-operator@example.test'",
  );
}

describe.skipIf(!DATABASE_URL)("booking concurrency storm (requires DATABASE_URL)", () => {
  let admin: Client;
  let pool: Pool;

  let tenantId: string;
  let operatorId: string;

  // Booking storm.
  let bookSession: string;
  let bookPeople: string[] = [];
  // Hold storm.
  let holdSession: string;
  let holdPeople: string[] = [];
  // Replay storm.
  let replaySession: string;
  let replayPerson: string;

  /** Insert a published FUTURE session (>24h out) with the given capacity. */
  async function seedSession(offeringId: string, resourceId: string, capacity: number) {
    const r = await admin.query<{ id: string }>(
      `insert into public.scheduled_sessions
         (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
       values ($1, $2, $3, now() + interval '24 hours', now() + interval '25 hours', $4, 'published', now())
       returning id`,
      [tenantId, offeringId, resourceId, capacity],
    );
    return r.rows[0]!.id;
  }

  /** Insert a native person with a single 1-credit grant → exactly BOOKABLE once. */
  async function seedPersonWithOneCredit(label: string) {
    const p = await admin.query<{ id: string }>(
      "insert into public.people (tenant_id, first_name, source) values ($1, $2, 'native') returning id",
      [tenantId, label],
    );
    const personId = p.rows[0]!.id;
    await admin.query(
      `insert into public.credit_ledger (tenant_id, person_id, entry_type, delta, source, external_ref)
       values ($1, $2, 'grant', 1, 'native', $3)`,
      [tenantId, personId, `g-storm-${personId}`],
    );
    return personId;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    // Reclaim orphans from any crashed prior run so counts start exact.
    await purge(admin);

    const t = await admin.query<{ id: string }>(
      "insert into public.tenants (name, slug) values ('Storm Test', $1) returning id",
      [TENANT_SLUG],
    );
    tenantId = t.rows[0]!.id;

    // Operator user + membership (front_desk). With auth.uid() null the RPC role
    // checks are bypassed, but the actor is a real user so the seed is faithful.
    const u = await admin.query<{ id: string }>(
      "insert into auth.users (id, email) values (gen_random_uuid(), 'storm-operator@example.test') returning id",
    );
    operatorId = u.rows[0]!.id;
    await admin.query(
      "insert into public.tenant_users (tenant_id, user_id, role) values ($1, $2, 'front_desk')",
      [tenantId, operatorId],
    );

    // Authoring spine: one resource + offering template. Absence of a
    // resource_readiness row means "ready", so no readiness seed is needed.
    const res = await admin.query<{ id: string }>(
      "insert into public.resources (tenant_id, name) values ($1, 'Storm Room') returning id",
      [tenantId],
    );
    const resourceId = res.rows[0]!.id;
    const ot = await admin.query<{ id: string }>(
      "insert into public.offering_templates (tenant_id, name, duration_minutes) values ($1, 'Storm Class', 60) returning id",
      [tenantId],
    );
    const offeringId = ot.rows[0]!.id;

    // Three FRESH capacity-3 sessions — one per storm, so no cross-test bleed.
    bookSession = await seedSession(offeringId, resourceId, 3);
    holdSession = await seedSession(offeringId, resourceId, 3);
    replaySession = await seedSession(offeringId, resourceId, 3);

    // 12 people for the booking storm, 12 for the hold storm, 1 for the replay.
    bookPeople = [];
    for (let i = 0; i < 12; i++) bookPeople.push(await seedPersonWithOneCredit(`book-${i}`));
    holdPeople = [];
    for (let i = 0; i < 12; i++) holdPeople.push(await seedPersonWithOneCredit(`hold-${i}`));
    replayPerson = await seedPersonWithOneCredit("replay");

    // A pool wide enough that all 12 parallel calls get their OWN connection —
    // otherwise Promise.all would serialize behind a narrow pool and the "storm"
    // would be a queue, not a race.
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

  it("BOOKING STORM: 12 parallel book_session on a 3-seat session → exactly 3 win, 9 refuse session_full", async () => {
    const calls = bookPeople.map((personId, i) =>
      pool.query<{ book_session: { booking_id?: string } }>(
        "select app.book_session($1, $2, $3, $4, $5, 'desk', null, true) as book_session",
        [tenantId, personId, bookSession, operatorId, `storm-book-${i}`],
      ),
    );
    const settled = await Promise.allSettled(calls);

    const winners = settled.filter(
      (s): s is PromiseFulfilledResult<{ rows: { book_session: { booking_id?: string } }[] }> =>
        s.status === "fulfilled",
    );
    const losers = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];

    // Exactly the capacity succeeds; the rest are refused.
    expect(winners).toHaveLength(3);
    expect(losers).toHaveLength(9);

    // EVERY failure is the session-full refusal — no deadlock, no
    // insufficient_credits, no other error type may leak through.
    for (const l of losers) {
      const err = l.reason as PgError;
      expect(err.code).toBe(SESSION_FULL);
      expect(err.message).toMatch(/at capacity/i);
    }

    // The persisted truth: exactly 3 active bookings for the session.
    const bookings = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.bookings where tenant_id = $1 and session_id = $2 and status in ('booked', 'checked_in')",
      [tenantId, bookSession],
    );
    expect(bookings.rows[0]!.n).toBe(3);

    // Exactly 3 debits, one per winner, each keyed to that winner's idempotency
    // key (the debit's external_ref IS the booking key — 0040).
    const debits = await admin.query<{ external_ref: string }>(
      `select cl.external_ref
         from public.credit_ledger cl
         join public.bookings b on b.credit_entry_id = cl.id
        where b.tenant_id = $1 and b.session_id = $2 and cl.entry_type = 'debit' and cl.delta = -1`,
      [tenantId, bookSession],
    );
    expect(debits.rows).toHaveLength(3);

    // Each committed booking's key is exactly one of the appended debit keys.
    const bookedKeys = await admin.query<{ idempotency_key: string }>(
      "select idempotency_key from public.bookings where tenant_id = $1 and session_id = $2",
      [tenantId, bookSession],
    );
    const debitKeys = new Set(debits.rows.map((r) => r.external_ref));
    expect(debitKeys.size).toBe(3);
    for (const bk of bookedKeys.rows) expect(debitKeys.has(bk.idempotency_key)).toBe(true);

    const winnerIds = new Set(winners.map((w) => w.value.rows[0]!.book_session.booking_id));
    expect(winnerIds.size).toBe(3);

    // Zero duplicate (session_id, person_id) ACTIVE pairs — the no-double-book
    // invariant stated as data.
    const dupes = await admin.query<{ n: number }>(
      `select coalesce(max(cnt), 0)::int as n from (
         select count(*) as cnt from public.bookings
          where tenant_id = $1 and session_id = $2 and status in ('booked', 'checked_in')
          group by session_id, person_id
       ) g`,
      [tenantId, bookSession],
    );
    expect(dupes.rows[0]!.n).toBeLessThanOrEqual(1);
  });

  it("HOLD STORM: 12 parallel hold_session → at most 3 live holds; holders book, the 9 losers refuse session_full", async () => {
    const holdCalls = holdPeople.map((personId) =>
      pool
        .query<{ hold_session: string }>(
          "select app.hold_session($1, $2, $3, $4, 300) as hold_session",
          [tenantId, holdSession, personId, operatorId],
        )
        .then((r) => ({ personId, holdId: r.rows[0]!.hold_session })),
    );
    const settled = await Promise.allSettled(holdCalls);

    const held = settled
      .filter(
        (s): s is PromiseFulfilledResult<{ personId: string; holdId: string }> =>
          s.status === "fulfilled",
      )
      .map((s) => s.value);
    const failedHolds = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];

    // AT MOST the capacity may hold a live seat.
    expect(held.length).toBeLessThanOrEqual(3);
    for (const f of failedHolds) {
      expect((f.reason as PgError).code).toBe(SESSION_FULL);
    }

    // Confirm the live-hold rowcount agrees with what the RPC reported.
    const liveHolds = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.booking_holds where tenant_id = $1 and session_id = $2 and (frozen or expires_at > now())",
      [tenantId, holdSession],
    );
    expect(liveHolds.rows[0]!.n).toBe(held.length);

    // Each holder books THROUGH its hold (bypasses the capacity re-count). All win.
    for (const h of held) {
      const r = await admin.query<{ book_session: { booking_id?: string } }>(
        "select app.book_session($1, $2, $3, $4, $5, 'desk', $6, true) as book_session",
        [tenantId, h.personId, holdSession, operatorId, `storm-hold-book-${h.personId}`, h.holdId],
      );
      expect(r.rows[0]!.book_session.booking_id).toBeTruthy();
    }

    // The losers (no hold) now attempt to book — the seats are gone.
    const heldSet = new Set(held.map((h) => h.personId));
    const losers = holdPeople.filter((p) => !heldSet.has(p));
    for (const personId of losers) {
      let code: string | undefined;
      try {
        await admin.query(
          "select app.book_session($1, $2, $3, $4, $5, 'desk', null, true)",
          [tenantId, personId, holdSession, operatorId, `storm-hold-lose-${personId}`],
        );
        throw new Error("expected a session_full refusal but the booking succeeded");
      } catch (e) {
        code = (e as PgError).code;
      }
      expect(code).toBe(SESSION_FULL);
    }

    // Final truth: active bookings never exceeded capacity.
    const bookings = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.bookings where tenant_id = $1 and session_id = $2 and status in ('booked', 'checked_in')",
      [tenantId, holdSession],
    );
    expect(bookings.rows[0]!.n).toBe(held.length);
  });

  it("REPLAY STORM: 8 parallel book_session with ONE key → exactly 1 booking + 1 debit, same id every time", async () => {
    const KEY = "storm-replay-single-key";
    const calls = Array.from({ length: 8 }, () =>
      pool.query<{ book_session: { booking_id?: string } }>(
        "select app.book_session($1, $2, $3, $4, $5, 'desk', null, true) as book_session",
        [tenantId, replayPerson, replaySession, operatorId, KEY],
      ),
    );
    const settled = await Promise.allSettled(calls);

    // The key is idempotent: the unique-violation is caught IN-BODY and replayed,
    // so no call rejects.
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.map((r) => (r.reason as PgError).message)).toEqual([]);

    const ids = settled
      .filter(
        (s): s is PromiseFulfilledResult<{ rows: { book_session: { booking_id?: string } }[] }> =>
          s.status === "fulfilled",
      )
      .map((s) => s.value.rows[0]!.book_session.booking_id);
    expect(ids).toHaveLength(8);
    // Every one of the 8 calls returned the SAME booking id.
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();

    // Exactly one booking and exactly one debit were persisted for the key.
    const bookings = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.bookings where tenant_id = $1 and idempotency_key = $2",
      [tenantId, KEY],
    );
    expect(bookings.rows[0]!.n).toBe(1);

    const debits = await admin.query<{ n: number }>(
      "select count(*)::int as n from public.credit_ledger where tenant_id = $1 and person_id = $2 and entry_type = 'debit'",
      [tenantId, replayPerson],
    );
    expect(debits.rows[0]!.n).toBe(1);
  });
});
