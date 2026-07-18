-- Phase 1 · unit 8 — relationship typing: the load-bearing derivation behind
-- the studio's member count. Both layers are DERIVED, never hand-entered:
-- effective-dated concurrent facts live in person_relationships, while the
-- single KPI cohort lives in people.primary_relationship. The append-only log
-- records primary transitions (especially pack_holder -> recurring_member).
--
-- Phase-1 evidence is deliberately proxy evidence. Native subscription state
-- replaces the recent-payment proxy in phase 5; the channel-marker scan may
-- refine aggregator evidence later. RULE_VERSION starts at 1 so every fact and
-- transition remains attributable when those rules change.

-- effective-dated relationship facts -----------------------------------------
create table if not exists public.person_relationships (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  person_id         uuid not null references public.people (id) on delete cascade,
  relationship_type text not null
                    check (relationship_type in (
                      'recurring_member', 'pack_holder', 'aggregator', 'guest', 'lead'
                    )),
  valid_from        timestamptz not null default now(),
  valid_to          timestamptz,
  derivation_basis  jsonb not null default '{}'::jsonb,
  rule_version      int not null,
  created_at        timestamptz not null default now()
);

-- Concurrency ACROSS types is intentional (a member may also hold a pack),
-- but a person can have only one CURRENT period for any one type.
create unique index if not exists person_relationships_open_key
  on public.person_relationships (tenant_id, person_id, relationship_type)
  where valid_to is null;
create index if not exists person_relationships_tenant_person_idx
  on public.person_relationships (tenant_id, person_id);
create index if not exists person_relationships_tenant_type_open_idx
  on public.person_relationships (tenant_id, relationship_type)
  where valid_to is null;

-- the one KPI relationship ----------------------------------------------------
alter table public.people
  add column if not exists primary_relationship text
  check (primary_relationship in (
    'recurring_member', 'pack_holder', 'aggregator', 'guest', 'lead'
  ));

comment on column public.people.primary_relationship is
  'DERIVED ONLY by app.recompute_person_relationship(). The sole cohort field for member count and MRR; recurring_member is the only member cohort.';

-- append-only primary transition log -----------------------------------------
create table if not exists public.person_relationship_log (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  person_id    uuid not null references public.people (id) on delete cascade,
  from_primary text,
  to_primary   text not null,
  basis        jsonb not null default '{}'::jsonb,
  rule_version int not null,
  changed_at   timestamptz not null default now()
);
create index if not exists person_relationship_log_tenant_changed_idx
  on public.person_relationship_log (tenant_id, changed_at desc);
create index if not exists person_relationship_log_tenant_to_changed_idx
  on public.person_relationship_log (tenant_id, to_primary, changed_at desc);

-- one deterministic derivation ------------------------------------------------
-- SERVICE-ROLE BATCH FUNCTION: unlike user-facing definer RPCs, this function
-- intentionally does not re-verify JWT tenancy in-body. EXECUTE is granted
-- only to service_role below, and the tenant/person pair is still validated by
-- locking the matching people row. The row lock also serializes concurrent
-- recomputes for one person, protecting the one-open-period invariant.
create or replace function app.recompute_person_relationship(
  p_tenant uuid,
  p_person uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule_version constant int := 1;
  v_now timestamptz := now();
  v_grace_days int;
  v_person_external_ref text;
  v_external_refs text[];
  v_old_primary text;
  v_primary text;
  v_primary_basis jsonb;

  v_subscription_id uuid;
  v_subscription_external_ref text;
  v_subscription_created_at timestamptz;
  v_recurring boolean := false;
  v_recurring_basis jsonb := '{}'::jsonb;

  v_credit_balance int := 0;
  v_next_expiry timestamptz;
  v_pack boolean := false;
  v_pack_basis jsonb := '{}'::jsonb;

  v_booking_id uuid;
  v_booking_external_ref text;
  v_booking_origin text;
  v_booking_evidence_at timestamptz;
  v_has_booking boolean := false;
  v_aggregator boolean := false;
  v_aggregator_basis jsonb := '{}'::jsonb;

  v_transaction_id uuid;
  v_transaction_external_ref text;
  v_transaction_created_at timestamptz;
  v_has_transaction boolean := false;
  v_has_activity boolean := false;
  v_base_basis jsonb := '{}'::jsonb;

  v_holding_types text[] := array[]::text[];
  v_relationship_type text;
  v_relationship_basis jsonb;
begin
  -- Validate the tenant/person pair and serialize all state transitions for it.
  select p.external_ref, p.primary_relationship
  into v_person_external_ref, v_old_primary
  from public.people p
  where p.tenant_id = p_tenant
    and p.id = p_person
  for update;

  if not found then
    raise exception 'person % does not belong to tenant %', p_person, p_tenant;
  end if;

  select coalesce(nullif(t.settings ->> 'grace_days', '')::int, 14)
  into v_grace_days
  from public.tenants t
  where t.id = p_tenant;

  -- Imported facts key people by Glofox external ref. Include the identity
  -- registry so a merged/re-keyed person retains all of its imported evidence.
  select coalesce(array_agg(refs.external_ref order by refs.external_ref), array[]::text[])
  into v_external_refs
  from (
    select v_person_external_ref as external_ref
    union
    select per.external_ref
    from public.person_external_refs per
    where per.tenant_id = p_tenant
      and per.person_id = p_person
      and per.system = 'glofox'
  ) refs
  where refs.external_ref is not null;

  -- PHASE-1 PROXY for native subscription state (phase 5): a monthly billing
  -- period is assumed to be 30 days, plus the tenant's dunning grace (14 days
  -- by default), hence a 44-day default evidence window.
  select gt.id, gt.external_ref, gt.transaction_created_at
  into v_subscription_id, v_subscription_external_ref, v_subscription_created_at
  from public.glofox_transactions gt
  where gt.tenant_id = p_tenant
    and gt.person_external_ref = any (v_external_refs)
    and gt.glofox_event_class = 'subscription_payment'
    and gt.transaction_created_at >= v_now - make_interval(days => 30 + v_grace_days)
  order by gt.transaction_created_at desc, gt.id desc
  limit 1;
  v_recurring := found;

  if v_recurring then
    v_recurring_basis := jsonb_build_object(
      'phase_1_proxy', 'recent subscription_payment transaction',
      'transaction_id', v_subscription_id,
      'transaction_external_ref', v_subscription_external_ref,
      'transaction_created_at', v_subscription_created_at,
      'billing_period_days', 30,
      'grace_days', v_grace_days,
      'window_days', 30 + v_grace_days
    );
  end if;

  -- Positive UNEXPIRED credit balance, never a recent-purchase heuristic. The
  -- phase-1 app.credit_balances read model owns the expiry approximation.
  select pcb.balance, pcb.next_expiry
  into v_credit_balance, v_next_expiry
  from app.person_credit_balance(p_tenant, p_person) pcb;

  -- Direct worker pool connections bypass RLS but do not necessarily carry a
  -- PostgREST request.jwt.claim.role, so the helper's in-body service-role
  -- check can intentionally return zero rows. This SERVICE-ROLE-ONLY outer
  -- definer may then read the same protected matview directly; clients cannot
  -- execute this function or access the matview.
  if not found then
    select cb.balance, cb.next_expiry
    into v_credit_balance, v_next_expiry
    from app.credit_balances cb
    where cb.tenant_id = p_tenant
      and cb.person_id = p_person;
  end if;

  v_credit_balance := coalesce(v_credit_balance, 0);
  v_pack := v_credit_balance > 0;

  if v_pack then
    v_pack_basis := jsonb_strip_nulls(jsonb_build_object(
      'phase_1_proxy', 'positive unexpired credit balance read model',
      'balance', v_credit_balance,
      'next_expiry', v_next_expiry
    ));
  end if;

  -- PHASE-1 PROXY: bookings.origin is null in all pinned samples. Inspect the
  -- person's most-recent booking (not merely the most-recent matching booking)
  -- and light up only when a known aggregator marker appears.
  select gb.id, gb.external_ref, gb.origin, coalesce(gb.time_start, gb.created_at)
  into v_booking_id, v_booking_external_ref, v_booking_origin, v_booking_evidence_at
  from public.glofox_bookings gb
  where gb.tenant_id = p_tenant
    and gb.person_external_ref = any (v_external_refs)
  order by coalesce(gb.time_start, gb.created_at) desc, gb.id desc
  limit 1;
  v_has_booking := found;
  v_aggregator := v_has_booking
    and v_booking_origin is not null
    and v_booking_origin ilike any (array['%classpass%', '%gympass%', '%mindbody%']::text[]);

  if v_aggregator then
    v_aggregator_basis := jsonb_build_object(
      'phase_1_proxy', 'most-recent booking origin marker',
      'booking_id', v_booking_id,
      'booking_external_ref', v_booking_external_ref,
      'booking_at', v_booking_evidence_at,
      'origin', v_booking_origin
    );
  end if;

  -- Any imported transaction is activity evidence. The booking query above
  -- already establishes whether any booking exists for the person.
  select gt.id, gt.external_ref, gt.transaction_created_at
  into v_transaction_id, v_transaction_external_ref, v_transaction_created_at
  from public.glofox_transactions gt
  where gt.tenant_id = p_tenant
    and gt.person_external_ref = any (v_external_refs)
  order by coalesce(gt.transaction_created_at, gt.created_at) desc, gt.id desc
  limit 1;
  v_has_transaction := found;
  v_has_activity := v_has_transaction or v_has_booking;

  v_base_basis := jsonb_strip_nulls(jsonb_build_object(
    'phase_1_proxy', case
      when v_has_activity then 'any Glofox transaction or booking'
      else 'no Glofox transaction or booking'
    end,
    'transaction_id', v_transaction_id,
    'transaction_external_ref', v_transaction_external_ref,
    'transaction_created_at', v_transaction_created_at,
    'booking_id', v_booking_id,
    'booking_external_ref', v_booking_external_ref,
    'booking_at', v_booking_evidence_at
  ));

  -- Concurrent facts are recorded independently. guest/lead are FALLBACK base
  -- facts only: guest means activity with no member/pack/aggregator evidence;
  -- lead means no activity and no stronger evidence. Thus a recurring member
  -- is not also stored as guest even though their payment is activity.
  if v_recurring then
    v_holding_types := array_append(v_holding_types, 'recurring_member');
  end if;
  if v_pack then
    v_holding_types := array_append(v_holding_types, 'pack_holder');
  end if;
  if v_aggregator then
    v_holding_types := array_append(v_holding_types, 'aggregator');
  end if;

  if cardinality(v_holding_types) = 0 then
    if v_has_activity then
      v_holding_types := array_append(v_holding_types, 'guest');
    else
      v_holding_types := array_append(v_holding_types, 'lead');
    end if;
  end if;

  -- Close only facts that stopped holding. Re-runs with the same evidence set
  -- update zero rows, preserving effective periods exactly.
  update public.person_relationships pr
  set valid_to = v_now
  where pr.tenant_id = p_tenant
    and pr.person_id = p_person
    and pr.valid_to is null
    and not (pr.relationship_type = any (v_holding_types));

  -- Open only newly-held facts. The people row lock serializes this check with
  -- other recomputes; the partial unique index is the structural backstop.
  foreach v_relationship_type in array v_holding_types
  loop
    v_relationship_basis := case v_relationship_type
      when 'recurring_member' then v_recurring_basis
      when 'pack_holder' then v_pack_basis
      when 'aggregator' then v_aggregator_basis
      else v_base_basis
    end;

    insert into public.person_relationships (
      tenant_id,
      person_id,
      relationship_type,
      valid_from,
      derivation_basis,
      rule_version
    )
    select
      p_tenant,
      p_person,
      v_relationship_type,
      v_now,
      v_relationship_basis,
      v_rule_version
    where not exists (
      select 1
      from public.person_relationships open_pr
      where open_pr.tenant_id = p_tenant
        and open_pr.person_id = p_person
        and open_pr.relationship_type = v_relationship_type
        and open_pr.valid_to is null
    );
  end loop;

  -- The one KPI materialization. This exact precedence is load-bearing:
  -- recurring_member is the ONLY cohort read by member count and MRR.
  if v_recurring then
    v_primary := 'recurring_member';
    v_primary_basis := v_recurring_basis;
  elsif v_pack then
    v_primary := 'pack_holder';
    v_primary_basis := v_pack_basis;
  elsif v_aggregator then
    v_primary := 'aggregator';
    v_primary_basis := v_aggregator_basis;
  elsif v_has_activity then
    v_primary := 'guest';
    v_primary_basis := v_base_basis;
  else
    v_primary := 'lead';
    v_primary_basis := v_base_basis;
  end if;

  v_primary_basis := v_primary_basis || jsonb_build_object(
    'primary_relationship', v_primary,
    'precedence', array['recurring_member', 'pack_holder', 'aggregator', 'guest', 'lead']
  );

  -- Log PRIMARY transitions only. IS DISTINCT FROM handles the initial NULL;
  -- an unchanged re-run neither updates people nor appends a log row.
  if v_old_primary is distinct from v_primary then
    update public.people p
    set primary_relationship = v_primary
    where p.tenant_id = p_tenant
      and p.id = p_person;

    insert into public.person_relationship_log (
      tenant_id,
      person_id,
      from_primary,
      to_primary,
      basis,
      rule_version,
      changed_at
    ) values (
      p_tenant,
      p_person,
      v_old_primary,
      v_primary,
      v_primary_basis,
      v_rule_version,
      v_now
    );
  end if;

  return v_primary;
end;
$$;

comment on function app.recompute_person_relationship(uuid, uuid) is
  'SERVICE-ROLE ONLY. Atomically derives effective-dated relationship facts and the one KPI primary relationship using rule version 1 phase-1 proxies.';

-- Tenant batch entrypoint. At the phase-1 population (~1,366 people), the
-- per-person loop favors auditability and identical semantics over cleverness.
create or replace function app.recompute_all_relationships(p_tenant uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person record;
  v_processed int := 0;
begin
  for v_person in
    select p.id
    from public.people p
    where p.tenant_id = p_tenant
    order by p.id
  loop
    perform app.recompute_person_relationship(p_tenant, v_person.id);
    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end;
$$;

comment on function app.recompute_all_relationships(uuid) is
  'SERVICE-ROLE ONLY. Recomputes every person in one tenant and returns the count processed.';

-- SECURITY DEFINER functions default to PUBLIC execute: strip that first.
revoke all on function app.recompute_person_relationship(uuid, uuid) from public;
revoke all on function app.recompute_all_relationships(uuid) from public;
grant execute on function app.recompute_person_relationship(uuid, uuid) to service_role;
grant execute on function app.recompute_all_relationships(uuid) to service_role;

-- RLS -------------------------------------------------------------------------
-- Member-SELECT everywhere (invariant #7); all writes happen under the
-- service-role-only definer functions above.
alter table public.person_relationships enable row level security;
alter table public.person_relationship_log enable row level security;

drop policy if exists person_relationships_select on public.person_relationships;
create policy person_relationships_select on public.person_relationships
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists person_relationship_log_select on public.person_relationship_log;
create policy person_relationship_log_select on public.person_relationship_log
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- grants ----------------------------------------------------------------------
-- Hosted Supabase default privileges are broader than this surface: revoke
-- first, then grant back member-SELECT exactly (0008 pattern).
revoke all on public.person_relationships from anon;
revoke insert, update, delete on public.person_relationships from authenticated;
grant select on public.person_relationships to authenticated;

revoke all on public.person_relationship_log from anon;
revoke insert, update, delete on public.person_relationship_log from authenticated;
grant select on public.person_relationship_log to authenticated;

-- HARD append-only transition evidence: even service_role cannot mutate or
-- delete log rows. The owner-executed definer function may only INSERT them.
revoke update, delete on public.person_relationship_log
  from anon, authenticated, service_role;
