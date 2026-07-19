import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Phase 6 · unit 6.2 — structural guards on the waitlist/check-in migration
 * (0041) and its API/worker wiring. The live behavior (FIFO promotion, offer
 * expiry, the check-in window, cross-tenant refusal) is proven at runtime by
 * rls_attack.sql block 33; these guards keep the SQL from silently drifting off
 * unit 6.1's ACTUAL contract (migration 0040) — the durable form of the 5.3/5.4
 * "copied-body drift" lesson.
 */

const m0040 = readFileSync("supabase/migrations/20260719140100_0040_booking_engine.sql", "utf8");
const m0041 = readFileSync("supabase/migrations/20260719150100_0041_waitlist_checkin.sql", "utf8");
const route = readFileSync("apps/api/src/routes/waitlist.ts", "utf8");
const appTs = readFileSync("apps/api/src/app.ts", "utf8");
const sweeps = readFileSync("workers/src/booking/sweeps.ts", "utf8");
const fanOut = readFileSync("workers/src/glofox/processors.ts", "utf8");
const attack = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Count non-overlapping occurrences of a literal substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Slice one `create or replace function <signature> … $$;` body. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("cancel_booking 0040↔0041 drift tripwire (the 5.3/5.4 lesson)", () => {
  it("defines app.cancel_booking EXACTLY ONCE — only in 0040 (the owning unit)", () => {
    expect(count(m0040, "create or replace function app.cancel_booking(")).toBe(1);
  });

  it("0041 NEVER re-declares cancel_booking — no copied body means no drift is possible", () => {
    // The crashed run's hazard was copying 0040's cancel body into 0041 and
    // letting it diverge. 6.2 instead promotes off the seat-opening TRANSITION.
    expect(m0041).not.toContain("function app.cancel_booking");
    expect(m0041).not.toContain("create or replace function public.cancel_booking");
  });

  it("0041 wires promotion via an AFTER UPDATE trigger on the cancel transition", () => {
    expect(m0041).toContain("create or replace trigger bookings_promote_waitlist_on_cancel");
    expect(m0041).toMatch(/after update on public\.bookings/);
    const tg = fnBody(m0041, "function app.tg_promote_waitlist_on_seat_open()");
    expect(tg).toContain("new.status = 'cancelled'");
    expect(tg).toContain("old.status is distinct from 'cancelled'");
    expect(tg).toContain("app.promote_waitlist");
  });
});

describe("0041 codes against 0040's ACTUAL contract (no imagined 6.1 shapes)", () => {
  it("uses the app.open_seats scalar guard, never a phantom app.session_availability(session) call", () => {
    // 0040 exposes only public.session_availability(tenant, from, to) over a RANGE.
    expect(m0041).not.toContain("app.session_availability(");
    expect(m0041).toContain("create or replace function app.open_seats(");
    const join = fnBody(m0041, "function app.join_waitlist(");
    expect(join).toContain("app.open_seats(p_tenant, p_session, now())");
    const promote = fnBody(m0041, "function app.promote_waitlist(");
    expect(promote).toContain("app.open_seats(p_tenant, p_session, p_now)");
  });

  it("books through 0040's book_session signature (person before session, JSONB return)", () => {
    const accept = fnBody(m0041, "function app.accept_waitlist_offer(");
    // 0040 order: (p_tenant, p_person, p_session, p_actor, p_idem, p_via, p_hold, p_use_credit)
    expect(accept).toMatch(/app\.book_session\(\s*p_tenant, v_entry\.person_id, v_entry\.session_id, p_actor/);
    // 0040 returns JSONB — the id is extracted, never assigned as a bare uuid.
    expect(accept).toContain("->> 'booking_id'");
    // 'front_desk' is NOT a valid 0040 via — the desk default is 'desk'.
    expect(m0041).not.toContain("default 'front_desk'");
  });

  it("reserves + releases the offer seat with a 0040-shape ephemeral hold (no status column)", () => {
    // 0040 booking_holds has NO status/purpose columns — a hold is DELETED to free.
    expect(m0041).not.toContain("bh.status");
    expect(m0041).toContain("insert into public.booking_holds (tenant_id, session_id, person_id, expires_at, frozen)");
    const decline = fnBody(m0041, "function app.decline_waitlist_offer(");
    expect(decline).toContain("delete from public.booking_holds");
    const expire = fnBody(m0041, "function app.decline_or_expire_offers(");
    expect(expire).toContain("delete from public.booking_holds");
  });
});

describe("0041 invariants: waitlist gate, check-in window, no-show forfeit", () => {
  it("join requires a FULL session (open seats refused)", () => {
    const join = fnBody(m0041, "function app.join_waitlist(");
    expect(join).toMatch(/if v_avail > 0 then/);
    expect(join).toContain("book the open seat instead of waitlisting");
  });

  it("check_in enforces the [start-60min, end] arrival window and is idempotent", () => {
    const ci = fnBody(m0041, "function app.check_in(");
    expect(ci).toContain("v_starts - interval '60 minutes'");
    expect(ci).toContain("p_now > v_ends");
    expect(ci).toContain("if v_status = 'checked_in' then"); // idempotent re-check-in
  });

  it("mark_no_shows never touches checked_in/cancelled and writes NO credit refund", () => {
    const ns = fnBody(m0041, "function app.mark_no_shows(");
    expect(ns).toContain("b.status = 'booked'"); // only booked → no_show
    expect(ns).toContain("s.ends_at < p_now - interval '30 minutes'");
    // The forfeit is a booking-detail money event; no refund row is appended.
    expect(ns).not.toContain("insert into public.credit_ledger");
    expect(ns).toContain("no_show_forfeit");
  });

  it("the offer comms is a transactional (quiet-hours-EXEMPT) global template", () => {
    expect(m0041).toContain("'waitlist_offer'");
    expect(m0041).toMatch(/'email', 'transactional'/);
    const promote = fnBody(m0041, "function app.promote_waitlist(");
    expect(promote).toContain("into public.comms_log");
    expect(promote).toContain("app.enqueue_job");
  });
});

describe("0041 RLS + grants (invariant #7)", () => {
  it("enables RLS + a select policy on waitlist_entries and grants NO client write", () => {
    expect(m0041).toContain("alter table public.waitlist_entries enable row level security");
    expect(m0041).toContain("create policy waitlist_entries_select on public.waitlist_entries");
    expect(m0041).toContain("grant select on public.waitlist_entries to authenticated, service_role");
    expect(m0041).not.toMatch(/grant insert[^;]*waitlist_entries/i);
    expect(m0041).not.toMatch(/grant update[^;]*waitlist_entries/i);
    expect(m0041).not.toMatch(/grant delete[^;]*waitlist_entries/i);
  });

  it("keeps the sweeps service-role only; member RPCs reach authenticated", () => {
    expect(m0041).toContain("grant execute on function app.promote_waitlist(uuid, uuid, timestamptz, int) to service_role");
    expect(m0041).toContain("grant execute on function app.mark_no_shows(uuid, timestamptz) to service_role");
    expect(m0041).toContain("grant execute on function public.join_waitlist(uuid, uuid, uuid, uuid, text) to authenticated, service_role");
  });
});

describe("API + worker wiring", () => {
  it("mounts the waitlist routes with persisted idempotency + the desk roles", () => {
    expect(appTs).toContain("registerWaitlistRoutes(app, resolved, deps.createBillingClient)");
    expect(route).toContain("persistIdempotency(createBillingClient)");
    expect(route).toContain('requireRole("owner", "manager", "front_desk")');
    for (const path of ["/waitlist/join", "/waitlist/:id/accept", "/waitlist/:id/decline", "/waitlist/position", "/bookings/:id/check-in", "/sessions/:id/roster"]) {
      expect(route).toContain(`"${path}"`);
    }
  });

  it("registers both sweeps on the ONE fan-out (invariant #4): minute waitlist + daily no-show", () => {
    expect(sweeps).toContain("app.decline_or_expire_offers(now())");
    expect(sweeps).toContain("app.mark_no_shows($1::uuid, now())");
    expect(fanOut).toContain("WAITLIST_SWEEP_KIND");
    expect(fanOut).toContain("NO_SHOW_SWEEP_KIND");
    expect(fanOut).toMatch(/minuteBucket/);
  });

  it("has an attack-suite block 33 exercising the waitlist/check-in surface", () => {
    expect(attack).toContain("(33)");
    for (const rpc of ["join_waitlist", "accept_waitlist_offer", "check_in", "mark_no_shows"]) {
      expect(attack).toContain(rpc);
    }
  });
});
