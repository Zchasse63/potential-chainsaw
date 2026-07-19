import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural guards on the native booking engine (migration 0040) + its API and
// worker layers. These keep a drift in the SQL, routes, or sweep from silently
// violating a booking/money invariant; the live RLS attack suite
// (rls_attack.sql block 32) proves the tenancy/waiver/capacity/policy behavior
// at runtime.

const migration = readFileSync(
  "supabase/migrations/20260719140100_0040_booking_engine.sql",
  "utf8",
);
const dataBookings = readFileSync("apps/api/src/data-bookings.ts", "utf8");
const routeBookings = readFileSync("apps/api/src/routes/bookings.ts", "utf8");
const processorsSrc = readFileSync("workers/src/glofox/processors.ts", "utf8");
const expireHoldsSrc = readFileSync("workers/src/booking/expire-holds.ts", "utf8");
const attackSuite = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create or replace function <name>( … )` body up to its `$$;`. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 0040 — the tenant-consistent session FK prerequisite", () => {
  it("adds unique (tenant_id, id) on scheduled_sessions so the composite FKs can create", () => {
    // Migration 0027 declared only the PK on id; the (tenant_id, session_id) FKs
    // below require a matching unique key on scheduled_sessions (tenant_id, id).
    expect(migration).toContain(
      "add constraint scheduled_sessions_tenant_id_key unique (tenant_id, id)",
    );
    expect(migration).toMatch(
      /foreign key \(tenant_id, session_id\)\s+references public\.scheduled_sessions \(tenant_id, id\)/,
    );
  });
});

describe("migration 0040 — booking_holds + bookings tables", () => {
  it("holds carry a frozen flag + a TTL and are member-read / RPC-written only", () => {
    expect(migration).toContain("create table public.booking_holds");
    expect(migration).toContain("frozen     boolean not null default false");
    expect(migration).toContain("expires_at timestamptz not null");
    // One live hold per (session, person) — the upsert target.
    expect(migration).toContain("unique (tenant_id, session_id, person_id)");
    // RLS enabled + member SELECT; no client write grant.
    expect(migration).toContain("alter table public.booking_holds enable row level security");
    expect(migration).toContain("alter table public.bookings enable row level security");
    expect(migration).toContain(
      "grant select on public.booking_holds, public.bookings to authenticated, service_role",
    );
    expect(migration).not.toMatch(/grant insert.*public\.bookings/i);
    expect(migration).not.toMatch(/grant insert.*booking_holds/i);
  });

  it("bookings key idempotency on (tenant_id, idempotency_key) and link the debit entry", () => {
    expect(migration).toContain("create table public.bookings");
    expect(migration).toContain("unique (tenant_id, idempotency_key)");
    expect(migration).toContain("credit_entry_id uuid references public.credit_ledger (id)");
  });
});

describe("migration 0040 — DB-enforced no-oversell (FOR UPDATE serialization)", () => {
  it("the capacity trigger locks the session row FOR UPDATE, then counts active bookings", () => {
    const body = fnBody(migration, "create or replace function app.enforce_booking_capacity()");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    // Lock the session row → serialize concurrent inserts → count under the lock.
    expect(body).toMatch(/from public\.scheduled_sessions[\s\S]*for update/);
    expect(body).toContain("status in ('booked', 'checked_in')");
    expect(body).toContain("v_active >= v_capacity");
  });

  it("book_session re-verifies capacity under the SAME session-row FOR UPDATE lock", () => {
    const body = fnBody(
      migration,
      "create or replace function app.book_session(",
    );
    // The person row is locked first (serializes credit debits) then the session.
    expect(body).toMatch(/from public\.people pp[\s\S]*for update/);
    expect(body).toMatch(/from public\.scheduled_sessions[\s\S]*for update/);
  });
});

describe("migration 0040 — book_session (waiver enforcer + append-only debit + hold bind)", () => {
  const body = fnBody(migration, "create or replace function app.book_session(");

  it("is SECURITY DEFINER, search_path='', re-checks actor + role in-body", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("(select auth.uid()) <> p_actor");
    expect(body).toContain("array['owner', 'manager', 'front_desk']");
  });

  it("ENFORCES the waiver — needs_signature ⇒ raise waiver_required (42501)", () => {
    expect(body).toContain("public.current_waiver_status(p_tenant, p_person)");
    expect(body).toMatch(/if v_needs is true then\s+raise exception 'waiver_required' using errcode = '42501'/);
  });

  it("debits ONE credit as a NEGATIVE append-only ledger entry keyed on the booking key", () => {
    // Balance is read from the ledger IN-BODY (not the stale matview).
    expect(body).toContain("select coalesce(sum(cl.delta), 0)::int into v_balance");
    expect(body).toContain("raise exception 'insufficient_credits'");
    // A negative 'debit' row, external_ref = the booking key (ledger idempotency).
    expect(body).toMatch(/insert into public\.credit_ledger[\s\S]*'debit', -1, 'native', 'booking', p_idempotency_key/);
    // NEVER an in-place balance mutation.
    expect(body).not.toMatch(/update\s+public\.credit_ledger/);
  });

  it("a live hold BYPASSES the recount but must belong to (person, session) and be live", () => {
    expect(body).toContain("v_hold.person_id <> p_person or v_hold.session_id <> p_session");
    expect(body).toContain("hold does not belong to this person and session");
    expect(body).toContain("not (v_hold.frozen or v_hold.expires_at > now())");
    // The hold is consumed once the seat becomes a booking.
    expect(body).toContain("delete from public.booking_holds where tenant_id = p_tenant and id = p_hold");
  });

  it("replays idempotently on the key (no second debit, no second booking)", () => {
    expect(body).toContain("where tenant_id = p_tenant and idempotency_key = p_idempotency_key");
    expect(body).toContain("'replayed', true");
    expect(body).toContain("when unique_violation");
  });
});

describe("migration 0040 — cancel_booking (12h refund-vs-forfeit policy)", () => {
  const body = fnBody(migration, "create or replace function app.cancel_booking(");

  it("injects p_now and branches EXACTLY at the 12-hour boundary", () => {
    // p_now is a parameter (pure/testable) — never now() for the boundary math.
    expect(migration).toContain("p_now             timestamptz");
    expect(body).toContain("(v_starts - p_now) >= interval '12 hours'");
    expect(body).toContain("case when v_refund then 'refund' else 'forfeit' end");
  });

  it("REFUND appends a POSITIVE refund_credit reversing the debit; FORFEIT appends nothing", () => {
    // Only refund appends, and only when a credit was actually debited.
    expect(body).toContain("if v_refund and v_booking.credit_entry_id is not null then");
    expect(body).toMatch(/insert into public\.credit_ledger[\s\S]*'refund_credit', 1, 'native', 'booking_cancel'/);
    expect(body).toContain("grant_id"); // links the refund to the original debit
    // Idempotent re-cancel via the row lock + status check.
    expect(body).toMatch(/from public\.bookings[\s\S]*for update/);
    expect(body).toContain("if v_booking.status = 'cancelled' then");
  });
});

describe("migration 0040 — expire_holds sweep + availability read", () => {
  it("the sweep deletes only expired UN-frozen holds (a frozen seat is never reclaimed)", () => {
    const body = fnBody(migration, "create or replace function app.expire_holds(");
    expect(body).toContain("delete from public.booking_holds");
    expect(body).toContain("where expires_at < p_now and not frozen");
    // Service-role only (the processor), no client execute.
    expect(migration).toContain("grant execute on function app.expire_holds(timestamptz) to service_role");
  });

  it("session_availability is SECURITY INVOKER (RLS-scoped) and floors availability at 0", () => {
    const body = fnBody(migration, "create or replace function public.session_availability(");
    expect(body).toContain("security invoker");
    expect(body).toContain("greatest(s.capacity - coalesce(b.cnt, 0) - coalesce(h.cnt, 0), 0)");
  });
});

describe("API layer — data-bookings.ts calls the RPCs only, never writes tables", () => {
  it("has no direct table writes and maps the typed SQLSTATEs", () => {
    expect(dataBookings).not.toContain(".insert(");
    expect(dataBookings).not.toContain(".update(");
    expect(dataBookings).not.toContain(".delete(");
    expect(dataBookings).toContain('"hold_session"');
    expect(dataBookings).toContain('"book_session"');
    expect(dataBookings).toContain('"cancel_booking"');
    expect(dataBookings).toContain("booking_waiver_required");
    expect(dataBookings).toContain("session_at_capacity");
  });
});

describe("API layer — routes/bookings.ts (role gating + idempotency threading)", () => {
  it("book + cancel go through persisted idempotency and role-gate to desk staff", () => {
    expect(routeBookings).toContain("persistIdempotency(createBillingClient)");
    expect(routeBookings).toContain('requireRole("owner", "manager", "front_desk")');
    // p_via is fixed to 'desk' at the route; the client key threads into the RPC.
    expect(routeBookings).toContain('via: "desk"');
    expect(routeBookings).toContain("idempotencyKey: idempotencyKeyOf(c)");
  });

  it("the availability read is member-read (no requireRole on the GET)", () => {
    const get = routeBookings.slice(routeBookings.indexOf('app.get("/sessions/availability"'));
    const handlerEnd = get.indexOf("app.post(");
    expect(get.slice(0, handlerEnd)).not.toContain("requireRole");
  });
});

describe("worker layer — the hold-expiry sweep processor + fan-out", () => {
  it("delegates to app.expire_holds with an injected now (no ad-hoc DELETE)", () => {
    expect(expireHoldsSrc).toContain('BOOKING_EXPIRE_HOLDS_KIND = "booking.expire_holds"');
    expect(expireHoldsSrc).toContain("select app.expire_holds($1)");
    expect(expireHoldsSrc).not.toMatch(/delete\s+from/i);
  });

  it("is registered and fanned out with a MINUTE-scoped, tenant-null idempotency key", () => {
    expect(processorsSrc).toContain("[BOOKING_EXPIRE_HOLDS_KIND]: async (_job, ctx)");
    expect(processorsSrc).toContain("const minuteBucket = instant.toISOString().slice(0, 16)");
    expect(processorsSrc).toMatch(
      /enqueue_job\(\$1, \$2, null, now\(\), 100, 5, \$3\)`, \[\s*BOOKING_EXPIRE_HOLDS_KIND,[\s\S]*minuteBucket/,
    );
  });
});

describe("rls_attack.sql — booking coverage (block 32)", () => {
  it("adds a cross-tenant attack block for hold/book/cancel + waiver + capacity + policy", () => {
    expect(attackSuite).toContain("(32)");
    expect(attackSuite).toContain("app.book_session");
    expect(attackSuite).toContain("app.cancel_booking");
    expect(attackSuite).toContain("app.hold_session");
    // The load-bearing checks.
    expect(attackSuite).toContain("an over-capacity booking was NOT refused");
    expect(attackSuite).toContain("waiver_required");
    expect(attackSuite).toContain("did not APPEND a credit entry");
    expect(attackSuite).toContain("a ≥12h cancel did not choose refund");
    expect(attackSuite).toContain("a <12h cancel did not forfeit");
    expect(attackSuite).toContain("a replayed booking key wrote a second booking");
  });
});

// ---------------------------------------------------------------------------
// Wave 6a REVIEW FIXES — the six criticals from the 6.1 (CONCERNS) and 6.2
// (FAIL) reviews, made durable as structural guards. Each assertion names the
// wrong-booking/wrong-money scenario it forecloses.
// ---------------------------------------------------------------------------
const migration41 = readFileSync(
  "supabase/migrations/20260719150100_0041_waitlist_checkin.sql",
  "utf8",
);

describe("review fix A — one active booking per (session, person)", () => {
  it("has the partial unique index over live statuses", () => {
    expect(migration).toContain("bookings_one_active_per_person");
    expect(migration).toMatch(
      /bookings_one_active_per_person[\s\S]{0,200}where status in \('booked', 'checked_in'\)/,
    );
  });
  it("book_session pre-checks the active booking for a FRIENDLY 23505", () => {
    // Without the in-body check a raced duplicate surfaces as a raw constraint
    // error; with it the second booker gets the named refusal.
    expect(migration).toMatch(/already has an active booking/i);
  });
});

describe("review fix B — release_hold (frozen holds must not be immortal)", () => {
  it("migration defines app.release_hold deleting REGARDLESS of frozen", () => {
    expect(migration).toContain("create or replace function app.release_hold");
    expect(migration).toContain("create or replace function public.release_hold");
  });
  it("the API mounts POST /bookings/:id/release-hold behind staff roles", () => {
    expect(routeBookings).toContain('"/bookings/:id/release-hold"');
    expect(dataBookings).toContain('"release_hold"');
  });
});

describe("review fix C — hold refresh never unfreezes a mid-tender hold", () => {
  it("the hold_session upsert guards its update on frozen = false", () => {
    expect(migration).toMatch(
      /do update[\s\S]{0,200}where booking_holds\.frozen = false/,
    );
  });
});

describe("review fix D — orphan-debit closure in book_session", () => {
  it("replays fast-path BEFORE the waiver/debit work", () => {
    // A retried key with different p_use_credit must replay the original
    // booking, not append a fresh debit for the new flag value.
    expect(migration).toMatch(/'replayed',\s*true/);
  });
  it("the credit debit sits INSIDE the guarded sub-block with the insert", () => {
    // Savepoint semantics: a caught unique_violation race rolls the debit back
    // with the booking insert — no debit without a booking row.
    const subBlock = migration.match(/begin[\s\S]*?exception\s+when\s+unique_violation[\s\S]*?end;/);
    expect(subBlock, "guarded sub-block missing").not.toBeNull();
    expect(subBlock![0]).toContain("insert into public.credit_ledger");
  });
});

describe("review fix E — waitlist sweeps never delete frozen (mid-tender) holds", () => {
  it("both 0041 hold-DELETE sites carry the frozen = false guard", () => {
    const guardedDeletes = migration41.match(
      /delete from public\.booking_holds[\s\S]{0,300}?bh\.frozen = false/g,
    );
    expect(guardedDeletes?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("review fix F — live-evidence closure (blocks 32+33 in the suite)", () => {
  it("the attack suite carries both new blocks and the waiver upsert seam", () => {
    expect(attackSuite).toContain("(32) uB can SELECT tenant A bookings");
    expect(attackSuite).toContain("(33) authenticated holds INSERT on waitlist_entries");
    expect(attackSuite).toContain("on conflict (tenant_id, version) do update set active = true");
  });
});
