-- Phase 2 · unit 6 — the approved /ask query catalog, miss log, and the
-- 30-day fill heatmap read model. The model selects a catalog key and
-- parameters; it never receives SQL and never supplies a query fragment.

create table if not exists public.ask_catalog (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  version       int not null check (version > 0),
  title         text not null,
  description   text not null,
  params_schema jsonb not null default '{}'::jsonb,
  metric_keys   text[] not null default '{}'::text[],
  created_at    timestamptz not null default now()
);

comment on table public.ask_catalog is
  'Global allow-list for /ask. Each immutable key maps in API code to one fixed SECURITY INVOKER function; models can select keys and typed parameters but can never write SQL.';

-- These operational source-row definitions did not exist in dictionary v1.
-- Adding them here keeps every seeded catalog result cited; none claims a
-- derived financial meaning beyond the fixed query described below.
insert into public.metric_definitions (key, version, definition, notes)
values
  ('credits_expiring_balance', 1,
   'Current operational credit balance is the sum of append-only credit-ledger deltas per person. Next expiry is the earliest future imported grant expiry; people are included only when balance is positive and that expiry falls within the selected trailing-day horizon.',
   'The next-expiry field is a phase-2 operational approximation and does not perform per-lot remaining-credit attribution.'),
  ('segment_membership_current', 1,
   'The latest successful deterministic segment snapshot, reduced to each person''s highest-priority current segment using the stored segment rule version and evidence.',
   'This is the focus-queue reduction, not a complete history of every segment a person matched.'),
  ('booking_channel_mix', 1,
   'Non-deleted attended or BOOKED imported bookings in the selected studio-local period, grouped as classpass when origin contains ClassPass and direct otherwise.',
   'A missing or unrecognized origin is labeled direct in the phase-2 source vocabulary; expand the catalog only after new origin values are reviewed.'),
  ('new_people', 1,
   'People records created in Kelo, grouped by studio-local calendar week across the selected trailing-week horizon.',
   'This is record creation, not a claim about first visit, acquisition, or conversion.' )
on conflict (key, version) do nothing;

insert into public.ask_catalog
  (key, version, title, description, params_schema, metric_keys)
values
  ('revenue_by_period', 1, 'Collected revenue by day',
   'Collected cash-basis revenue by studio-local day for a date range.',
   '{"from":{"type":"date","required":false,"default":"$30_days_ago"},"to":{"type":"date","required":false,"default":"$today"}}',
   array['collected_revenue']),
  ('revenue_by_tender', 1, 'Collected revenue by tender',
   'Collected cash-basis revenue grouped by the recorded payment method for a date range.',
   '{"from":{"type":"date","required":false,"default":"$30_days_ago"},"to":{"type":"date","required":false,"default":"$today"}}',
   array['collected_revenue']),
  ('member_count_current', 1, 'Current member count',
   'The current recurring-member cohort count.', '{}'::jsonb,
   array['member_count']),
  ('mrr_current', 1, 'Current MRR',
   'Current monthly recurring revenue and the contributing and excluded-member counts.',
   '{}'::jsonb, array['mrr', 'partner_invoiced_members']),
  ('attendance_by_period', 1, 'Attendance for a period',
   'Attendance, no-shows, late cancellations, attendance rate, and no-show rate for a date range.',
   '{"from":{"type":"date","required":false,"default":"$30_days_ago"},"to":{"type":"date","required":false,"default":"$today"}}',
   array['attendance_rate', 'no_show_rate']),
  ('top_customers_by_revenue', 1, 'Top customers by collected revenue',
   'People ranked by collected revenue for a date range; partner-invoiced placeholder charges are excluded.',
   '{"from":{"type":"date","required":false,"default":"$30_days_ago"},"to":{"type":"date","required":false,"default":"$today"},"limit":{"type":"int","required":false,"default":10}}',
   array['collected_revenue', 'ltv_simple']),
  ('fill_rate_by_daypart', 1, 'Fill rate by weekday and daypart',
   'Booked capacity divided by imported session capacity by studio-local weekday and daypart for a date range.',
   '{"from":{"type":"date","required":false,"default":"$30_days_ago"},"to":{"type":"date","required":false,"default":"$today"}}',
   array['fill_rate']),
  ('credits_expiring_people', 1, 'People with credits expiring soon',
   'People with a positive operational credit balance and a next grant expiry within a number of days.',
   '{"days":{"type":"int","required":false,"default":30}}', array['credits_expiring_balance']),
  ('failed_payments_outstanding', 1, 'Outstanding failed payments',
   'Failed payment attempts in a trailing studio-local day window.',
   '{"days":{"type":"int","required":false,"default":30}}',
   array['failed_payments_outstanding']),
  ('segment_membership_current', 1, 'Current segment membership',
   'The latest successful deterministic segment snapshot, reduced to each person''s highest-priority segment.',
   '{}'::jsonb, array['segment_membership_current']),
  ('booking_channel_mix', 1, 'Booking channel mix',
   'Bookings grouped into ClassPass and direct channels for a date range.',
   '{"from":{"type":"date","required":false,"default":"$30_days_ago"},"to":{"type":"date","required":false,"default":"$today"}}',
   array['booking_channel_mix']),
  ('new_people_by_week', 1, 'New people by week',
   'People records created by studio-local week across a trailing number of weeks.',
   '{"weeks":{"type":"int","required":false,"default":12}}', array['new_people'])
on conflict (key) do nothing;

create table if not exists public.ask_misses (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  question   text not null check (length(btrim(question)) between 1 and 2000),
  asked_by   uuid,
  created_at timestamptz not null default now()
);

create index if not exists ask_misses_tenant_created_idx
  on public.ask_misses (tenant_id, created_at desc);

comment on table public.ask_misses is
  'Append-only record of honest /ask misses. Product review uses this tenant-scoped evidence to grow the approved catalog.';

alter table public.ask_catalog enable row level security;
alter table public.ask_misses enable row level security;

drop policy if exists ask_catalog_select on public.ask_catalog;
create policy ask_catalog_select on public.ask_catalog
  for select to authenticated using (true);

drop policy if exists ask_misses_select on public.ask_misses;
create policy ask_misses_select on public.ask_misses
  for select to authenticated
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists ask_misses_insert on public.ask_misses;
create policy ask_misses_insert on public.ask_misses
  for insert to authenticated
  with check (
    tenant_id in (select app.current_tenant_ids())
    and asked_by = (select auth.uid())
  );

revoke all on public.ask_catalog from anon, authenticated, service_role;
revoke all on public.ask_misses from anon, authenticated, service_role;
grant select on public.ask_catalog to authenticated, service_role;
grant select, insert on public.ask_misses to authenticated, service_role;
revoke update, delete on public.ask_misses from anon, authenticated, service_role;

-- Catalog functions ----------------------------------------------------------

create or replace function public.ask_revenue_by_tender(
  p_tenant uuid, p_from date, p_to date
)
returns table (tender text, gross numeric, refunds numeric, net numeric, txn_count int)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  ), eligible as (
    select coalesce(nullif(btrim(gt.payment_method), ''), 'unknown') as tender,
           gt.transaction_status, gt.amount
    from public.glofox_transactions gt
    cross join tenant_location tl
    where gt.tenant_id = p_tenant
      and gt.transaction_status in ('PAID', 'REFUNDED')
      and (gt.transaction_created_at at time zone tl.timezone)::date between p_from and p_to
      and not exists (
        select 1 from public.relationship_overrides ro
        where ro.tenant_id = p_tenant and ro.active
          and (
            ro.person_external_ref = gt.person_external_ref
            or exists (
              select 1 from public.people p
              join public.person_external_refs per
                on per.tenant_id = p.tenant_id and per.person_id = p.id
               and per.system = 'glofox'
              where p.tenant_id = p_tenant
                and p.external_ref = ro.person_external_ref
                and per.external_ref = gt.person_external_ref
            )
          )
      )
  )
  select e.tender,
         coalesce(sum(e.amount) filter (where e.transaction_status = 'PAID'), 0)::numeric,
         coalesce(sum(-abs(e.amount)) filter (where e.transaction_status = 'REFUNDED'), 0)::numeric,
         (coalesce(sum(e.amount) filter (where e.transaction_status = 'PAID'), 0)
           + coalesce(sum(-abs(e.amount)) filter (where e.transaction_status = 'REFUNDED'), 0))::numeric,
         count(*)::int
  from eligible e group by e.tender order by net desc, e.tender;
$$;

comment on function public.ask_revenue_by_tender(uuid, date, date) is
  'Approved /ask collected-revenue tender grouping. Uses the v1 NOEQL active-override exclusion and studio-local dates.';

create or replace function public.ask_fill_rate_by_daypart(
  p_tenant uuid, p_from date, p_to date
)
returns table (dow int, daypart text, sessions int, booked int, capacity int, fill numeric)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  ), session_facts as (
    select gs.id,
           extract(dow from gs.time_start at time zone tl.timezone)::int as dow,
           case
             when extract(hour from gs.time_start at time zone tl.timezone) >= 6
              and extract(hour from gs.time_start at time zone tl.timezone) < 11 then 'morning'
             when extract(hour from gs.time_start at time zone tl.timezone) >= 11
              and extract(hour from gs.time_start at time zone tl.timezone) < 16 then 'midday'
             when extract(hour from gs.time_start at time zone tl.timezone) >= 16
              and extract(hour from gs.time_start at time zone tl.timezone) < 21 then 'evening'
           end as daypart,
           greatest(coalesce(gs.capacity, 0), 0)::int as capacity,
           count(gb.id) filter (
             where gb.deleted_at is null and (gb.attended is true or gb.status = 'BOOKED')
           )::int as booked
    from public.glofox_sessions gs
    cross join tenant_location tl
    left join public.glofox_bookings gb
      on gb.tenant_id = gs.tenant_id and gb.session_external_ref = gs.external_ref
    where gs.tenant_id = p_tenant
      and (gs.time_start at time zone tl.timezone)::date between p_from and p_to
      and extract(hour from gs.time_start at time zone tl.timezone) >= 6
      and extract(hour from gs.time_start at time zone tl.timezone) < 21
    group by gs.id, gs.time_start, tl.timezone, gs.capacity
  )
  select sf.dow, sf.daypart, count(*)::int, sum(sf.booked)::int,
         sum(sf.capacity)::int,
         coalesce(sum(sf.booked)::numeric / nullif(sum(sf.capacity), 0), 0)::numeric
  from session_facts sf
  group by sf.dow, sf.daypart
  order by sf.dow, case sf.daypart when 'morning' then 1 when 'midday' then 2 else 3 end;
$$;

comment on function public.ask_fill_rate_by_daypart(uuid, date, date) is
  'Phase-2 30-day fill approximation: eligible attended or BOOKED non-deleted bookings divided by imported glofox_sessions.capacity in three studio-local dayparts. Turnover/readiness modeling is deferred to phase 4 and is not represented as demand.';

create or replace function public.ask_schedule_sessions(
  p_tenant uuid, p_from date, p_to date
)
returns table (
  dow int, daypart text, session_id uuid, name text, time_start timestamptz,
  booked int, capacity int
)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  )
  select extract(dow from gs.time_start at time zone tl.timezone)::int,
         case
           when extract(hour from gs.time_start at time zone tl.timezone) < 11 then 'morning'
           when extract(hour from gs.time_start at time zone tl.timezone) < 16 then 'midday'
           else 'evening'
         end,
         gs.id, gs.name, gs.time_start,
         count(gb.id) filter (
           where gb.deleted_at is null and (gb.attended is true or gb.status = 'BOOKED')
         )::int,
         greatest(coalesce(gs.capacity, 0), 0)::int
  from public.glofox_sessions gs
  cross join tenant_location tl
  left join public.glofox_bookings gb
    on gb.tenant_id = gs.tenant_id and gb.session_external_ref = gs.external_ref
  where gs.tenant_id = p_tenant
    and (gs.time_start at time zone tl.timezone)::date between p_from and p_to
    and extract(hour from gs.time_start at time zone tl.timezone) >= 6
    and extract(hour from gs.time_start at time zone tl.timezone) < 21
  group by gs.id, gs.name, gs.time_start, tl.timezone, gs.capacity
  order by gs.time_start, gs.id;
$$;

comment on function public.ask_schedule_sessions(uuid, date, date) is
  'Fixed-schema source-session disclosure for the 30-day fill heatmap; uses the identical phase-2 eligibility approximation as ask_fill_rate_by_daypart.';

create or replace function public.ask_booking_channel_mix(
  p_tenant uuid, p_from date, p_to date
)
returns table (channel text, bookings int)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  )
  select case when gb.origin ilike '%classpass%' then 'classpass' else 'direct' end,
         count(*)::int
  from public.glofox_bookings gb cross join tenant_location tl
  where gb.tenant_id = p_tenant and gb.deleted_at is null
    and (gb.attended is true or gb.status = 'BOOKED')
    and (gb.time_start at time zone tl.timezone)::date between p_from and p_to
  group by 1 order by 1;
$$;

create or replace function public.ask_new_people_by_week(p_tenant uuid, p_weeks int)
returns table (week date, new_people int)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  )
  select date_trunc('week', p.created_at at time zone tl.timezone)::date,
         count(*)::int
  from public.people p cross join tenant_location tl
  where p.tenant_id = p_tenant
    and (p.created_at at time zone tl.timezone)::date
      >= (now() at time zone tl.timezone)::date - (7 * greatest(coalesce(p_weeks, 12), 1) - 1)
  group by 1 order by 1;
$$;

create or replace function public.ask_top_customers(
  p_tenant uuid, p_from date, p_to date, p_limit int
)
returns table (person_id uuid, collected numeric)
language sql stable security invoker set search_path = ''
as $$
  with tenant_location as (
    select l.timezone from public.locations l
    where l.tenant_id = p_tenant order by l.created_at, l.id limit 1
  ), person_transactions as (
    select p.id as person_id, gt.transaction_status, gt.amount
    from public.people p
    join public.glofox_transactions gt
      on gt.tenant_id = p.tenant_id
     and (gt.person_external_ref = p.external_ref or exists (
       select 1 from public.person_external_refs per
       where per.tenant_id = p_tenant and per.person_id = p.id
         and per.system = 'glofox' and per.external_ref = gt.person_external_ref
     ))
    cross join tenant_location tl
    where p.tenant_id = p_tenant
      and gt.transaction_status in ('PAID', 'REFUNDED')
      and (gt.transaction_created_at at time zone tl.timezone)::date between p_from and p_to
      and not exists (
        select 1 from public.relationship_overrides ro
        where ro.tenant_id = p_tenant and ro.active
          and (ro.person_external_ref = gt.person_external_ref
            or ro.person_external_ref = p.external_ref
            or exists (
              select 1 from public.person_external_refs opr
              where opr.tenant_id = p_tenant and opr.person_id = p.id
                and opr.system = 'glofox' and opr.external_ref = ro.person_external_ref
            ))
      )
  )
  select pt.person_id,
         (coalesce(sum(pt.amount) filter (where pt.transaction_status = 'PAID'), 0)
          + coalesce(sum(-abs(pt.amount)) filter (where pt.transaction_status = 'REFUNDED'), 0))::numeric
  from person_transactions pt group by pt.person_id
  order by 2 desc, pt.person_id limit least(greatest(coalesce(p_limit, 10), 1), 100);
$$;

comment on function public.ask_top_customers(uuid, date, date, int) is
  'Approved period-bounded collected-revenue ranking. Active relationship-override (NOEQL) transactions are excluded. Returns ids only; the RLS-scoped API resolves display names.';

create or replace function public.ask_credits_expiring(p_tenant uuid, p_days int)
returns table (person_id uuid, balance int, next_expiry timestamptz)
language sql stable security invoker set search_path = ''
as $$
  with balances as (
    select cl.person_id, sum(cl.delta)::int as balance,
           min(cl.expires_at) filter (
             where cl.entry_type = 'grant' and cl.expires_at > now()
           ) as next_expiry
    from public.credit_ledger cl where cl.tenant_id = p_tenant
    group by cl.person_id
  )
  select b.person_id, b.balance, b.next_expiry
  from balances b
  where b.balance > 0 and b.next_expiry is not null
    and b.next_expiry <= now() + make_interval(days => greatest(coalesce(p_days, 30), 1))
  order by b.next_expiry, b.person_id;
$$;

-- Exact function privileges: no PUBLIC execution, all calls remain RLS-scoped.
revoke all on function public.ask_revenue_by_tender(uuid, date, date) from public;
revoke all on function public.ask_fill_rate_by_daypart(uuid, date, date) from public;
revoke all on function public.ask_schedule_sessions(uuid, date, date) from public;
revoke all on function public.ask_booking_channel_mix(uuid, date, date) from public;
revoke all on function public.ask_new_people_by_week(uuid, int) from public;
revoke all on function public.ask_top_customers(uuid, date, date, int) from public;
revoke all on function public.ask_credits_expiring(uuid, int) from public;

grant execute on function public.ask_revenue_by_tender(uuid, date, date) to authenticated, service_role;
grant execute on function public.ask_fill_rate_by_daypart(uuid, date, date) to authenticated, service_role;
grant execute on function public.ask_schedule_sessions(uuid, date, date) to authenticated, service_role;
grant execute on function public.ask_booking_channel_mix(uuid, date, date) to authenticated, service_role;
grant execute on function public.ask_new_people_by_week(uuid, int) to authenticated, service_role;
grant execute on function public.ask_top_customers(uuid, date, date, int) to authenticated, service_role;
grant execute on function public.ask_credits_expiring(uuid, int) to authenticated, service_role;
