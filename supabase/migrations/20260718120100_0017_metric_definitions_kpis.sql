-- Phase 2 · unit 1 — the versioned revenue dictionary and deterministic KPI
-- engine. SQL owns every number; the API only transports these results.
--
-- All KPI functions are SECURITY INVOKER so the caller's table RLS remains
-- authoritative. Date windows are interpreted in the tenant's location
-- timezone. Phase 2's operator UI is single-location; each function therefore
-- selects the tenant's first location deterministically. Multi-location
-- reporting must add an explicit location parameter before that UI ships.

-- dictionary ------------------------------------------------------------------
create table if not exists public.metric_definitions (
  id             uuid primary key default gen_random_uuid(),
  key            text not null,
  version        int not null check (version > 0),
  definition     text not null,
  notes          text,
  effective_from timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (key, version)
);

comment on table public.metric_definitions is
  'Product-wide, versioned user-facing KPI dictionary. Every rendered number cites one of these immutable key/version definitions.';

insert into public.metric_definitions (key, version, definition, notes)
values
  (
    'collected_revenue', 1,
    'Succeeded payments (card + cash) − refunds, in the period, by studio-local day. Cash basis, labeled “collected.” Gift-card loads included but broken out (they are liability until redeemed); gift-card redemptions excluded (already counted at load). Stripe fees not deducted (gross), fees shown separately. EXCLUDES partner-invoiced placeholder charges (NOEQL: $0/$1 rows from people under an active relationship override) — partner revenue is invoiced monthly outside Glofox and is NOT in this figure.',
    'Earned/recognized revenue (pack deferral and breakage) is deliberately v2, with an accountant; v1 never claims GAAP.'
  ),
  (
    'mrr', 1,
    'Sum over recurring members of their most recent subscription_payment amount in the trailing 45 days (the real collected monthly amount, discounts included); members with no such payment (partner-billed/comped) are EXCLUDED and counted separately as partner_invoiced_members — labeled, never guessed.',
    'Not a normalized contract-value estimate: it reports the latest real monthly collection for each contributing recurring member.'
  ),
  (
    'member_count', 1,
    'primary_relationship = recurring_member. Only this cohort. Ever.',
    'The owner-adjudicated recurring cohort includes active partner-billed/comped relationship overrides.'
  ),
  (
    'attendance_rate', 1,
    'checked_in ÷ (confirmed + checked_in + no_show), per period.',
    'Cancelled and late-cancelled bookings are excluded from the denominator.'
  ),
  (
    'no_show_rate', 1,
    'no_show ÷ (confirmed + checked_in + no_show).',
    'Cancelled and late-cancelled bookings are excluded from the denominator.'
  ),
  (
    'fill_rate', 1,
    'Booked capacity ÷ available capacity per slot; available excludes not-ready/turnover/maintenance time.',
    'Feeds the heatmap; readiness exclusion prevents cleaning gaps reading as demand failure.'
  ),
  (
    'room_utilization', 1,
    'Booked minutes ÷ open-hours minutes per resource.',
    null
  ),
  (
    'credit_liability', 1,
    'Operational, not GAAP. Sum over unexpired grants of (granted − debits attributed to that grant under earliest-expiring-first lot attribution) × that grant’s unit price; expired remainders are closed by expire ledger entries and drop out. Phase-1 approximation: imported grant rows do not retain a direct plan-catalog key, so unit price is derived from the nearest paid plan transaction or the person’s current catalog membership where possible; unpriced credits remain in outstanding_credits but contribute $0 to est_liability.',
    'Always returned with approximate=true until imported grants carry a direct immutable price reference. A tenant breakage policy does not yet exist.'
  ),
  (
    'ltv_simple', 1,
    'Lifetime collected revenue per person.',
    'Labeled “lifetime collected,” with no projection. Partner-invoiced NOEQL placeholder charges are excluded.'
  ),
  (
    'walk_ins', 1,
    'Same-day front-desk-channel bookings.',
    null
  ),
  (
    'aggregator_revenue', 1,
    'Recorded net payout when known; otherwise flagged estimated with the assumption shown.',
    'The current ClassPass payout assumption still requires owner confirmation.'
  ),
  (
    'trust_streak', 1,
    'Consecutive days with zero failed-check figures rendered and zero unverified figures shown unmarked. Verified renders plain; imported-unverified renders marked and does not break the streak; failed-check is greyed out with a reason and never renders as a plain number.',
    'Computed from the verification ledger.'
  ),
  (
    'conversion_rate', 1,
    'Numerator: people whose primary_relationship transitioned to recurring_member during the month. Denominator: people whose primary_relationship was pack_holder, guest, or aggregator on the first day of that month.',
    'The canonical growth KPI. hooked → member is a secondary segment-level lens.'
  ),
  (
    'failed_payments_outstanding', 1,
    'Failed Glofox transactions in the trailing studio-local window: transaction_status = ERROR or glofox_event_class = subscription_payment_failed. failed_sum is the attempted amount and people is the distinct affected-person count.',
    'This is the pre-cutover dunning feed; it does not claim the balance remains collectible.'
  ),
  (
    'partner_invoiced_members', 1,
    'Recurring members excluded from MRR because they have an active partner-billing relationship override or no succeeded subscription_payment in the trailing 45 studio-local days. Counted and labeled; partner revenue is never guessed from Glofox placeholder charges.',
    'Includes partner-billed and comped members; the external monthly invoice is outside Glofox.'
  )
on conflict (key, version) do nothing;

alter table public.metric_definitions enable row level security;

drop policy if exists metric_definitions_select on public.metric_definitions;
create policy metric_definitions_select on public.metric_definitions
  as permissive for select to authenticated
  using (true);

revoke all on public.metric_definitions from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.metric_definitions from authenticated;
grant select on public.metric_definitions to authenticated, service_role;

-- Shared studio-local report dates. Keeping "today" in SQL prevents the API
-- server's timezone from changing a KPI window near midnight.
create or replace function public.kpi_report_dates(p_tenant uuid)
returns table (today date, from_7d date, from_30d date)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    d.today,
    d.today - 6,
    d.today - 29
  from (
    select (now() at time zone l.timezone)::date as today
    from public.locations l
    where l.tenant_id = p_tenant
    order by l.created_at, l.id
    limit 1
  ) d;
$$;

comment on function public.kpi_report_dates(uuid) is
  'Studio-local date windows for KPI transport; supporting primitive for metric_definitions v1. Single-location phase-2 assumption.';

-- Collected revenue -----------------------------------------------------------
create or replace function public.kpi_collected_revenue(
  p_tenant uuid,
  p_from date,
  p_to date
)
returns table (day date, gross numeric, refunds numeric, net numeric, txn_count int)
language sql
stable
security invoker
set search_path = ''
as $$
  with tenant_location as (
    select l.timezone
    from public.locations l
    where l.tenant_id = p_tenant
    order by l.created_at, l.id
    limit 1
  ), eligible as (
    select
      (gt.transaction_created_at at time zone tl.timezone)::date as studio_day,
      gt.transaction_status,
      gt.amount
    from public.glofox_transactions gt
    cross join tenant_location tl
    where gt.tenant_id = p_tenant
      and gt.transaction_status in ('PAID', 'REFUNDED')
      and (gt.transaction_created_at at time zone tl.timezone)::date between p_from and p_to
      and not exists (
        select 1
        from public.relationship_overrides ro
        where ro.tenant_id = p_tenant
          and ro.active
          and (
            ro.person_external_ref = gt.person_external_ref
            or exists (
              select 1
              from public.people override_person
              join public.person_external_refs override_ref
                on override_ref.tenant_id = override_person.tenant_id
               and override_ref.person_id = override_person.id
               and override_ref.system = 'glofox'
              where override_person.tenant_id = p_tenant
                and override_person.external_ref = ro.person_external_ref
                and override_ref.external_ref = gt.person_external_ref
            )
          )
      )
  )
  select
    e.studio_day,
    coalesce(sum(e.amount) filter (where e.transaction_status = 'PAID'), 0)::numeric as gross,
    coalesce(sum(-abs(e.amount)) filter (where e.transaction_status = 'REFUNDED'), 0)::numeric as refunds,
    (
      coalesce(sum(e.amount) filter (where e.transaction_status = 'PAID'), 0)
      + coalesce(sum(-abs(e.amount)) filter (where e.transaction_status = 'REFUNDED'), 0)
    )::numeric as net,
    count(*)::int as txn_count
  from eligible e
  group by e.studio_day
  order by e.studio_day;
$$;

comment on function public.kpi_collected_revenue(uuid, date, date) is
  'metric_definitions(collected_revenue, v1). Daily cash-basis gross/refunds/net; active relationship-override (NOEQL) transactions are excluded. Single-location phase-2 assumption.';

-- Totals are a separate SQL result so neither API nor UI performs arithmetic.
create or replace function public.kpi_collected_revenue_totals(
  p_tenant uuid,
  p_from date,
  p_to date
)
returns table (gross numeric, refunds numeric, net numeric, txn_count int)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(sum(r.gross), 0)::numeric,
    coalesce(sum(r.refunds), 0)::numeric,
    coalesce(sum(r.net), 0)::numeric,
    coalesce(sum(r.txn_count), 0)::int
  from public.kpi_collected_revenue(p_tenant, p_from, p_to) r;
$$;

comment on function public.kpi_collected_revenue_totals(uuid, date, date) is
  'metric_definitions(collected_revenue, v1). SQL-owned totals over kpi_collected_revenue; the API never re-computes daily rows.';

-- MRR + member count ----------------------------------------------------------
create or replace function public.kpi_mrr(p_tenant uuid)
returns table (mrr numeric, contributing_members int, excluded_partner int)
language sql
stable
security invoker
set search_path = ''
as $$
  with tenant_location as (
    select l.timezone
    from public.locations l
    where l.tenant_id = p_tenant
    order by l.created_at, l.id
    limit 1
  ), recurring as (
    select
      p.id,
      p.external_ref,
      exists (
        select 1
        from public.relationship_overrides ro
        where ro.tenant_id = p_tenant
          and ro.active
          and (
            ro.person_external_ref = p.external_ref
            or exists (
              select 1
              from public.person_external_refs override_ref
              where override_ref.tenant_id = p_tenant
                and override_ref.person_id = p.id
                and override_ref.system = 'glofox'
                and override_ref.external_ref = ro.person_external_ref
            )
          )
      ) as has_partner_override
    from public.people p
    where p.tenant_id = p_tenant
      and p.primary_relationship = 'recurring_member'
  ), member_payments as (
    select r.id, r.has_partner_override, latest.amount
    from recurring r
    cross join tenant_location tl
    left join lateral (
      select gt.amount
      from public.glofox_transactions gt
      where gt.tenant_id = p_tenant
        and gt.transaction_status = 'PAID'
        and gt.glofox_event_class = 'subscription_payment'
        and (gt.transaction_created_at at time zone tl.timezone)::date
              >= (now() at time zone tl.timezone)::date - 44
        and gt.transaction_created_at <= now()
        and not r.has_partner_override
        and (
          gt.person_external_ref = r.external_ref
          or exists (
            select 1
            from public.person_external_refs per
            where per.tenant_id = p_tenant
              and per.person_id = r.id
              and per.system = 'glofox'
              and per.external_ref = gt.person_external_ref
          )
        )
      order by gt.transaction_created_at desc, gt.id desc
      limit 1
    ) latest on true
  )
  select
    coalesce(sum(mp.amount) filter (where mp.amount is not null), 0)::numeric,
    (count(*) filter (where mp.amount is not null))::int,
    (count(*) filter (where mp.amount is null))::int
  from member_payments mp;
$$;

comment on function public.kpi_mrr(uuid) is
  'metric_definitions(mrr, v1) and metric_definitions(partner_invoiced_members, v1). Latest real PAID subscription_payment per recurring member in 45 studio-local days; active override/no-payment members are excluded and counted, never guessed.';

create or replace function public.kpi_member_count(p_tenant uuid)
returns int
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::int
  from public.people p
  where p.tenant_id = p_tenant
    and p.primary_relationship = 'recurring_member';
$$;

comment on function public.kpi_member_count(uuid) is
  'metric_definitions(member_count, v1): primary_relationship = recurring_member. Only this cohort. Ever.';

-- Attendance ------------------------------------------------------------------
create or replace function public.kpi_attendance(
  p_tenant uuid,
  p_from date,
  p_to date
)
returns table (
  attended int,
  no_show int,
  late_cancel int,
  attendance_rate numeric,
  no_show_rate numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tenant_location as (
    select l.timezone
    from public.locations l
    where l.tenant_id = p_tenant
    order by l.created_at, l.id
    limit 1
  ), windowed as (
    select gb.*
    from public.glofox_bookings gb
    cross join tenant_location tl
    where gb.tenant_id = p_tenant
      and (gb.time_start at time zone tl.timezone)::date between p_from and p_to
  ), counts as (
    select
      count(*) filter (
        where w.attended is true
          and w.status <> 'CANCELED'
          and not coalesce(w.is_late_cancellation, false)
      )::int as attended,
      count(*) filter (
        where w.attended is false
          and w.status in ('BOOKED', 'RESERVED')
          and not coalesce(w.is_late_cancellation, false)
          and w.time_start < now()
      )::int as no_show,
      (count(*) filter (where w.is_late_cancellation is true))::int as late_cancel
    from windowed w
  )
  select
    c.attended,
    c.no_show,
    c.late_cancel,
    coalesce(c.attended::numeric / nullif(c.attended + c.no_show, 0), 0)::numeric,
    coalesce(c.no_show::numeric / nullif(c.attended + c.no_show, 0), 0)::numeric
  from counts c;
$$;

comment on function public.kpi_attendance(uuid, date, date) is
  'metric_definitions(attendance_rate, v1) and metric_definitions(no_show_rate, v1). Cancelled/late-cancelled bookings are excluded from the denominator; only elapsed confirmed bookings can become no-shows. Single-location phase-2 assumption.';

-- Lifetime collected ----------------------------------------------------------
create or replace function public.kpi_ltv_simple(p_tenant uuid, p_limit int default 10)
returns table (person_id uuid, lifetime numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with person_transactions as (
    select
      p.id as person_id,
      gt.transaction_status,
      gt.amount
    from public.people p
    join public.glofox_transactions gt
      on gt.tenant_id = p.tenant_id
     and (
       gt.person_external_ref = p.external_ref
       or exists (
         select 1
         from public.person_external_refs per
         where per.tenant_id = p_tenant
           and per.person_id = p.id
           and per.system = 'glofox'
           and per.external_ref = gt.person_external_ref
       )
     )
    where p.tenant_id = p_tenant
      and gt.transaction_status in ('PAID', 'REFUNDED')
      and not exists (
        select 1
        from public.relationship_overrides ro
        where ro.tenant_id = p_tenant
          and ro.active
          and (
            ro.person_external_ref = gt.person_external_ref
            or ro.person_external_ref = p.external_ref
            or exists (
              select 1
              from public.person_external_refs override_ref
              where override_ref.tenant_id = p_tenant
                and override_ref.person_id = p.id
                and override_ref.system = 'glofox'
                and override_ref.external_ref = ro.person_external_ref
            )
          )
      )
  )
  select
    pt.person_id,
    (
      coalesce(sum(pt.amount) filter (where pt.transaction_status = 'PAID'), 0)
      + coalesce(sum(-abs(pt.amount)) filter (where pt.transaction_status = 'REFUNDED'), 0)
    )::numeric as lifetime
  from person_transactions pt
  group by pt.person_id
  order by lifetime desc, pt.person_id
  limit greatest(coalesce(p_limit, 10), 0);
$$;

comment on function public.kpi_ltv_simple(uuid, int) is
  'metric_definitions(ltv_simple, v1). Top-N lifetime collected revenue; active relationship-override (NOEQL) transactions excluded. Returns ids only, never names or contact PII.';

-- Credit liability ------------------------------------------------------------
create or replace function public.kpi_credit_liability(p_tenant uuid)
returns table (outstanding_credits int, est_liability numeric, approximate boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  with unexpired_lots as (
    select
      g.id,
      g.person_id,
      g.created_at,
      greatest(g.delta + coalesce(sum(a.delta), 0), 0)::int as remaining
    from public.credit_ledger g
    left join public.credit_ledger a
      on a.tenant_id = g.tenant_id
     and a.grant_id = g.id
    where g.tenant_id = p_tenant
      and g.entry_type = 'grant'
      and (g.expires_at is null or g.expires_at > now())
    group by g.id, g.person_id, g.created_at, g.delta
  ), priced_lots as (
    select ul.remaining, unit.unit_price
    from unexpired_lots ul
    join public.people p
      on p.tenant_id = p_tenant
     and p.id = ul.person_id
    left join lateral (
      select pc.price / pc.credits_granted::numeric as unit_price
      from public.plan_catalog pc
      where pc.tenant_id = p_tenant
        and pc.price is not null
        and pc.credits_granted > 0
        and (
          pc.plan_code = (
            select gt.plan_code
            from public.glofox_transactions gt
            where gt.tenant_id = p_tenant
              and gt.transaction_status = 'PAID'
              and gt.plan_code is not null
              and gt.transaction_created_at <= ul.created_at
              and (
                gt.person_external_ref = p.external_ref
                or exists (
                  select 1
                  from public.person_external_refs per
                  where per.tenant_id = p_tenant
                    and per.person_id = p.id
                    and per.system = 'glofox'
                    and per.external_ref = gt.person_external_ref
                )
              )
            order by gt.transaction_created_at desc, gt.id desc
            limit 1
          )
          or pc.external_ref = p.user_membership_id
        )
      order by (pc.external_ref = p.user_membership_id) desc, pc.updated_at desc, pc.id
      limit 1
    ) unit on true
    where ul.remaining > 0
  )
  select
    coalesce(sum(pl.remaining), 0)::int,
    coalesce(sum(pl.remaining * pl.unit_price) filter (where pl.unit_price is not null), 0)::numeric,
    true
  from priced_lots pl;
$$;

comment on function public.kpi_credit_liability(uuid) is
  'metric_definitions(credit_liability, v1). Operational, not GAAP. RLS-safe ledger lot attribution with phase-1 approximate catalog-price matching; unpriced credits remain counted and approximate is always true.';

-- Failed-payment dunning feed -------------------------------------------------
create or replace function public.kpi_failed_payments(p_tenant uuid, p_days int default 30)
returns table (failed_count int, failed_sum numeric, people int)
language sql
stable
security invoker
set search_path = ''
as $$
  with tenant_location as (
    select l.timezone
    from public.locations l
    where l.tenant_id = p_tenant
    order by l.created_at, l.id
    limit 1
  )
  select
    count(*)::int,
    coalesce(sum(gt.amount), 0)::numeric,
    (count(distinct gt.person_external_ref) filter (
      where gt.person_external_ref is not null
    ))::int
  from public.glofox_transactions gt
  cross join tenant_location tl
  where gt.tenant_id = p_tenant
    and (
      gt.transaction_status = 'ERROR'
      or gt.glofox_event_class = 'subscription_payment_failed'
    )
    and (gt.transaction_created_at at time zone tl.timezone)::date
          >= (now() at time zone tl.timezone)::date - greatest(coalesce(p_days, 30), 1) + 1
    and gt.transaction_created_at <= now();
$$;

comment on function public.kpi_failed_payments(uuid, int) is
  'metric_definitions(failed_payments_outstanding, v1). ERROR or subscription_payment_failed rows in the trailing studio-local window; deterministic pre-cutover dunning feed. Single-location phase-2 assumption.';

-- Function privileges ---------------------------------------------------------
revoke all on function public.kpi_report_dates(uuid) from public;
revoke all on function public.kpi_collected_revenue(uuid, date, date) from public;
revoke all on function public.kpi_collected_revenue_totals(uuid, date, date) from public;
revoke all on function public.kpi_mrr(uuid) from public;
revoke all on function public.kpi_member_count(uuid) from public;
revoke all on function public.kpi_attendance(uuid, date, date) from public;
revoke all on function public.kpi_ltv_simple(uuid, int) from public;
revoke all on function public.kpi_credit_liability(uuid) from public;
revoke all on function public.kpi_failed_payments(uuid, int) from public;

grant execute on function public.kpi_report_dates(uuid) to authenticated, service_role;
grant execute on function public.kpi_collected_revenue(uuid, date, date) to authenticated, service_role;
grant execute on function public.kpi_collected_revenue_totals(uuid, date, date) to authenticated, service_role;
grant execute on function public.kpi_mrr(uuid) to authenticated, service_role;
grant execute on function public.kpi_member_count(uuid) to authenticated, service_role;
grant execute on function public.kpi_attendance(uuid, date, date) to authenticated, service_role;
grant execute on function public.kpi_ltv_simple(uuid, int) to authenticated, service_role;
grant execute on function public.kpi_credit_liability(uuid) to authenticated, service_role;
grant execute on function public.kpi_failed_payments(uuid, int) to authenticated, service_role;
