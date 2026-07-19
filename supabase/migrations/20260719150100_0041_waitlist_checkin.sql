-- Phase 6 · unit 6.2 — WAITLIST + CHECK-IN + the NO-SHOW POLICY ENGINE.
--
-- This migration builds ON unit 6.1's native booking engine (migration 0040:
-- booking_holds, bookings, app.hold_session / app.book_session / app.cancel_booking /
-- public.session_availability). 0041 applies AFTER 0040. The 6.1 contract this unit
-- codes against — RECONCILED to 0040's ACTUAL shapes (the crashed run drafted 0041
-- against an imagined contract; the availability signature, book_session shape, and
-- booking_holds columns were all wrong and are corrected here — the 5.3/5.4 drift
-- lesson made durable). The load-bearing facts:
--
--   public.bookings (0040)
--     (id, tenant_id, session_id → public.scheduled_sessions, person_id,
--      status text in ('booked','cancelled','checked_in','no_show') — this unit
--      drives the last three; booked_via text in
--      ('desk','member_web','member_ios','member_android','import'),
--      credit_entry_id, hold_id uuid, idempotency_key, detail jsonb, checked_in_at,
--      created_at, updated_at, unique(tenant_id, id), unique(tenant_id, idempotency_key)).
--     0040 already declares checked_in_at + detail; this unit DEFENSIVELY
--     `add column if not exists` no_show_at (+ the other two as no-ops).
--
--   public.booking_holds (0040)
--     (id, tenant_id, session_id, person_id, expires_at timestamptz,
--      frozen boolean default false, created_at; unique(tenant_id, session_id,
--      person_id); unique(tenant_id, id)). Holds are EPHEMERAL — there is NO status
--      column: a hold is DELETED to release/consume it. Availability counts a hold
--      as consuming a seat while (frozen OR expires_at > now). The waitlist offer
--      reserves its seat with a normal 0040 hold whose expires_at IS the offer
--      window; releasing an offer DELETES the hold.
--
--   app.open_seats(p_tenant, p_session, p_now) returns int  — DEFINED BELOW (0040
--      exposes only public.session_availability(tenant, from, to) over a RANGE,
--      which is the wrong shape for a single-session guard). capacity − active
--      bookings − live holds; <= 0 means FULL. Waitlisting is legal ONLY when full.
--
--   app.book_session(p_tenant, p_person, p_session, p_actor, p_idempotency_key,
--       p_via, p_hold default null, p_use_credit default true) returns JSONB
--       {booking_id, credit_entry_id?, replayed?}
--       — enforces the booking-time WAIVER block (via public.current_waiver_status),
--       capacity/exclusion (DB-enforced no-oversell), debits the append-only
--       credit_ledger, CONSUMES (deletes) p_hold when supplied. Idempotent on
--       (tenant, idempotency_key). p_via MUST be one of 0040's channels ('desk',
--       'member_*','import') — 'front_desk' is NOT valid there. This unit's
--       promotion-accept path books through it, so the waiver is enforced there —
--       joining a waitlist never is.
--
--   app.cancel_booking(p_tenant, p_booking, p_actor, p_idempotency_key, p_now)
--       — frees a seat by setting bookings.status = 'cancelled'. The waitlist
--       promotion runs off THAT transition (the AFTER UPDATE trigger below), so this
--       unit does NOT rewrite cancel_booking's body — copying it would manufacture
--       exactly the drift we keep catching. promote_waitlist is availability-guarded,
--       so it stays an idempotent no-op even if a future cancel tail also calls it.
--
-- INVARIANTS honored: every mutation is a definer RPC that re-verifies tenancy
-- in-body with an idempotency key; RLS + policy on the new tenant table; the
-- offer HOLD (not a mutable flag) reserves the promoted seat so 6.1's availability
-- math already accounts for it; the no-show forfeit is a MONEY event recorded as
-- booking detail (the credit was already debited at book time — no refund row).

-- ===========================================================================
-- 0) Columns this unit needs on 6.1's bookings (idempotent; no-ops if present).
-- ===========================================================================
alter table public.bookings add column if not exists checked_in_at timestamptz;
alter table public.bookings add column if not exists no_show_at    timestamptz;
alter table public.bookings add column if not exists detail         jsonb not null default '{}'::jsonb;

-- ===========================================================================
-- 0b) app.open_seats — single-session availability guard (0040 exposes only the
--     RANGE-shaped public.session_availability(tenant, from, to); this unit needs
--     a scalar seat count for ONE session under a caller-held session lock). It
--     mirrors 0040's exact capacity math: active bookings (booked|checked_in) plus
--     LIVE holds (frozen OR unexpired) subtracted from capacity. <= 0 means FULL.
--     Internal — the definer callers below run as the owner; no client grant.
-- ===========================================================================
create or replace function app.open_seats(
  p_tenant  uuid,
  p_session uuid,
  p_now     timestamptz
)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select s.capacity
    - coalesce((
        select count(*) from public.bookings b
        where b.tenant_id = p_tenant and b.session_id = p_session
          and b.status in ('booked', 'checked_in')
      ), 0)
    - coalesce((
        select count(*) from public.booking_holds h
        where h.tenant_id = p_tenant and h.session_id = p_session
          and (h.frozen or h.expires_at > p_now)
      ), 0)
  from public.scheduled_sessions s
  where s.tenant_id = p_tenant and s.id = p_session;
$$;

comment on function app.open_seats(uuid, uuid, timestamptz) is
  'Scalar seat availability for ONE session (0040 only ships the range-shaped public.session_availability). capacity − active bookings − live holds; <= 0 is FULL. Used by app.join_waitlist (full-required) and app.promote_waitlist (seat-open guard). Internal; the definer callers own it.';

-- ===========================================================================
-- 1) waitlist_entries — FIFO queue per session.
-- ===========================================================================
create table public.waitlist_entries (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  session_id        uuid not null references public.scheduled_sessions (id) on delete cascade,
  person_id         uuid not null references public.people (id) on delete restrict,
  -- FIFO ordinal assigned at join under the session row lock (monotonic per
  -- session; declined/expired ordinals are never reused).
  position          int not null check (position > 0),
  -- Set only while status = 'offered': the moment the offer hold lapses.
  offer_expires_at  timestamptz,
  -- The offer HOLD (public.booking_holds) that reserves the promoted seat.
  hold_id           uuid,
  status            text not null default 'waiting'
                    check (status in ('waiting','offered','promoted','declined','expired','cancelled')),
  -- Makes join idempotent across a retried request (invariant: RPC + idem key).
  idempotency_key   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'offered' or offer_expires_at is not null)
);

-- At most ONE live entry (waiting or offered) per person per session.
create unique index waitlist_entries_active_person_key
  on public.waitlist_entries (tenant_id, session_id, person_id)
  where status in ('waiting','offered');

-- Idempotent join: the same key never enqueues a second entry.
create unique index waitlist_entries_tenant_idem_key
  on public.waitlist_entries (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index waitlist_entries_session_status_pos_idx
  on public.waitlist_entries (tenant_id, session_id, status, position);
create index waitlist_entries_offer_expiry_idx
  on public.waitlist_entries (offer_expires_at)
  where status = 'offered';

create or replace trigger waitlist_entries_touch_updated_at
  before update on public.waitlist_entries
  for each row execute function app.touch_updated_at();

comment on table public.waitlist_entries is
  'FIFO per-session waitlist. Joining requires the session to be FULL (6.1 availability = 0) and does NOT require the waiver; the waiver is enforced at promotion-accept through app.book_session. A promotion creates an offer HOLD (booking_holds) so 6.1 availability already reserves the seat — never a silent charge on a stale request.';

-- ===========================================================================
-- 2) join_waitlist — enqueue a person on a FULL session (FIFO position).
-- ===========================================================================
create or replace function app.join_waitlist(
  p_tenant          uuid,
  p_session         uuid,
  p_person          uuid,
  p_actor           uuid,
  p_idempotency_key text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_avail    int;
  v_position int;
  v_status   text;
  v_starts   timestamptz;
begin
  -- Actor + role (desk surface: owner/manager/front_desk book-for-someone).
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'join actor must be the authenticated user' using errcode = '42501';
  end if;
  if not app.has_tenant_role(p_tenant, array['owner','manager','front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;

  -- The person must belong to this tenant (never an identifier oracle).
  if not exists (select 1 from public.people p where p.tenant_id = p_tenant and p.id = p_person) then
    raise exception 'person not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: same key → the position already assigned.
  select we.position into v_position
  from public.waitlist_entries we
  where we.tenant_id = p_tenant and we.idempotency_key = p_idempotency_key;
  if found then
    return v_position;
  end if;

  -- Lock the session row: serializes availability read + position assignment so
  -- two concurrent joiners cannot collide on availability=0 or a position.
  select s.status, s.starts_at into v_status, v_starts
  from public.scheduled_sessions s
  where s.tenant_id = p_tenant and s.id = p_session
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_status <> 'published' then
    raise exception 'session is not published' using errcode = '22023';
  end if;
  if v_starts <= now() then
    raise exception 'cannot waitlist a session that has started' using errcode = '22023';
  end if;

  -- Waitlisting an OPEN session is a defect — the seat should be BOOKED, not queued.
  v_avail := app.open_seats(p_tenant, p_session, now());
  if v_avail > 0 then
    raise exception 'session is not full — book the open seat instead of waitlisting'
      using errcode = '22023';
  end if;

  -- Already queued (live entry)? Hand back the existing position.
  select we.position into v_position
  from public.waitlist_entries we
  where we.tenant_id = p_tenant and we.session_id = p_session and we.person_id = p_person
    and we.status in ('waiting','offered');
  if found then
    return v_position;
  end if;

  -- Next FIFO ordinal (monotonic across the session's whole history).
  select coalesce(max(we.position), 0) + 1 into v_position
  from public.waitlist_entries we
  where we.tenant_id = p_tenant and we.session_id = p_session;

  insert into public.waitlist_entries
    (tenant_id, session_id, person_id, position, status, idempotency_key)
  values
    (p_tenant, p_session, p_person, v_position, 'waiting', p_idempotency_key);

  return v_position;
end;
$$;

-- ===========================================================================
-- 3) promote_waitlist — offer the seat to the first waiter (called on a seat
--    opening). Availability-guarded ⇒ idempotent: a second call for one opening
--    sees the seat already reserved by the offer hold and promotes nobody.
-- ===========================================================================
create or replace function app.promote_waitlist(
  p_tenant                uuid,
  p_session               uuid,
  p_now                   timestamptz,
  p_offer_window_minutes  int default 30
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry     public.waitlist_entries;
  v_hold_id   uuid;
  v_expires   timestamptz;
  v_first     text;
  v_studio    text;
  v_email     text;
  v_log_id    uuid;
  v_body      text;
begin
  -- Serialize against concurrent openings/joins on this session.
  perform 1 from public.scheduled_sessions s
  where s.tenant_id = p_tenant and s.id = p_session
  for update;
  if not found then
    return null;
  end if;

  -- No open seat ⇒ nothing to offer. This is the idempotency guard: an offer
  -- hold created by an earlier invocation consumes availability, so a repeat
  -- call (e.g. cancel tail + trigger) offers nobody.
  if app.open_seats(p_tenant, p_session, p_now) <= 0 then
    return null;
  end if;

  -- First still-waiting entry, FIFO.
  select we.* into v_entry
  from public.waitlist_entries we
  where we.tenant_id = p_tenant and we.session_id = p_session and we.status = 'waiting'
  order by we.position asc
  limit 1
  for update skip locked;
  if not found then
    return null;
  end if;

  v_expires := p_now + make_interval(mins => p_offer_window_minutes);

  -- The offer HOLD reserves the seat (0040 availability counts a hold while
  -- frozen OR unexpired). Inserted directly — the sweep that promotes the next
  -- waiter runs headless (no JWT), and app.hold_session enforces auth.uid() =
  -- actor which no service context can satisfy. This definer already re-verified
  -- tenancy, honoring the same server-hold invariant. expires_at IS the offer
  -- window. 0040's one-live-hold-per-(session,person) unique is upserted (a fresh
  -- offer resets any stale hold for this person; frozen is cleared).
  insert into public.booking_holds (tenant_id, session_id, person_id, expires_at, frozen)
  values (p_tenant, p_session, v_entry.person_id, v_expires, false)
  on conflict (tenant_id, session_id, person_id)
  do update set expires_at = excluded.expires_at, frozen = false
  returning id into v_hold_id;

  update public.waitlist_entries we
  set status = 'offered', offer_expires_at = v_expires, hold_id = v_hold_id
  where we.id = v_entry.id;

  -- Transactional offer comms — quiet-hours EXEMPT: an offer is time-critical
  -- (classifyMessageKind maps a non-dunning, non-campaign row to 'transactional',
  -- which the send policy never defers). Enqueued only for a deliverable email.
  select p.email::text, p.first_name, t.name
  into v_email, v_first, v_studio
  from public.people p
  join public.tenants t on t.id = p_tenant
  where p.tenant_id = p_tenant and p.id = v_entry.person_id;

  if v_email is not null and v_email <> '' then
    v_body := 'Hi ' || coalesce(nullif(v_first, ''), 'there')
      || ', a spot just opened at ' || coalesce(v_studio, 'the studio')
      || '. It is held for you until '
      || to_char(v_expires at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC. '
      || 'Confirm before then to claim it.';

    insert into public.comms_log
      (tenant_id, person_id, channel, direction, template_key,
       subject, body_preview, to_address, status)
    values
      (p_tenant, v_entry.person_id, 'email', 'outbound', 'waitlist_offer',
       'A spot opened at ' || coalesce(v_studio, 'the studio'),
       left(v_body, 200), v_email, 'queued')
    returning id into v_log_id;

    perform app.enqueue_job(
      'comms.send', jsonb_build_object('comms_log_id', v_log_id),
      p_tenant, now(), 100, 5, 'comms.send:' || v_log_id::text
    );
  end if;

  return v_entry.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Promote off the seat-opening transition, DECOUPLED from 6.1's cancel body
-- (no copy-exactly hazard). AFTER UPDATE so session_availability already sees the
-- freed seat. Fires only on the transition INTO 'cancelled'; promote_waitlist is
-- availability-guarded so a 6.1 cancel-tail call cannot double-promote.
-- ---------------------------------------------------------------------------
create or replace function app.tg_promote_waitlist_on_seat_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform app.promote_waitlist(new.tenant_id, new.session_id, now());
  end if;
  return new;
end;
$$;

create or replace trigger bookings_promote_waitlist_on_cancel
  after update on public.bookings
  for each row execute function app.tg_promote_waitlist_on_seat_open();

-- ===========================================================================
-- 4) accept_waitlist_offer — book through app.book_session, consuming the offer
--    hold. The waiver is enforced inside book_session. status → 'promoted'.
-- ===========================================================================
create or replace function app.accept_waitlist_offer(
  p_tenant          uuid,
  p_entry           uuid,
  p_actor           uuid,
  p_idempotency_key text,
  p_via             text default 'desk'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry   public.waitlist_entries;
  v_booking uuid;
  v_result  jsonb;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'accept actor must be the authenticated user' using errcode = '42501';
  end if;
  if not app.has_tenant_role(p_tenant, array['owner','manager','front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;

  select we.* into v_entry
  from public.waitlist_entries we
  where we.tenant_id = p_tenant and we.id = p_entry
  for update;
  if not found then
    raise exception 'waitlist entry not found' using errcode = 'P0002';
  end if;

  -- Idempotent double-accept: already promoted ⇒ return the same booking.
  if v_entry.status = 'promoted' then
    select b.id into v_booking
    from public.bookings b
    where b.tenant_id = p_tenant and b.hold_id = v_entry.hold_id;
    return v_booking;
  end if;

  if v_entry.status <> 'offered' then
    raise exception 'waitlist entry has no live offer' using errcode = '22023';
  end if;
  if v_entry.offer_expires_at is not null and v_entry.offer_expires_at <= now() then
    raise exception 'the offer window has expired' using errcode = '22023';
  end if;

  -- Book through 6.1's RPC (0040 shape: p_tenant, p_person, p_session, p_actor,
  -- p_idempotency_key, p_via, p_hold, p_use_credit → JSONB). Waiver, capacity/
  -- exclusion, the credit debit, and hold consumption (delete) all live there. The
  -- person books for themselves; the offer hold is passed so book_session bypasses
  -- the capacity re-count (the seat was reserved) and consumes it. p_via must be a
  -- 0040 channel — the SQL wrapper defaults 'desk'; book_session rejects anything
  -- else with 22023, surfaced to the caller unchanged.
  v_result := app.book_session(
    p_tenant, v_entry.person_id, v_entry.session_id, p_actor,
    p_idempotency_key, p_via, v_entry.hold_id, true
  );
  v_booking := (v_result ->> 'booking_id')::uuid;

  update public.waitlist_entries we
  set status = 'promoted'
  where we.id = v_entry.id;

  return v_booking;
end;
$$;

-- ===========================================================================
-- 5) decline_waitlist_offer — the member/desk declines an offer explicitly.
--    Releases the offer hold and cascades to the next waiter immediately.
-- ===========================================================================
create or replace function app.decline_waitlist_offer(
  p_tenant uuid,
  p_entry  uuid,
  p_actor  uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.waitlist_entries;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'decline actor must be the authenticated user' using errcode = '42501';
  end if;
  if not app.has_tenant_role(p_tenant, array['owner','manager','front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;

  select we.* into v_entry
  from public.waitlist_entries we
  where we.tenant_id = p_tenant and we.id = p_entry
  for update;
  if not found then
    raise exception 'waitlist entry not found' using errcode = 'P0002';
  end if;

  -- Idempotent: declining an already-declined entry is a no-op.
  if v_entry.status = 'declined' then
    return;
  end if;
  if v_entry.status <> 'offered' then
    raise exception 'waitlist entry has no live offer to decline' using errcode = '22023';
  end if;

  -- Release the offer hold (frees the seat) and mark the entry declined. 0040
  -- holds are ephemeral — releasing DELETES the hold (there is no status column),
  -- which immediately restores availability for the cascade below.
  -- REVIEW FIX (6.2-crit-5): a FROZEN hold is mid-tender (the member is paying
  -- for the promoted seat) — deleting it here would reclaim a seat whose
  -- payment then completes paid-but-unbooked. Frozen holds are released only by
  -- book_session (consume) or the operator (app.release_hold).
  if v_entry.hold_id is not null then
    delete from public.booking_holds bh
    where bh.tenant_id = p_tenant and bh.id = v_entry.hold_id
      and bh.frozen = false;
  end if;

  update public.waitlist_entries we
  set status = 'declined'
  where we.id = v_entry.id;

  -- Cascade the freed seat to the next waiter now (not only on the next sweep).
  perform app.promote_waitlist(p_tenant, v_entry.session_id, now());
end;
$$;

-- ===========================================================================
-- 6) decline_or_expire_offers — the sweep (processor booking.waitlist_sweep,
--    frequent fan-out). Lapsed offers release their hold and cascade-promote the
--    next waiter. Bounded loop: each iteration terminally settles one entry.
-- ===========================================================================
create or replace function app.decline_or_expire_offers(p_now timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry   public.waitlist_entries;
  v_settled int := 0;
  v_guard   int := 0;
begin
  loop
    -- Next lapsed offer, FIFO within each session. A newly promoted entry gets an
    -- offer_expires_at in the FUTURE (p_now + window) so it is never re-selected
    -- in the same pass — the loop terminates without the guard, which is only a
    -- belt-and-suspenders bound against a pathological data state.
    select we.* into v_entry
    from public.waitlist_entries we
    where we.status = 'offered'
      and we.offer_expires_at is not null
      and we.offer_expires_at <= p_now
    order by we.tenant_id, we.session_id, we.position
    limit 1
    for update skip locked;
    exit when not found;

    v_guard := v_guard + 1;
    exit when v_guard > 10000;

    -- Release the lapsed hold (0040 holds are ephemeral — DELETE frees the seat)
    -- and mark the offer expired.
    -- REVIEW FIX (6.2-crit-5): frozen (mid-tender) holds survive the sweep too.
    if v_entry.hold_id is not null then
      delete from public.booking_holds bh
      where bh.tenant_id = v_entry.tenant_id and bh.id = v_entry.hold_id
        and bh.frozen = false;
    end if;

    update public.waitlist_entries we
    set status = 'expired'
    where we.id = v_entry.id;

    -- The seat is free again: offer it to the next waiter.
    perform app.promote_waitlist(v_entry.tenant_id, v_entry.session_id, p_now);

    v_settled := v_settled + 1;
  end loop;

  return v_settled;
end;
$$;

-- ===========================================================================
-- 7) check_in — desk check-in for a booked attendee within the arrival window.
-- ===========================================================================
create or replace function app.check_in(
  p_tenant  uuid,
  p_booking uuid,
  p_actor   uuid,
  p_now     timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_starts timestamptz;
  v_ends   timestamptz;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'check-in actor must be the authenticated user' using errcode = '42501';
  end if;
  if not app.has_tenant_role(p_tenant, array['owner','manager','front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;

  select b.status, s.starts_at, s.ends_at
  into v_status, v_starts, v_ends
  from public.bookings b
  join public.scheduled_sessions s on s.id = b.session_id
  where b.tenant_id = p_tenant and b.id = p_booking
  for update of b;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;

  -- Idempotent re-check-in: already checked in ⇒ no-op success.
  if v_status = 'checked_in' then
    return 'checked_in';
  end if;
  if v_status <> 'booked' then
    raise exception 'only a booked attendee can be checked in' using errcode = '22023';
  end if;

  -- Arrival window: session start − 60min .. session end.
  if p_now < v_starts - interval '60 minutes' or p_now > v_ends then
    raise exception 'check-in is outside the arrival window' using errcode = '22023';
  end if;

  update public.bookings b
  set status = 'checked_in', checked_in_at = p_now
  where b.tenant_id = p_tenant and b.id = p_booking;

  return 'checked_in';
end;
$$;

comment on function app.check_in(uuid, uuid, uuid, timestamptz) is
  'Desk check-in: booked → checked_in within [start−60min, end]; idempotent re-check-in no-ops. DEGRADED MODE is a CLIENT concern — the roster screen (wave 6b) queues check-ins locally and replays them through this RPC; the RPC itself stays simple and authoritative.';

-- ===========================================================================
-- 8) mark_no_shows — the no-show-as-money-event sweep (processor
--    booking.no_show_sweep, DAILY fan-out). A booked attendee whose session
--    ended > 30min ago becomes 'no_show'; the credit is NOT refunded (it was
--    already debited at book time — owner default: forfeit, no cash fee v1).
-- ===========================================================================
create or replace function app.mark_no_shows(
  p_tenant uuid,
  p_now    timestamptz
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.bookings b
  set status  = 'no_show',
      no_show_at = p_now,
      -- The forfeit is a money event recorded on the booking: no credit_ledger
      -- refund row is written (the debit stands). This is the owner default.
      detail = coalesce(b.detail, '{}'::jsonb)
               || jsonb_build_object('policy', 'no_show_forfeit', 'marked_at', p_now)
  from public.scheduled_sessions s
  where s.id = b.session_id
    and b.tenant_id = p_tenant
    and b.status = 'booked'
    and s.ends_at < p_now - interval '30 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.mark_no_shows(uuid, timestamptz) is
  'No-show-as-money-event: booked → no_show for sessions ended > 30min ago. NO credit refund (the credit was debited at book time; owner default is forfeit, no cash fee in v1). NEVER touches checked_in or cancelled bookings. detail records {policy:no_show_forfeit}.';

-- ===========================================================================
-- 9) waitlist_position — the member HONESTY read (true position + offer window).
-- ===========================================================================
create or replace function public.waitlist_position(
  p_tenant  uuid,
  p_session uuid,
  p_person  uuid
)
returns table (
  -- POSITION is a col_name_keyword: legal as a table column, but OUT-parameter
  -- names use the function-name grammar, so it must be quoted here. The JSON
  -- key PostgREST emits is still "position".
  "position"       int,
  total_waiting    int,
  offer_expires_at timestamptz,
  status           text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- Returning no row for an inaccessible/mismatched person avoids an oracle;
  -- RLS on waitlist_entries already scopes visibility to the member's tenant.
  return query
  select we.position, cnt.total::int, we.offer_expires_at, we.status
  from public.waitlist_entries we
  cross join lateral (
    select count(*) as total
    from public.waitlist_entries w2
    where w2.tenant_id = p_tenant and w2.session_id = p_session and w2.status = 'waiting'
  ) cnt
  where we.tenant_id = p_tenant and we.session_id = p_session and we.person_id = p_person
    and we.status in ('waiting','offered')
  order by we.position asc
  limit 1;
end;
$$;

-- ===========================================================================
-- 10) SQL wrappers (security invoker) for the member-callable RPCs so PostgREST
--     can reach them; the sweeps (promote/decline_or_expire/mark_no_shows) are
--     service-role only and are called as app.* by the workers.
-- ===========================================================================
create or replace function public.join_waitlist(
  p_tenant uuid, p_session uuid, p_person uuid, p_actor uuid, p_idempotency_key text
) returns int language sql security invoker set search_path = ''
as $$ select app.join_waitlist(p_tenant, p_session, p_person, p_actor, p_idempotency_key); $$;

create or replace function public.accept_waitlist_offer(
  p_tenant uuid, p_entry uuid, p_actor uuid, p_idempotency_key text, p_via text default 'desk'
) returns uuid language sql security invoker set search_path = ''
as $$ select app.accept_waitlist_offer(p_tenant, p_entry, p_actor, p_idempotency_key, p_via); $$;

create or replace function public.decline_waitlist_offer(
  p_tenant uuid, p_entry uuid, p_actor uuid
) returns void language sql security invoker set search_path = ''
as $$ select app.decline_waitlist_offer(p_tenant, p_entry, p_actor); $$;

create or replace function public.check_in(
  p_tenant uuid, p_booking uuid, p_actor uuid, p_now timestamptz
) returns text language sql security invoker set search_path = ''
as $$ select app.check_in(p_tenant, p_booking, p_actor, p_now); $$;

-- ===========================================================================
-- 11) The 'waitlist_offer' template — global registry row (transactional ⇒
--     quiet-hours EXEMPT). Only {{first_name}}/{{studio_name}} are valid merge
--     fields; promote_waitlist builds the resolved body verbatim into
--     comms_log.body_preview (the send path relays it) — the offer expiry is not
--     a merge field.
-- ===========================================================================
insert into public.message_templates
  (id, tenant_id, key, version, channel, kind, subject, body, segment_key)
values
  ('41000000-0000-4000-8000-000000000001', null, 'waitlist_offer', 1,
   'email', 'transactional', 'A spot opened at {{studio_name}}',
   'Hi {{first_name}}, a spot just opened at {{studio_name}} and is held for you for a short window. Confirm to claim it before the hold expires.',
   null)
on conflict do nothing;

-- ===========================================================================
-- 12) RLS — member SELECT (roster/position render under RLS); writes go through
--     the definer RPCs only (no client/service INSERT/UPDATE/DELETE grant).
-- ===========================================================================
alter table public.waitlist_entries enable row level security;

create policy waitlist_entries_select on public.waitlist_entries for select
  using (tenant_id in (select app.current_tenant_ids()));

revoke all on public.waitlist_entries from anon, authenticated, service_role;
grant select on public.waitlist_entries to authenticated, service_role;

-- ===========================================================================
-- 13) Grants — member RPCs to authenticated + service_role; the sweeps + the
--     internal promote helper to service_role only.
-- ===========================================================================
-- app.open_seats is an internal availability helper: the definer callers run as
-- the owner, so no client/service grant is needed (strip the PUBLIC default).
revoke all on function app.open_seats(uuid, uuid, timestamptz) from public;

revoke all on function app.join_waitlist(uuid, uuid, uuid, uuid, text) from public;
revoke all on function app.accept_waitlist_offer(uuid, uuid, uuid, text, text) from public;
revoke all on function app.decline_waitlist_offer(uuid, uuid, uuid) from public;
revoke all on function app.check_in(uuid, uuid, uuid, timestamptz) from public;
revoke all on function app.promote_waitlist(uuid, uuid, timestamptz, int) from public;
revoke all on function app.decline_or_expire_offers(timestamptz) from public;
revoke all on function app.mark_no_shows(uuid, timestamptz) from public;
revoke all on function app.tg_promote_waitlist_on_seat_open() from public;

grant execute on function app.join_waitlist(uuid, uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function app.accept_waitlist_offer(uuid, uuid, uuid, text, text) to authenticated, service_role;
grant execute on function app.decline_waitlist_offer(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function app.check_in(uuid, uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function app.promote_waitlist(uuid, uuid, timestamptz, int) to service_role;
grant execute on function app.decline_or_expire_offers(timestamptz) to service_role;
grant execute on function app.mark_no_shows(uuid, timestamptz) to service_role;

revoke all on function public.join_waitlist(uuid, uuid, uuid, uuid, text) from public;
revoke all on function public.accept_waitlist_offer(uuid, uuid, uuid, text, text) from public;
revoke all on function public.decline_waitlist_offer(uuid, uuid, uuid) from public;
revoke all on function public.check_in(uuid, uuid, uuid, timestamptz) from public;
revoke all on function public.waitlist_position(uuid, uuid, uuid) from public;

grant execute on function public.join_waitlist(uuid, uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function public.accept_waitlist_offer(uuid, uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.decline_waitlist_offer(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.check_in(uuid, uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function public.waitlist_position(uuid, uuid, uuid) to authenticated, service_role;
