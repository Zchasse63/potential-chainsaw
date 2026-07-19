-- Phase 8 · unit 8.1c — the ANONYMOUS member schedule (plan-member-app §3.5).
--
-- The public data source the member web app's SSR schedule page renders. The
-- member client ships ZERO Supabase material (plan §5: no anon key, no URL —
-- only the PUBLIC tenant uuid KELO_TENANT_ID), so the API calls this function
-- server-side and the tenant arrives as a query-param uuid.
--
-- THE SECURITY BOUNDARY IS THE RETURN SHAPE. This function is SECURITY
-- DEFINER granted to anon: an anonymous caller can read ONLY what the eight
-- return columns expose, for whatever public tenant uuid they pass — the
-- intended public surface (a studio's published schedule is public marketing
-- data). Attendee/person data is STRUCTURALLY impossible to leak: no such
-- column is selected, joined, or returned. Draft sessions never appear (the
-- status filter is hard-coded). Tenant scoping is the in-body
-- `s.tenant_id = p_tenant` filter (invariant #7: the definer re-verifies
-- tenancy in-body — here by construction, since the only rows read are the
-- caller-pinned tenant's PUBLISHED ones).
--
-- Availability reuses 0040's math exactly (bookings booked|checked_in +
-- live/frozen holds, floored at 0); readiness_ok mirrors
-- public.session_availability. The v1 cost model is FIXED: app.book_session
-- debits exactly ONE credit, so credit_cost = 1 for every session. There is
-- NO per-session cash price in the schema — drop-in cash pricing is DEFERRED
-- to a later wave (do not invent a column for it here).

create or replace function public.member_schedule(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz
)
returns table (
  session_id    uuid,
  offering_name text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  capacity      int,
  available     int,
  readiness_ok  boolean,
  credit_cost   int
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    ot.name,
    s.starts_at,
    s.starts_at + (ot.duration_minutes * interval '1 minute'),
    s.capacity,
    greatest(s.capacity - coalesce(b.cnt, 0) - coalesce(h.cnt, 0), 0)::int,
    not exists (
      select 1 from public.resource_readiness rr
      where rr.tenant_id = s.tenant_id
        and rr.resource_id = s.resource_id
        and rr.state in ('maintenance', 'closed')
        and rr.effective_from <= s.starts_at
        and (rr.effective_to is null or rr.effective_to > s.starts_at)
    ),
    1 as credit_cost
  from public.scheduled_sessions s
  join public.offering_templates ot
    on ot.tenant_id = s.tenant_id and ot.id = s.offering_template_id
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

comment on function public.member_schedule(uuid, timestamptz, timestamptz) is
  'The ANONYMOUS public schedule (unit 8.1c): PUBLISHED sessions of the pinned tenant in [p_from, p_to) with 0040 availability math, ends_at from the offering duration, readiness_ok, and the fixed v1 credit_cost = 1. SECURITY DEFINER granted to anon BY DESIGN — the locked 8-column return shape is the security boundary: zero attendee/person data exists in it, drafts never appear, and the only rows readable are the caller-pinned tenant''s published ones.';

-- Grants: strip the default EXECUTE-for-PUBLIC first (0005 pattern), then open
-- the function to anon — the intended public surface per the header comment.
revoke all on function public.member_schedule(uuid, timestamptz, timestamptz) from public;
grant execute on function public.member_schedule(uuid, timestamptz, timestamptz) to anon, authenticated, service_role;
