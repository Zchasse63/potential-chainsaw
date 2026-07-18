-- Phase 2 · unit 2 — deterministic behavioral segments.
-- The AI narrates these facts; it never computes them. Definitions are
-- versioned, every recompute creates an immutable assignment snapshot, and
-- the outreach read path applies the one-person/one-slot priority rule.

-- versioned global registry ---------------------------------------------------
create table if not exists public.segment_definitions (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,
  version       int not null,
  priority      int not null check (priority between 1 and 13),
  description   text not null,
  params        jsonb not null default '{}'::jsonb,
  action_intent text,
  created_at    timestamptz not null default now(),
  unique (key, version)
);

insert into public.segment_definitions
  (key, version, priority, description, params, action_intent)
values
  ('payment_risk', 1, 1,
   'Recurring member with a failed-payment signal in the trailing 30 studio-local days.',
   '{"days":30}'::jsonb,
   'Card-update chase.'),
  ('at_risk', 1, 2,
   'Recurring member with no attended visit for at least 21 studio-local days.',
   '{"days":21,"cooldown_days":7}'::jsonb,
   'Personal outreach; call this week.'),
  ('credits_expiring', 1, 3,
   'Positive credit balance with the next known grant expiry within 14 studio-local days.',
   '{"days":14,"cooldown_days":7}'::jsonb,
   'Use-your-credits nudge.'),
  ('hooked', 1, 4,
   'Non-member with at least 3 attended visits in the trailing 30 studio-local days.',
   '{"visits":3,"days":30,"cooldown_days":7}'::jsonb,
   'Offer membership while the habit is hot.'),
  ('trial_graduated', 1, 5,
   'Non-member with an intro-plan purchase in the trailing 60 studio-local days and no later mapped non-intro purchase; v1 approximates consumed or expired from purchase recency.',
   '{"days":60,"cooldown_days":7}'::jsonb,
   'Offer a time-boxed standard membership.'),
  ('stale_credits', 1, 6,
   'Positive credit balance with no attended visit for at least 30 studio-local days.',
   '{"days":30,"cooldown_days":7}'::jsonb,
   'Win the visit back before the habit fades.'),
  ('win_back', 1, 7,
   'Non-member who left recurring membership within 180 days, excluding payment risk, or an exhausted-pack regular with at least 5 lifetime visits whose last visit was 60 to 180 days ago.',
   '{"member_days":180,"visits":5,"visit_min_days":60,"visit_max_days":180,"cooldown_days":7}'::jsonb,
   'Offer a return campaign.'),
  ('aggregator_regular', 1, 8,
   'At least 3 attended ClassPass-origin visits in 60 studio-local days and zero direct paid purchases ever.',
   '{"visits":3,"days":60,"cooldown_days":7}'::jsonb,
   'Convert gently to a direct relationship.'),
  ('cooling', 1, 9,
   'At least 4 attended visits in days 15 through 74, none in the last 14 days; non-members remain through day 59 and members through day 20 before handoff.',
   '{"visits":4,"recent_days":14,"lookback_days":60,"nonmember_max_days":59,"member_max_days":20,"cooldown_days":7}'::jsonb,
   'Light-touch re-engagement.'),
  ('new', 1, 10,
   'First activity within 21 studio-local days and at least one attended visit; earliest attendance is the fallback when first_activity_at is absent.',
   '{"days":21,"cooldown_days":7}'::jsonb,
   'Welcome and encourage a second visit.'),
  ('cold_lead', 1, 11,
   'Lead first seen in Kelo at least 14 studio-local days ago with no transaction; source records over 90 days older than the first sync run are excluded from launch automation.',
   '{"days":14,"launch_backfill_days":90,"cooldown_days":7}'::jsonb,
   'Enroll in the intro-offer lifecycle.'),
  ('high_value', 1, 12,
   'Top 10 percent by trailing-12-month collected paid amount (owner default B13), excluding people represented by an active relationship override.',
   '{"top_percent":10,"cooldown_days":7}'::jsonb,
   'VIP recognition or referral ask; never discount.'),
  ('active_recurring', 1, 13,
   'Recurring member not assigned to payment risk, at risk, or cooling in this run.',
   '{}'::jsonb,
   'No outreach; health baseline.')
on conflict (key, version) do nothing;

-- recompute audit -------------------------------------------------------------
create table if not exists public.segment_runs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null check (status in ('running', 'success', 'error')),
  people_evaluated int,
  created_at       timestamptz not null default now()
);
create index if not exists segment_runs_tenant_started_idx
  on public.segment_runs (tenant_id, started_at desc);

create table if not exists public.segment_assignments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  run_id       uuid not null references public.segment_runs (id) on delete cascade,
  segment_key  text not null,
  person_id    uuid not null references public.people (id) on delete cascade,
  rule_version int not null,
  evidence     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants (id) on delete cascade
);
create index if not exists segment_assignments_tenant_run_key_idx
  on public.segment_assignments (tenant_id, run_id, segment_key);
create index if not exists segment_assignments_tenant_person_created_idx
  on public.segment_assignments (tenant_id, person_id, created_at desc);

-- deterministic tenant recompute --------------------------------------------
create or replace function app.recompute_segments(p_tenant uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule_version constant int := 1;
  v_run_id uuid;
  v_timezone text;
  v_today date;
  v_launch_at timestamptz;
  v_people_evaluated int;
begin
  -- Phase 2 ships a single-location UI. Pick the tenant's first location
  -- deterministically; every timestamp window below is converted to its IANA
  -- timezone before date arithmetic.
  select l.timezone
  into v_timezone
  from public.locations l
  where l.tenant_id = p_tenant
  order by l.created_at, l.id
  limit 1;

  if v_timezone is null then
    raise exception 'cannot recompute segments for tenant % without a location timezone', p_tenant;
  end if;

  v_today := (now() at time zone v_timezone)::date;

  select min(sr.started_at)
  into v_launch_at
  from public.sync_runs sr
  where sr.tenant_id = p_tenant;

  select count(*)::int
  into v_people_evaluated
  from public.people p
  where p.tenant_id = p_tenant
    and p.active;

  insert into public.segment_runs (tenant_id, status, people_evaluated)
  values (p_tenant, 'running', v_people_evaluated)
  returning id into v_run_id;

  -- Keep the run row outside the exception subtransaction. If any rule fails,
  -- all assignments roll back together while the run closes as error.
  begin
  -- §1 row 1: payment_risk. The real pre-cutover dunning feeds are BOTH an
  -- ERROR transaction status and subscription_payment_failed event class.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'payment_risk', p.id, v_rule_version,
    jsonb_build_object(
      'transaction_id', failed.id,
      'failed_on', (coalesce(failed.transaction_created_at, failed.created_at) at time zone v_timezone)::date,
      'error_status', failed.transaction_status = 'ERROR',
      'failed_event', failed.glofox_event_class = 'subscription_payment_failed',
      'window_days', 30
    )
  from public.people p
  cross join lateral (
    select gt.id, gt.transaction_status, gt.glofox_event_class,
           gt.transaction_created_at, gt.created_at
    from public.glofox_transactions gt
    where gt.tenant_id = p_tenant
      and gt.person_external_ref in (
        select pr.external_ref from person_refs pr where pr.person_id = p.id
      )
      and (
        gt.transaction_status = 'ERROR'
        or gt.glofox_event_class = 'subscription_payment_failed'
      )
      and (coalesce(gt.transaction_created_at, gt.created_at) at time zone v_timezone)::date
          between v_today - 29 and v_today
    order by coalesce(gt.transaction_created_at, gt.created_at) desc, gt.id desc
    limit 1
  ) failed
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship = 'recurring_member';

  -- §1 row 2: at_risk. Never-attended recurring members also qualify.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'at_risk', p.id, v_rule_version,
    jsonb_strip_nulls(jsonb_build_object(
      'last_attended_booking_id', last_visit.id,
      'last_attended_on', last_visit.attended_on,
      'days_since_attendance', v_today - last_visit.attended_on,
      'threshold_days', 21
    ))
  from public.people p
  left join lateral (
    select gb.id, (gb.time_start at time zone v_timezone)::date as attended_on
    from public.glofox_bookings gb
    where gb.tenant_id = p_tenant
      and gb.attended is true
      and gb.person_external_ref in (
        select pr.external_ref from person_refs pr where pr.person_id = p.id
      )
    order by gb.time_start desc, gb.id desc
    limit 1
  ) last_visit on true
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship = 'recurring_member'
    and (last_visit.attended_on is null or last_visit.attended_on <= v_today - 21);

  -- §1 row 3: credits_expiring. app.credit_balances is the phase-1 expiry
  -- read model; its known per-grant limitation is documented on the matview.
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'credits_expiring', p.id, v_rule_version,
    jsonb_build_object(
      'balance', cb.balance,
      'next_expiry_on', (cb.next_expiry at time zone v_timezone)::date,
      'days_until_expiry', (cb.next_expiry at time zone v_timezone)::date - v_today,
      'horizon_days', 14
    )
  from public.people p
  join app.credit_balances cb
    on cb.tenant_id = p.tenant_id and cb.person_id = p.id
  where p.tenant_id = p_tenant
    and p.active
    and cb.balance > 0
    and (cb.next_expiry at time zone v_timezone)::date between v_today and v_today + 14;

  -- §1 row 4: hooked.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), visit_counts as (
    select
      pr.person_id,
      count(*)::int as attended_count,
      (array_agg(gb.id order by gb.time_start desc, gb.id desc))[1] as last_booking_id,
      max((gb.time_start at time zone v_timezone)::date) as last_attended_on
    from person_refs pr
    join public.glofox_bookings gb
      on gb.tenant_id = p_tenant and gb.person_external_ref = pr.external_ref
    where gb.attended is true
      and (gb.time_start at time zone v_timezone)::date between v_today - 29 and v_today
    group by pr.person_id
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'hooked', p.id, v_rule_version,
    jsonb_build_object(
      'attended_count', vc.attended_count,
      'last_attended_booking_id', vc.last_booking_id,
      'last_attended_on', vc.last_attended_on,
      'window_days', 30,
      'threshold_visits', 3
    )
  from public.people p
  join visit_counts vc on vc.person_id = p.id
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship is distinct from 'recurring_member'
    and vc.attended_count >= 3;

  -- §1 row 5: trial_graduated. Phase-2-honest approximation: imported facts
  -- do not yet expose intro consumption/validity, so a PAID intro purchase in
  -- 60 days stands in for consumed/expired; later mapped non-intro purchases
  -- disqualify it.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), intro_purchases as (
    select distinct on (pr.person_id)
      pr.person_id,
      gt.id as transaction_id,
      gt.plan_code,
      coalesce(gt.transaction_created_at, gt.created_at) as purchased_at
    from person_refs pr
    join public.glofox_transactions gt
      on gt.tenant_id = p_tenant and gt.person_external_ref = pr.external_ref
    where gt.transaction_status = 'PAID'
      and (coalesce(gt.transaction_created_at, gt.created_at) at time zone v_timezone)::date
          between v_today - 59 and v_today
      and exists (
        select 1
        from public.plan_catalog pc
        where pc.tenant_id = p_tenant
          and pc.plan_code = gt.plan_code
          and pc.kelo_type = 'intro'
      )
    order by pr.person_id, coalesce(gt.transaction_created_at, gt.created_at) desc, gt.id desc
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'trial_graduated', p.id, v_rule_version,
    jsonb_build_object(
      'intro_transaction_id', ip.transaction_id,
      'intro_purchased_on', (ip.purchased_at at time zone v_timezone)::date,
      'window_days', 60,
      'purchase_recency_approximation', 1
    )
  from public.people p
  join intro_purchases ip on ip.person_id = p.id
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship is distinct from 'recurring_member'
    and not exists (
      select 1
      from public.glofox_transactions later
      where later.tenant_id = p_tenant
        and later.transaction_status = 'PAID'
        and later.person_external_ref in (
          select pr.external_ref from person_refs pr where pr.person_id = p.id
        )
        and coalesce(later.transaction_created_at, later.created_at) > ip.purchased_at
        and exists (
          select 1
          from public.plan_catalog later_pc
          where later_pc.tenant_id = p_tenant
            and later_pc.plan_code = later.plan_code
            and later_pc.kelo_type <> 'intro'
        )
    );

  -- §1 row 6: stale_credits.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'stale_credits', p.id, v_rule_version,
    jsonb_strip_nulls(jsonb_build_object(
      'balance', cb.balance,
      'last_attended_booking_id', last_visit.id,
      'last_attended_on', last_visit.attended_on,
      'days_since_attendance', v_today - last_visit.attended_on,
      'threshold_days', 30
    ))
  from public.people p
  join app.credit_balances cb
    on cb.tenant_id = p.tenant_id and cb.person_id = p.id
  left join lateral (
    select gb.id, (gb.time_start at time zone v_timezone)::date as attended_on
    from public.glofox_bookings gb
    where gb.tenant_id = p_tenant
      and gb.attended is true
      and gb.person_external_ref in (
        select pr.external_ref from person_refs pr where pr.person_id = p.id
      )
    order by gb.time_start desc, gb.id desc
    limit 1
  ) last_visit on true
  where p.tenant_id = p_tenant
    and p.active
    and cb.balance > 0
    and (last_visit.attended_on is null or last_visit.attended_on <= v_today - 30);

  -- §1 row 7: win_back. Branch 1 is a recent recurring-member lapse. Branch
  -- 2 requires evidence of a prior credit grant, exhausted balance, at least
  -- five lifetime attendances, and a last attendance 60-180 days ago.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), attendance as (
    select
      pr.person_id,
      count(*)::int as lifetime_attended_count,
      (array_agg(gb.id order by gb.time_start desc, gb.id desc))[1] as last_booking_id,
      max((gb.time_start at time zone v_timezone)::date) as last_attended_on
    from person_refs pr
    join public.glofox_bookings gb
      on gb.tenant_id = p_tenant and gb.person_external_ref = pr.external_ref
    where gb.attended is true
    group by pr.person_id
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'win_back', p.id, v_rule_version,
    case when lapse.id is not null then
      jsonb_build_object(
        'branch', 1,
        'relationship_log_id', lapse.id,
        'lapsed_on', lapse.lapsed_on,
        'days_since_lapse', v_today - lapse.lapsed_on,
        'window_days', 180
      )
    else
      jsonb_build_object(
        'branch', 2,
        'balance', coalesce(cb.balance, 0),
        'lifetime_attended_count', a.lifetime_attended_count,
        'last_attended_booking_id', a.last_booking_id,
        'last_attended_on', a.last_attended_on,
        'days_since_attendance', v_today - a.last_attended_on
      )
    end
  from public.people p
  left join app.credit_balances cb
    on cb.tenant_id = p.tenant_id and cb.person_id = p.id
  left join attendance a on a.person_id = p.id
  left join lateral (
    select prl.id, (prl.changed_at at time zone v_timezone)::date as lapsed_on
    from public.person_relationship_log prl
    where prl.tenant_id = p_tenant
      and prl.person_id = p.id
      and prl.from_primary = 'recurring_member'
      and prl.to_primary <> 'recurring_member'
      and (prl.changed_at at time zone v_timezone)::date between v_today - 180 and v_today
    order by prl.changed_at desc, prl.id desc
    limit 1
  ) lapse on true
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship is distinct from 'recurring_member'
    and not exists (
      select 1 from public.segment_assignments sa
      where sa.tenant_id = p_tenant and sa.run_id = v_run_id
        and sa.person_id = p.id and sa.segment_key = 'payment_risk'
    )
    and (
      lapse.id is not null
      or (
        coalesce(cb.balance, 0) = 0
        and exists (
          select 1 from public.credit_ledger cl
          where cl.tenant_id = p_tenant and cl.person_id = p.id
            and cl.entry_type in ('grant', 'refund_credit')
        )
        and a.lifetime_attended_count >= 5
        and v_today - a.last_attended_on between 60 and 180
      )
    );

  -- §1 row 8: aggregator_regular. origin is the live ClassPass marker; any
  -- lifetime PAID transaction is treated as a direct purchase in v1.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), aggregator_visits as (
    select
      pr.person_id,
      count(*)::int as attended_count,
      (array_agg(gb.id order by gb.time_start desc, gb.id desc))[1] as last_booking_id,
      max((gb.time_start at time zone v_timezone)::date) as last_attended_on
    from person_refs pr
    join public.glofox_bookings gb
      on gb.tenant_id = p_tenant and gb.person_external_ref = pr.external_ref
    where gb.attended is true
      and gb.origin ilike '%classpass%'
      and (gb.time_start at time zone v_timezone)::date between v_today - 59 and v_today
    group by pr.person_id
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'aggregator_regular', p.id, v_rule_version,
    jsonb_build_object(
      'classpass_attended_count', av.attended_count,
      'last_attended_booking_id', av.last_booking_id,
      'last_attended_on', av.last_attended_on,
      'window_days', 60,
      'direct_paid_transaction_count', 0
    )
  from public.people p
  join aggregator_visits av on av.person_id = p.id
  where p.tenant_id = p_tenant
    and p.active
    and av.attended_count >= 3
    and not exists (
      select 1
      from public.glofox_transactions gt
      where gt.tenant_id = p_tenant
        and gt.person_external_ref in (
          select pr.external_ref from person_refs pr where pr.person_id = p.id
        )
        and gt.transaction_status = 'PAID'
    );

  -- §1 row 9: cooling. The exact handoffs eliminate dead zones: members only
  -- occupy days 14-20 before at_risk; non-members occupy days 14-59 before
  -- win_back. The qualifying prior activity window is days 15-74.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), attendance as (
    select
      pr.person_id,
      count(*) filter (
        where (gb.time_start at time zone v_timezone)::date between v_today - 74 and v_today - 15
      )::int as prior_attended_count,
      (array_agg(gb.id order by gb.time_start desc, gb.id desc))[1] as last_booking_id,
      max((gb.time_start at time zone v_timezone)::date) as last_attended_on
    from person_refs pr
    join public.glofox_bookings gb
      on gb.tenant_id = p_tenant and gb.person_external_ref = pr.external_ref
    where gb.attended is true
    group by pr.person_id
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'cooling', p.id, v_rule_version,
    jsonb_build_object(
      'prior_attended_count', a.prior_attended_count,
      'last_attended_booking_id', a.last_booking_id,
      'last_attended_on', a.last_attended_on,
      'days_since_attendance', v_today - a.last_attended_on,
      'prior_window_start_days', 15,
      'prior_window_end_days', 74
    )
  from public.people p
  join attendance a on a.person_id = p.id
  where p.tenant_id = p_tenant
    and p.active
    and a.prior_attended_count >= 4
    and v_today - a.last_attended_on >= 14
    and (
      (p.primary_relationship = 'recurring_member' and v_today - a.last_attended_on <= 20)
      or
      (p.primary_relationship is distinct from 'recurring_member' and v_today - a.last_attended_on <= 59)
    );

  -- §1 row 10: new. Imported first_activity_at may be NULL; earliest attended
  -- booking is the explicit deterministic fallback.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), attendance as (
    select
      pr.person_id,
      count(*)::int as attended_count,
      min((gb.time_start at time zone v_timezone)::date) as first_attended_on,
      (array_agg(gb.id order by gb.time_start, gb.id))[1] as first_booking_id
    from person_refs pr
    join public.glofox_bookings gb
      on gb.tenant_id = p_tenant and gb.person_external_ref = pr.external_ref
    where gb.attended is true
    group by pr.person_id
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'new', p.id, v_rule_version,
    jsonb_build_object(
      'first_activity_on', coalesce(
        (p.first_activity_at at time zone v_timezone)::date,
        a.first_attended_on
      ),
      'first_attended_booking_id', a.first_booking_id,
      'attended_count', a.attended_count,
      'first_activity_fallback', (p.first_activity_at is null),
      'window_days', 21
    )
  from public.people p
  join attendance a on a.person_id = p.id
  where p.tenant_id = p_tenant
    and p.active
    and coalesce(
      (p.first_activity_at at time zone v_timezone)::date,
      a.first_attended_on
    ) between v_today - 20 and v_today;

  -- §1 row 11: cold_lead. Eligibility age uses people.created_at (Kelo's
  -- trustworthy first-seen timestamp), never source_created_at. The imported
  -- source timestamp is consulted ONLY for the launch-backfill exclusion.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'cold_lead', p.id, v_rule_version,
    jsonb_strip_nulls(jsonb_build_object(
      'kelo_first_seen_on', (p.created_at at time zone v_timezone)::date,
      'days_since_kelo_first_seen', v_today - (p.created_at at time zone v_timezone)::date,
      'first_sync_run_id', launch.id,
      'launch_on', (v_launch_at at time zone v_timezone)::date,
      'threshold_days', 14,
      'launch_backfill_days', 90,
      'transaction_count', 0
    ))
  from public.people p
  left join lateral (
    select sr.id
    from public.sync_runs sr
    where sr.tenant_id = p_tenant and sr.started_at = v_launch_at
    order by sr.id
    limit 1
  ) launch on true
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship = 'lead'
    and (p.created_at at time zone v_timezone)::date <= v_today - 14
    and not exists (
      select 1
      from public.glofox_transactions gt
      where gt.tenant_id = p_tenant
        and gt.person_external_ref in (
          select pr.external_ref from person_refs pr where pr.person_id = p.id
        )
    )
    and (
      v_launch_at is null
      or p.source_created_at is null
      or (p.source_created_at at time zone v_timezone)::date
         >= (v_launch_at at time zone v_timezone)::date - 90
    );

  -- §1 row 12: high_value (T12M per §B). Collected amount is PAID less recorded
  -- refunds. Active relationship overrides identify NOEQL placeholder people;
  -- exclude those people from both the ranking population and its denominator.
  with person_refs as (
    select p.id as person_id, p.external_ref
    from public.people p
    where p.tenant_id = p_tenant and p.active and p.external_ref is not null
    union
    select p.id, per.external_ref
    from public.people p
    join public.person_external_refs per
      on per.tenant_id = p.tenant_id and per.person_id = p.id and per.system = 'glofox'
    where p.tenant_id = p_tenant and p.active
  ), override_people as (
    select distinct pr.person_id
    from person_refs pr
    join public.relationship_overrides ro
      on ro.tenant_id = p_tenant
     and ro.person_external_ref = pr.external_ref
     and ro.active
  ), collected as (
    select
      pr.person_id,
      sum(gt.amount - coalesce(gt.amount_refunded, 0)) as lifetime_collected
    from person_refs pr
    join public.glofox_transactions gt
      on gt.tenant_id = p_tenant and gt.person_external_ref = pr.external_ref
    where gt.transaction_status = 'PAID'
      -- §B owner default: TOP 10% by TRAILING-12-MONTH collected revenue
      -- (director correction at merge — the unit brief mistakenly said lifetime).
      and gt.transaction_created_at >= now() - interval '12 months'
      and not exists (
        select 1 from override_people op where op.person_id = pr.person_id
      )
    group by pr.person_id
    having sum(gt.amount - coalesce(gt.amount_refunded, 0)) > 0
  ), ranked as (
    select
      c.person_id,
      c.lifetime_collected,
      row_number() over (order by c.lifetime_collected desc, c.person_id) as value_rank,
      count(*) over () as ranked_people
    from collected c
  )
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'high_value', r.person_id, v_rule_version,
    jsonb_build_object(
      'lifetime_collected', r.lifetime_collected,
      'value_rank', r.value_rank,
      'ranked_people', r.ranked_people,
      'top_percent', 10
    )
  from ranked r
  where r.value_rank <= greatest(1, ceil(r.ranked_people * 0.10));

  -- §1 row 13: active_recurring is intentionally computed LAST and is the
  -- complement of this run's payment_risk, at_risk, and cooling assignments.
  insert into public.segment_assignments
    (tenant_id, run_id, segment_key, person_id, rule_version, evidence)
  select
    p_tenant, v_run_id, 'active_recurring', p.id, v_rule_version,
    jsonb_build_object('excluded_priority_segment_count', 0)
  from public.people p
  where p.tenant_id = p_tenant
    and p.active
    and p.primary_relationship = 'recurring_member'
    and not exists (
      select 1
      from public.segment_assignments sa
      where sa.tenant_id = p_tenant
        and sa.run_id = v_run_id
        and sa.person_id = p.id
        and sa.segment_key in ('payment_risk', 'at_risk', 'cooling')
    );

  update public.segment_runs sr
  set status = 'success', finished_at = now()
  where sr.id = v_run_id and sr.tenant_id = p_tenant;

  exception when others then
    update public.segment_runs sr
    set status = 'error', finished_at = now()
    where sr.id = v_run_id and sr.tenant_id = p_tenant;
    return null;
  end;

  return v_run_id;
end;
$$;

comment on function app.recompute_segments(uuid) is
  'SERVICE-ROLE ONLY. Computes rule-version 1 deterministic segment assignments in studio-local calendar days and returns the immutable run id.';

-- RLS-scoped current queue ----------------------------------------------------
create or replace function public.segment_current(p_tenant uuid)
returns table (
  segment_key text,
  person_id uuid,
  priority int,
  rule_version int,
  evidence jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest_run as (
    select sr.id
    from public.segment_runs sr
    where sr.tenant_id = p_tenant
      and sr.status = 'success'
    order by sr.finished_at desc, sr.created_at desc, sr.id desc
    limit 1
  ), ranked as (
    select
      sa.segment_key,
      sa.person_id,
      sd.priority,
      sa.rule_version,
      sa.evidence,
      row_number() over (
        partition by sa.person_id
        order by sd.priority, sa.segment_key
      ) as queue_rank
    from latest_run lr
    join public.segment_assignments sa on sa.run_id = lr.id and sa.tenant_id = p_tenant
    join public.segment_definitions sd
      on sd.key = sa.segment_key and sd.version = sa.rule_version
  )
  select r.segment_key, r.person_id, r.priority, r.rule_version, r.evidence
  from ranked r
  where r.queue_rank = 1
  order by r.priority, r.person_id;
$$;

comment on function public.segment_current(uuid) is
  'RLS-scoped latest successful segment snapshot, reduced to each person''s highest-priority queue slot.';

-- RLS ------------------------------------------------------------------------
alter table public.segment_definitions enable row level security;
alter table public.segment_runs enable row level security;
alter table public.segment_assignments enable row level security;

drop policy if exists segment_definitions_select on public.segment_definitions;
create policy segment_definitions_select on public.segment_definitions
  for select to authenticated
  using (true);

drop policy if exists segment_runs_select on public.segment_runs;
create policy segment_runs_select on public.segment_runs
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists segment_assignments_select on public.segment_assignments;
create policy segment_assignments_select on public.segment_assignments
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- grants ---------------------------------------------------------------------
revoke all on public.segment_definitions from anon;
revoke insert, update, delete on public.segment_definitions from authenticated;
grant select on public.segment_definitions to authenticated, service_role;

revoke all on public.segment_runs from anon;
revoke insert, update, delete on public.segment_runs from authenticated;
revoke delete on public.segment_runs from service_role;
grant select on public.segment_runs to authenticated, service_role;
grant insert, update on public.segment_runs to service_role;

revoke all on public.segment_assignments from anon;
revoke insert, update, delete on public.segment_assignments from authenticated;
grant select on public.segment_assignments to authenticated, service_role;
grant insert on public.segment_assignments to service_role;

-- HARD append-only audit: owner-executed definer code may INSERT, but no app
-- role, including service_role, may rewrite or delete an assignment snapshot.
revoke update, delete on public.segment_assignments
  from anon, authenticated, service_role;

-- Definer functions default to PUBLIC execute. The recompute is workers-only;
-- the invoker helper is available to authenticated users and the worker.
revoke all on function app.recompute_segments(uuid) from public;
grant execute on function app.recompute_segments(uuid) to service_role;

revoke all on function public.segment_current(uuid) from public;
grant execute on function public.segment_current(uuid) to authenticated, service_role;
