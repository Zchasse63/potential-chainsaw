-- Migration 0047 — FIX: the member waitlist-join path was dead on arrival.
--
-- app.join_waitlist (migration 0041) used the STRICT actor guard
--   if (select auth.uid()) is null or (select auth.uid()) <> p_actor then raise
-- plus an UNCONDITIONAL owner/manager/front_desk role check. That was written
-- for the DESK surface only. But the MEMBER surface (POST /member/waitlist,
-- Wave 8.3 → data-booking.joinWaitlist → this RPC) calls it through the
-- SERVICE-ROLE client, where auth.uid() is NULL, with p_actor = the member's
-- own person id — exactly the pattern app.book_session (0040) already supports.
-- Because join_waitlist REJECTED the null-uid service-role call, a signed-in
-- member tapping "Join the waitlist" (booking-panel.tsx) always received 42501
-- / "join actor must be the authenticated user". The member waitlist path could
-- never succeed; it was latent only because no full published session exists yet
-- (pre-cutover). Discovered by verifying the member book→waitlist seed against
-- the real schema during the WS-10 E2E work.
--
-- FIX: mirror app.book_session's guard-gating (0040:354-360) — the actor-binding
-- and staff-role checks apply ONLY when auth.uid() is not null. The DESK path is
-- byte-for-byte unchanged (an authenticated caller must still be the actor AND
-- hold owner/manager/front_desk). The SERVICE-ROLE member path is now allowed,
-- with the person-belongs-to-tenant check (unchanged, below) as the tenancy
-- boundary and the API's resolveMember (kmb_ session → memberPersonId, passed as
-- p_person) as the identity boundary — identical to how book_session is secured
-- for the member surface. Everything after the guard is the 0041 body verbatim.
--
-- NOT changed: app.accept_waitlist_offer / decline_waitlist_offer / check_in
-- (0041) keep the strict guard by design — they are desk-only (no member route
-- calls them) and must keep requiring an authenticated staff actor.

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
  -- Actor + role. Mirrors app.book_session (0040:354-360): the service role
  -- (auth.uid() NULL — the member surface) bypasses BOTH the actor-binding and
  -- the staff-role check; an AUTHENTICATED desk caller still must be the actor
  -- AND hold owner/manager/front_desk. Tenancy is re-checked immediately below.
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'join actor must be the authenticated user' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner','manager','front_desk']) then
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

comment on function app.join_waitlist(uuid, uuid, uuid, uuid, text) is
  'Enqueue a person on a FULL session (FIFO). Callable by the desk (authenticated owner/manager/front_desk, actor=caller) AND the member surface (service role, auth.uid() NULL, p_person = the resolveMember-authenticated member). Guard mirrors app.book_session (0040). Full-session precondition + person-belongs-to-tenant enforced in-body.';
