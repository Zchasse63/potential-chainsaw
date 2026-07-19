-- Phase 6 · unit 6.1 — THE NATIVE BOOKING ENGINE (the booking CORE).
--
-- Bookings are money-adjacent: credits ARE stored value (invariant #6, ledger
-- 0008) and a seat is a scarce resource. This migration ships the native
-- booking record + the server-side HOLD with a TTL, and the four money/booking
-- RPCs (hold / freeze / book / cancel) plus the hold-expiry sweep and the
-- availability read. The imported Glofox history in glofox_bookings is NEVER
-- touched — the native engine writes its OWN tables (README: imported rows are
-- read-only facts).
--
-- INVARIANTS enforced here (CLAUDE.md §Standing invariants):
--   * Booking mutations are Postgres RPCs with idempotency keys (invariant #5);
--     NO optimistic booking UI — the RPC is the authority.
--   * Credits debit via APPEND-ONLY credit_ledger entries (invariant #6): a
--     booking appends a NEGATIVE 'debit' row; a ≥12h cancel appends a POSITIVE
--     'refund_credit' row. NO mutable balance column, ever. The balance is
--     computed from the ledger IN-BODY under a person-row lock (NOT from the
--     refresh-on-demand app.credit_balances matview, which would be stale within
--     a single booking flow and could double-spend a credit).
--   * DB-ENFORCED no-oversell (invariant #5): capacity is NOT an application
--     check. app.book_session serializes on the session row (FOR UPDATE) and a
--     belt-and-suspenders BEFORE INSERT trigger re-verifies the active-booking
--     count under the same lock. See the trigger comment for why an exclusion
--     constraint cannot express count-based capacity.
--   * RLS + policy on every tenant table (invariant #7); member-SELECT only, the
--     definer RPCs are the sole writers. Every SECURITY DEFINER function
--     re-verifies tenancy/role in-body.
--   * The waiver ENFORCER (phase-6): current_waiver_status(...).needs_signature
--     makes a booking IMPOSSIBLE without the active-version signature. The
--     phase-4 advisory desk queue stays as a monitored backstop.

-- ---------------------------------------------------------------------------
-- PREREQUISITE — the (tenant_id, id) unique key on scheduled_sessions.
-- ---------------------------------------------------------------------------
-- booking_holds AND bookings both carry a tenant-consistent composite FK
--   (tenant_id, session_id) → scheduled_sessions (tenant_id, id)
-- so a hold/booking can never point at a session in a DIFFERENT tenant. A
-- Postgres composite FK requires a UNIQUE constraint on EXACTLY the referenced
-- columns; migration 0027 declared scheduled_sessions.id as the primary key and
-- a PARTIAL unique index on (tenant_id, schedule_rule_id, starts_at), but never
-- unique (tenant_id, id) (its sibling authoring tables — resources,
-- offering_templates, schedule_rules — all did). Without this, the two FKs below
-- fail to create ("no unique constraint matching given keys"). id is already
-- globally unique (PK), so this composite key is redundant for uniqueness and
-- exists solely to back the tenant-consistent FK.
alter table public.scheduled_sessions
  add constraint scheduled_sessions_tenant_id_key unique (tenant_id, id);

-- ---------------------------------------------------------------------------
-- booking_holds — server-side seat reservation with a TTL.
-- ---------------------------------------------------------------------------
-- A hold reserves a seat for a bounded window (default 300s). Payment
-- initiation FREEZES the hold (frozen=true) so the expiry sweep never reclaims
-- a seat mid-tender — the named UX tension ("the hold-expiry race"). Holds are
-- EPHEMERAL (deleted on consume/expire), so they are NOT append-only and carry
-- an updated-in-place expiry via the one-live-hold upsert.
create table public.booking_holds (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null,
  person_id  uuid not null references public.people (id) on delete cascade,
  expires_at timestamptz not null,
  frozen     boolean not null default false,
  created_at timestamptz not null default now(),
  -- Composite FK keeps a hold tenant-consistent with its session.
  foreign key (tenant_id, session_id)
    references public.scheduled_sessions (tenant_id, id) on delete cascade,
  -- One LIVE hold per (session, person): app.hold_session upserts on this.
  unique (tenant_id, session_id, person_id),
  -- Composite unique so a booking can carry a tenant-consistent hold FK.
  unique (tenant_id, id)
);

create index booking_holds_tenant_session_idx
  on public.booking_holds (tenant_id, session_id);
create index booking_holds_expiry_idx
  on public.booking_holds (expires_at)
  where not frozen;

comment on table public.booking_holds is
  'Server-side seat holds with a TTL (default 300s). Payment initiation freezes expiry (frozen=true) so the sweep never reclaims a tendering seat. One LIVE hold per (session, person). Ephemeral: consumed on booking, swept on expiry. Member-read; definer RPCs are the only writers.';
comment on column public.booking_holds.frozen is
  'Payment initiation freezes the hold: app.expire_holds never deletes a frozen hold, and a frozen hold counts toward capacity indefinitely until the booking commits or the operator releases it. This is the UX hold choreography (plan-ux §3D): tender freezes the expiry.';

-- ---------------------------------------------------------------------------
-- bookings — the NATIVE booking record (distinct from imported glofox_bookings).
-- ---------------------------------------------------------------------------
-- NOT append-only: status advances (booked → cancelled/checked_in/no_show) via
-- the definer RPCs, which own every write. booked_via is the member-app
-- attribution column, shipped here per invariant #9 (the schema ships with the
-- feature that writes it — the member surfaces populate the member_* values).
create table public.bookings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  session_id      uuid not null,
  person_id       uuid not null references public.people (id) on delete restrict,
  status          text not null default 'booked'
                  check (status in ('booked', 'cancelled', 'checked_in', 'no_show')),
  booked_via      text not null default 'desk'
                  check (booked_via in ('desk', 'member_web', 'member_ios', 'member_android', 'import')),
  -- The DEBIT credit_ledger entry that paid for the seat (null when p_use_credit
  -- was false — e.g. an included/complimentary seat). The cancel-refund entry is
  -- recorded in detail.cancel_credit_entry_id.
  credit_entry_id uuid references public.credit_ledger (id),
  hold_id         uuid,
  idempotency_key text not null,
  cancelled_at    timestamptz,
  checked_in_at   timestamptz,
  -- Policy evidence: the cancel branch ('refund' | 'forfeit') the member
  -- accepted, plus the refund entry id, are recorded here at cancel time.
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (tenant_id, session_id)
    references public.scheduled_sessions (tenant_id, id),
  -- A booking's idempotency key is unique per tenant — the RPC replays on it.
  unique (tenant_id, idempotency_key),
  unique (tenant_id, id)
);

create index bookings_tenant_session_status_idx
  on public.bookings (tenant_id, session_id, status);
create index bookings_tenant_person_idx
  on public.bookings (tenant_id, person_id);

create or replace trigger bookings_touch_updated_at
  before update on public.bookings
  for each row execute function app.touch_updated_at();

comment on table public.bookings is
  'The Kelo-NATIVE booking record. Imported read history stays in glofox_bookings (never mutated). status advances through the definer RPCs only; booked_via attributes the member surface (invariant #9). credit_entry_id links the append-only DEBIT that paid for the seat. Member-read; RPC-written. Idempotent on (tenant_id, idempotency_key).';
comment on column public.bookings.booked_via is
  'Attribution for the booking origin. ''desk'' for staff-rung bookings; ''member_web''/''member_ios''/''member_android'' populate when the member surfaces ship (plan-member-app); ''import'' is reserved. Shipped with the writer per invariant #9.';

-- ---------------------------------------------------------------------------
-- THE NO-OVERSELL CONSTRAINT (the phase gate's spine, DB-enforced).
-- ---------------------------------------------------------------------------
-- Capacity is COUNT-BASED ("at most N active bookings for this session"), which
-- a Postgres EXCLUSION constraint CANNOT express: exclusion constraints assert
-- that no two rows CONFLICT under an operator (e.g. overlapping ranges), never a
-- running COUNT against a per-parent limit. So the ceiling is enforced by
-- SERIALIZATION: every insert path (and this trigger) locks the session row
-- FOR UPDATE, then counts. Under READ COMMITTED a second concurrent insert
-- blocks on the lock, and after the first commits its fresh count SEES the new
-- booking — so the race that a naive application check loses is closed. The live
-- concurrency STORM (wave 6b, CI Postgres) proves it; this trigger is the
-- belt-and-suspenders that holds even if a future write path forgets the lock.
create or replace function app.enforce_booking_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity int;
  v_active   int;
begin
  -- Lock the session row: serializes concurrent inserts for this session.
  select capacity into v_capacity
  from public.scheduled_sessions
  where tenant_id = new.tenant_id and id = new.session_id
  for update;
  if not found then
    raise exception 'session % not found for booking', new.session_id using errcode = 'P0002';
  end if;

  -- BEFORE INSERT: new is not yet visible, so this counts the EXISTING active
  -- bookings. existing >= capacity means the incoming row would oversell.
  select count(*) into v_active
  from public.bookings
  where tenant_id = new.tenant_id
    and session_id = new.session_id
    and status in ('booked', 'checked_in');

  if v_active >= v_capacity then
    raise exception 'session % is at capacity (% of %)', new.session_id, v_active, v_capacity
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace trigger bookings_enforce_capacity
  before insert on public.bookings
  for each row execute function app.enforce_booking_capacity();

comment on function app.enforce_booking_capacity() is
  'The DB-enforced no-oversell ceiling (invariant #5). Locks the session FOR UPDATE and rejects an insert once active bookings (booked|checked_in) reach capacity. An exclusion constraint cannot express count-based capacity; FOR UPDATE serialization makes the count race-free. Belt-and-suspenders behind app.book_session''s own lock+count.';

-- ---------------------------------------------------------------------------
-- app.hold_session — reserve a seat with a TTL.
-- ---------------------------------------------------------------------------
create or replace function app.hold_session(
  p_tenant      uuid,
  p_session     uuid,
  p_person      uuid,
  p_actor       uuid,
  p_ttl_seconds int default 300
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.scheduled_sessions%rowtype;
  v_active  int;
  v_held    int;
  v_hold_id uuid;
begin
  -- Actor binding + role re-check (invariant #7). The service role (auth.uid()
  -- null) runs unattended. Desk staff hold seats; the member surface rides its
  -- own auth in a later phase.
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'hold actor must be the authenticated user' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'ttl must be between 1 and 3600 seconds' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.people pp where pp.tenant_id = p_tenant and pp.id = p_person
  ) then
    raise exception 'person not found for tenant' using errcode = 'P0002';
  end if;

  -- Lock the session row (serializes capacity math with book_session + peers).
  select * into v_session
  from public.scheduled_sessions
  where tenant_id = p_tenant and id = p_session
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_session.status <> 'published' then
    raise exception 'session is not published' using errcode = '22023';
  end if;
  if v_session.starts_at <= now() then
    raise exception 'session has already started' using errcode = '22023';
  end if;
  -- Readiness: the session resource must have no blocking maintenance/closed
  -- window covering starts_at (a room down for maintenance cannot be booked).
  if exists (
    select 1 from public.resource_readiness rr
    where rr.tenant_id = p_tenant
      and rr.resource_id = v_session.resource_id
      and rr.state in ('maintenance', 'closed')
      and rr.effective_from <= v_session.starts_at
      and (rr.effective_to is null or rr.effective_to > v_session.starts_at)
  ) then
    raise exception 'session resource is not ready' using errcode = '22023';
  end if;

  -- Capacity = active bookings + LIVE holds (unexpired or frozen), EXCLUDING
  -- this person's own hold (which we refresh in place — it is not a new seat).
  select count(*) into v_active
  from public.bookings
  where tenant_id = p_tenant and session_id = p_session
    and status in ('booked', 'checked_in');
  select count(*) into v_held
  from public.booking_holds
  where tenant_id = p_tenant and session_id = p_session
    and person_id <> p_person
    and (frozen or expires_at > now());
  if v_active + v_held >= v_session.capacity then
    raise exception 'session is at capacity' using errcode = '23514';
  end if;

  -- One live hold per (session, person): refresh/replace an existing one (a new
  -- hold is fresh — reset frozen so a stale freeze does not persist).
  insert into public.booking_holds (tenant_id, session_id, person_id, expires_at)
  values (p_tenant, p_session, p_person, now() + make_interval(secs => p_ttl_seconds))
  on conflict (tenant_id, session_id, person_id)
  do update set expires_at = excluded.expires_at, frozen = false
  returning id into v_hold_id;

  return v_hold_id;
end;
$$;

comment on function app.hold_session(uuid, uuid, uuid, uuid, int) is
  'Reserves a seat: locks the session FOR UPDATE, verifies published + future + resource readiness + capacity (active bookings + live holds), then upserts ONE live hold per (session, person) with a TTL (default 300s). Owner/manager/front_desk; actor-bound. Returns the hold id.';

-- ---------------------------------------------------------------------------
-- app.freeze_hold — payment initiation freezes hold expiry (UX choreography).
-- ---------------------------------------------------------------------------
create or replace function app.freeze_hold(
  p_tenant uuid,
  p_hold   uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;
  update public.booking_holds
  set frozen = true
  where tenant_id = p_tenant and id = p_hold;
  if not found then
    raise exception 'hold not found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function app.freeze_hold(uuid, uuid) is
  'Payment initiation freezes a hold''s expiry (frozen=true) so app.expire_holds never reclaims a seat mid-tender (plan-ux §3D: tender freezes the hold-expiry race). Owner/manager/front_desk.';

-- ---------------------------------------------------------------------------
-- app.book_session — the booking authority (waiver enforcer + credit debit).
-- ---------------------------------------------------------------------------
create or replace function app.book_session(
  p_tenant          uuid,
  p_person          uuid,
  p_session         uuid,
  p_actor           uuid,
  p_idempotency_key text,
  p_via             text,
  p_hold            uuid default null,
  p_use_credit      boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session   public.scheduled_sessions%rowtype;
  v_hold      public.booking_holds%rowtype;
  v_active    int;
  v_held      int;
  v_needs     boolean;
  v_balance   int;
  v_credit_id uuid;
  v_booking_id uuid;
begin
  -- Actor binding + role (invariant #7).
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'booking actor must be the authenticated user' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;
  if p_via is null
     or p_via not in ('desk', 'member_web', 'member_ios', 'member_android', 'import') then
    raise exception 'invalid booked_via' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  -- Idempotent replay (fast path, no lock): this key already booked → return it.
  select id, credit_entry_id into v_booking_id, v_credit_id
  from public.bookings
  where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('booking_id', v_booking_id, 'credit_entry_id', v_credit_id, 'replayed', true);
  end if;

  -- Lock the person row FIRST-of-two: serializes this person's credit debits so
  -- two concurrent bookings can never each read the same balance and both debit
  -- (the balance is the append-only ledger sum — see below).
  perform 1 from public.people pp
  where pp.tenant_id = p_tenant and pp.id = p_person
  for update;
  if not found then
    raise exception 'person not found for tenant' using errcode = 'P0002';
  end if;

  -- Lock the session row: serializes capacity math with hold_session + peers.
  select * into v_session
  from public.scheduled_sessions
  where tenant_id = p_tenant and id = p_session
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  -- Re-check idempotency AFTER the locks: a concurrent same-key booking may have
  -- committed while we waited, so replay it instead of double-debiting.
  select id, credit_entry_id into v_booking_id, v_credit_id
  from public.bookings
  where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('booking_id', v_booking_id, 'credit_entry_id', v_credit_id, 'replayed', true);
  end if;
  v_credit_id := null;

  if v_session.status <> 'published' then
    raise exception 'session is not published' using errcode = '22023';
  end if;
  if v_session.starts_at <= now() then
    raise exception 'session has already started' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.resource_readiness rr
    where rr.tenant_id = p_tenant
      and rr.resource_id = v_session.resource_id
      and rr.state in ('maintenance', 'closed')
      and rr.effective_from <= v_session.starts_at
      and (rr.effective_to is null or rr.effective_to > v_session.starts_at)
  ) then
    raise exception 'session resource is not ready' using errcode = '22023';
  end if;

  -- CAPACITY: a valid hold already reserved the seat (bypass the re-count) — but
  -- still assert the hold belongs to THIS person + session and is live. Without a
  -- hold, re-verify capacity under the lock.
  if p_hold is not null then
    select * into v_hold
    from public.booking_holds
    where tenant_id = p_tenant and id = p_hold
    for update;
    if not found then
      raise exception 'hold not found' using errcode = 'P0002';
    end if;
    if v_hold.person_id <> p_person or v_hold.session_id <> p_session then
      raise exception 'hold does not belong to this person and session' using errcode = '42501';
    end if;
    if not (v_hold.frozen or v_hold.expires_at > now()) then
      raise exception 'hold has expired' using errcode = '22023';
    end if;
  else
    select count(*) into v_active
    from public.bookings
    where tenant_id = p_tenant and session_id = p_session
      and status in ('booked', 'checked_in');
    select count(*) into v_held
    from public.booking_holds
    where tenant_id = p_tenant and session_id = p_session
      and (frozen or expires_at > now());
    if v_active + v_held >= v_session.capacity then
      raise exception 'session is at capacity' using errcode = '23514';
    end if;
  end if;

  -- THE WAIVER BLOCK (the phase-6 ENFORCER): a person owing the active-version
  -- signature CANNOT book — booking is impossible without it. The phase-4 desk
  -- queue (routes/waivers.ts) stays as a monitored advisory backstop.
  select cw.needs_signature into v_needs
  from public.current_waiver_status(p_tenant, p_person) cw;
  if v_needs is true then
    raise exception 'waiver_required' using errcode = '42501';
  end if;

  -- CREDIT DEBIT: a booking costs one credit. The balance is computed from the
  -- APPEND-ONLY ledger IN-BODY (NOT the refresh-on-demand matview, which would be
  -- stale here) under the person-row lock taken above. p_use_credit=false books a
  -- complimentary/included seat with no debit (member self-serve always debits).
  if p_use_credit then
    select coalesce(sum(cl.delta), 0)::int into v_balance
    from public.credit_ledger cl
    where cl.tenant_id = p_tenant and cl.person_id = p_person;
    if v_balance <= 0 then
      -- No balance: a drop-in purchase rides the POS/member payment paths, not
      -- this RPC. Booking is refused so a member is never silently overdrawn.
      raise exception 'insufficient_credits' using errcode = '22023';
    end if;
    -- external_ref = the booking key gives the debit ledger-level idempotency via
    -- credit_ledger_tenant_ref_type_key (tenant, external_ref, entry_type).
    insert into public.credit_ledger
      (tenant_id, person_id, entry_type, delta, source, reason, external_ref, actor_user_id)
    values
      (p_tenant, p_person, 'debit', -1, 'native', 'booking', p_idempotency_key, p_actor)
    returning id into v_credit_id;
  end if;

  -- Insert the booking (the capacity trigger re-verifies under the same lock).
  -- A concurrent same-key insert loses the (tenant, idempotency_key) race and is
  -- replayed; the same key on the debit external_ref is the same safety net.
  begin
    insert into public.bookings
      (tenant_id, session_id, person_id, status, booked_via, credit_entry_id, hold_id, idempotency_key)
    values
      (p_tenant, p_session, p_person, 'booked', p_via, v_credit_id, p_hold, p_idempotency_key)
    returning id into v_booking_id;
  exception when unique_violation then
    select id, credit_entry_id into v_booking_id, v_credit_id
    from public.bookings
    where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
    if not found then
      raise exception 'idempotency key already used for a different operation'
        using errcode = '23505';
    end if;
    return jsonb_build_object('booking_id', v_booking_id, 'credit_entry_id', v_credit_id, 'replayed', true);
  end;

  -- Consume the hold (it has served its purpose — the seat is now a booking).
  if p_hold is not null then
    delete from public.booking_holds where tenant_id = p_tenant and id = p_hold;
  end if;

  return jsonb_build_object('booking_id', v_booking_id, 'credit_entry_id', v_credit_id);
end;
$$;

comment on function app.book_session(uuid, uuid, uuid, uuid, text, text, uuid, boolean) is
  'The native booking authority. Idempotent on the key. A live hold bypasses the capacity re-count (the hold reserved the seat) after asserting person+session ownership; otherwise capacity is re-verified under the session lock. ENFORCES the waiver (needs_signature → 42501 waiver_required). Debits ONE credit as a NEGATIVE append-only credit_ledger entry (balance read from the ledger under a person-row lock; no balance → insufficient_credits). Consumes the hold. Returns {booking_id, credit_entry_id?}.';

-- ---------------------------------------------------------------------------
-- app.cancel_booking — the cancellation policy engine (refund vs forfeit).
-- ---------------------------------------------------------------------------
-- p_now is INJECTED (never now() in-body) so the 12-hour boundary is a pure,
-- testable function of the caller's clock — the API passes now(); tests pin it.
create or replace function app.cancel_booking(
  p_tenant          uuid,
  p_booking         uuid,
  p_actor           uuid,
  p_idempotency_key text,
  p_now             timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking   public.bookings%rowtype;
  v_starts    timestamptz;
  v_refund    boolean;
  v_branch    text;
  v_refund_id uuid;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'cancel actor must be the authenticated user' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  -- Lock the booking row: serializes concurrent cancels; the status check makes
  -- the operation idempotent (a re-cancel returns the recorded branch).
  select * into v_booking
  from public.bookings
  where tenant_id = p_tenant and id = p_booking
  for update;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  if v_booking.status = 'cancelled' then
    v_branch := v_booking.detail ->> 'cancel_branch';
    return jsonb_build_object(
      'booking_id', v_booking.id,
      'status', 'cancelled',
      'branch', v_branch,
      'refunded', v_branch = 'refund',
      'credit_entry_id', v_booking.detail ->> 'cancel_credit_entry_id',
      'replayed', true
    );
  end if;
  if v_booking.status <> 'booked' then
    raise exception 'only a booked reservation can be cancelled (is %)', v_booking.status
      using errcode = '22023';
  end if;

  select starts_at into v_starts
  from public.scheduled_sessions
  where tenant_id = p_tenant and id = v_booking.session_id;

  -- POLICY: cancel ≥ 12h before start → REFUND the credit; < 12h → FORFEIT (the
  -- policy the member accepted at booking). The boundary is EXACTLY 12h (≥).
  v_refund := v_starts is not null and (v_starts - p_now) >= interval '12 hours';
  v_branch := case when v_refund then 'refund' else 'forfeit' end;

  -- REFUND appends a POSITIVE 'refund_credit' entry reversing the debit, linked
  -- to the original debit via grant_id and to the booking via booking_external_ref.
  -- Only when a credit was actually debited. external_ref = the cancel key gives
  -- ledger-level idempotency on the refund.
  if v_refund and v_booking.credit_entry_id is not null then
    insert into public.credit_ledger
      (tenant_id, person_id, entry_type, delta, source, reason,
       external_ref, booking_external_ref, grant_id, actor_user_id)
    values
      (p_tenant, v_booking.person_id, 'refund_credit', 1, 'native', 'booking_cancel',
       p_idempotency_key, v_booking.id::text, v_booking.credit_entry_id, p_actor)
    returning id into v_refund_id;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = p_now,
      detail = detail || jsonb_build_object(
        'cancel_branch', v_branch,
        'cancel_credit_entry_id', v_refund_id
      )
  where tenant_id = p_tenant and id = p_booking;

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'status', 'cancelled',
    'branch', v_branch,
    'refunded', v_refund and v_booking.credit_entry_id is not null,
    'credit_entry_id', v_refund_id
  );
end;
$$;

comment on function app.cancel_booking(uuid, uuid, uuid, text, timestamptz) is
  'Cancels a booking under the studio policy: ≥12h before start → ''refund'' (a POSITIVE refund_credit ledger entry reversing the debit, linked); <12h → ''forfeit'' (the debit stands). p_now is injected so the 12h boundary is pure/testable. Idempotent via the booking row lock + status check. Returns {booking_id, status, branch, refunded, credit_entry_id?}.';

-- ---------------------------------------------------------------------------
-- app.expire_holds — the hold-expiry sweep (a jobs-queue processor).
-- ---------------------------------------------------------------------------
-- GLOBAL (no tenant): one pass reclaims every expired, UN-frozen hold across
-- tenants. A frozen hold is NEVER reclaimed (payment is mid-flight). Registered
-- as 'booking.expire_holds' on the frequent fan-out with a MINUTE-scoped key —
-- the hour key the other drains use is far too coarse for a 300s TTL; the tick
-- cadence (5-minute Netlify scheduled function) still bounds the real
-- granularity, documented at the fan-out.
create or replace function app.expire_holds(p_now timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from public.booking_holds
  where expires_at < p_now and not frozen;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function app.expire_holds(timestamptz) is
  'The hold-expiry sweep: deletes every expired, UN-frozen hold (a frozen hold is mid-tender and never reclaimed). GLOBAL like the billing drains. Registered as the ''booking.expire_holds'' processor; p_now is injected (the tick passes now()). Returns the deleted count.';

-- ---------------------------------------------------------------------------
-- public.session_availability — the member/desk pickers' source of truth.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: RLS on scheduled_sessions/bookings/booking_holds/
-- resource_readiness scopes every read to the caller's memberships, so a foreign
-- p_tenant simply yields zero rows (no oracle). available never goes negative.
create or replace function public.session_availability(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz
)
returns table (
  session_id   uuid,
  starts_at    timestamptz,
  capacity     int,
  booked       int,
  held         int,
  available    int,
  readiness_ok boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    s.id,
    s.starts_at,
    s.capacity,
    coalesce(b.cnt, 0)::int as booked,
    coalesce(h.cnt, 0)::int as held,
    greatest(s.capacity - coalesce(b.cnt, 0) - coalesce(h.cnt, 0), 0)::int as available,
    not exists (
      select 1 from public.resource_readiness rr
      where rr.tenant_id = s.tenant_id
        and rr.resource_id = s.resource_id
        and rr.state in ('maintenance', 'closed')
        and rr.effective_from <= s.starts_at
        and (rr.effective_to is null or rr.effective_to > s.starts_at)
    ) as readiness_ok
  from public.scheduled_sessions s
  left join (
    select session_id, count(*) as cnt
    from public.bookings
    where tenant_id = p_tenant and status in ('booked', 'checked_in')
    group by session_id
  ) b on b.session_id = s.id
  left join (
    select session_id, count(*) as cnt
    from public.booking_holds
    where tenant_id = p_tenant and (frozen or expires_at > now())
    group by session_id
  ) h on h.session_id = s.id
  where s.tenant_id = p_tenant
    and s.status = 'published'
    and s.starts_at >= p_from
    and s.starts_at < p_to
  order by s.starts_at;
$$;

comment on function public.session_availability(uuid, timestamptz, timestamptz) is
  'The pickers'' source of truth: per published session in [p_from, p_to), capacity vs active bookings + live holds → available (floored at 0) + readiness_ok. SECURITY INVOKER, so RLS scopes it to the caller''s tenant.';

-- ---------------------------------------------------------------------------
-- Public wrappers (security invoker) for the definer RPCs — PostgREST rpc().
-- ---------------------------------------------------------------------------
create or replace function public.hold_session(
  p_tenant uuid, p_session uuid, p_person uuid, p_actor uuid, p_ttl_seconds int default 300
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select app.hold_session(p_tenant, p_session, p_person, p_actor, p_ttl_seconds); $$;

create or replace function public.freeze_hold(p_tenant uuid, p_hold uuid)
returns void
language sql
security invoker
set search_path = ''
as $$ select app.freeze_hold(p_tenant, p_hold); $$;

create or replace function public.book_session(
  p_tenant uuid, p_person uuid, p_session uuid, p_actor uuid, p_idempotency_key text,
  p_via text, p_hold uuid default null, p_use_credit boolean default true
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select app.book_session(p_tenant, p_person, p_session, p_actor, p_idempotency_key, p_via, p_hold, p_use_credit); $$;

create or replace function public.cancel_booking(
  p_tenant uuid, p_booking uuid, p_actor uuid, p_idempotency_key text, p_now timestamptz
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select app.cancel_booking(p_tenant, p_booking, p_actor, p_idempotency_key, p_now); $$;

-- ---------------------------------------------------------------------------
-- RLS — member-SELECT everywhere; the definer RPCs are the sole writers.
-- ---------------------------------------------------------------------------
alter table public.booking_holds enable row level security;
alter table public.bookings enable row level security;

create policy booking_holds_select on public.booking_holds for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy bookings_select on public.bookings for select
  using (tenant_id in (select app.current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- Grants — member-read only; NO client/service write path (definer RPCs write
-- as the owner). anon gets nothing.
-- ---------------------------------------------------------------------------
revoke all on public.booking_holds, public.bookings
  from anon, authenticated, service_role;
grant select on public.booking_holds, public.bookings to authenticated, service_role;

-- Function grants. The four money/booking RPCs + availability are member-callable
-- (each definer RPC re-checks role in-body); expire_holds is service-role only
-- (the sweep processor). Strip the default EXECUTE-for-PUBLIC first (0005 pattern).
revoke all on function app.hold_session(uuid, uuid, uuid, uuid, int) from public;
revoke all on function public.hold_session(uuid, uuid, uuid, uuid, int) from public;
grant execute on function app.hold_session(uuid, uuid, uuid, uuid, int) to authenticated, service_role;
grant execute on function public.hold_session(uuid, uuid, uuid, uuid, int) to authenticated, service_role;

revoke all on function app.freeze_hold(uuid, uuid) from public;
revoke all on function public.freeze_hold(uuid, uuid) from public;
grant execute on function app.freeze_hold(uuid, uuid) to authenticated, service_role;
grant execute on function public.freeze_hold(uuid, uuid) to authenticated, service_role;

revoke all on function app.book_session(uuid, uuid, uuid, uuid, text, text, uuid, boolean) from public;
revoke all on function public.book_session(uuid, uuid, uuid, uuid, text, text, uuid, boolean) from public;
grant execute on function app.book_session(uuid, uuid, uuid, uuid, text, text, uuid, boolean)
  to authenticated, service_role;
grant execute on function public.book_session(uuid, uuid, uuid, uuid, text, text, uuid, boolean)
  to authenticated, service_role;

revoke all on function app.cancel_booking(uuid, uuid, uuid, text, timestamptz) from public;
revoke all on function public.cancel_booking(uuid, uuid, uuid, text, timestamptz) from public;
grant execute on function app.cancel_booking(uuid, uuid, uuid, text, timestamptz)
  to authenticated, service_role;
grant execute on function public.cancel_booking(uuid, uuid, uuid, text, timestamptz)
  to authenticated, service_role;

revoke all on function app.expire_holds(timestamptz) from public;
grant execute on function app.expire_holds(timestamptz) to service_role;

revoke all on function public.session_availability(uuid, timestamptz, timestamptz) from public;
grant execute on function public.session_availability(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- The capacity trigger function is invoked by the trigger only.
revoke all on function app.enforce_booking_capacity() from public;
