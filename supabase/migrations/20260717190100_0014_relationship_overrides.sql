-- Phase 1 · unit 10 — audited owner adjudication for recurring members whose
-- partner-billed membership cannot be expressed by Glofox's API, plus rule v3.

-- owner-adjudication register -------------------------------------------------
-- The external ref is the durable identity key: people rows may be re-keyed by
-- a full import, while this evidence must survive and remain independently
-- reviewable. Overrides are deliberately narrow: v1 may only ADD member status.
create table if not exists public.relationship_overrides (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete cascade,
  person_external_ref   text not null,
  forced_relationship   text not null
                        check (forced_relationship in ('recurring_member')),
  reason                text not null check (length(reason) >= 10),
  source                text not null default 'owner_adjudication',
  approved_by           text not null,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists relationship_overrides_tenant_ref_active_key
  on public.relationship_overrides (tenant_id, person_external_ref)
  where active;

create or replace trigger relationship_overrides_touch_updated_at
  before update on public.relationship_overrides
  for each row execute function app.touch_updated_at();

comment on table public.relationship_overrides is
  'Audited tenant-scoped owner adjudications for API-inexpressible partner-billed members: the gold-label data lesson. The deterministic derivation exposes every applied override and its reason in derivation_basis; overrides are never silent.';

-- one deterministic derivation, rule v3 --------------------------------------
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
  v_rule_version constant int := 3;
  v_now timestamptz := now();
  v_grace_days int;
  v_person_external_ref text;
  v_membership_type text;
  v_membership_status text;
  v_user_membership_id text;
  v_external_refs text[];
  v_old_primary text;
  v_primary text;
  v_primary_basis jsonb;

  v_subscription_id uuid;
  v_subscription_external_ref text;
  v_subscription_created_at timestamptz;
  v_recurring boolean := false;
  v_recurring_basis jsonb := '{}'::jsonb;
  v_override_id uuid;
  v_override_reason text;

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
  select
    p.external_ref,
    p.membership_type,
    p.membership_status,
    p.user_membership_id,
    p.primary_relationship
  into
    v_person_external_ref,
    v_membership_type,
    v_membership_status,
    v_user_membership_id,
    v_old_primary
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

  -- A recent subscription payment is retained as corroborating evidence only.
  -- Payment recency misses longer-cycle billers and comps; Glofox's membership
  -- record is its authoritative member state.
  select gt.id, gt.external_ref, gt.transaction_created_at
  into v_subscription_id, v_subscription_external_ref, v_subscription_created_at
  from public.glofox_transactions gt
  where gt.tenant_id = p_tenant
    and gt.person_external_ref = any (v_external_refs)
    and gt.glofox_event_class = 'subscription_payment'
    and gt.transaction_created_at >= v_now - make_interval(days => 30 + v_grace_days)
  order by gt.transaction_created_at desc, gt.id desc
  limit 1;

  -- Current Members = ACTIVE/PAUSED on a recurring plan. Native time types
  -- cover ordinary memberships; the owner's A8 catalog mapping recovers the
  -- two NOEQL comps whose Glofox membership type reads as payg.
  v_recurring := v_membership_status in ('ACTIVE', 'PAUSED')
    and (
      v_membership_type in ('time', 'time_classes')
      or exists (
        select 1
        from public.plan_catalog pc
        where pc.tenant_id = p_tenant
          and pc.external_ref = v_user_membership_id
          and pc.kelo_type in ('recurring', 'unlimited', 'intro')
      )
    );

  if v_recurring then
    v_recurring_basis := jsonb_build_object(
      'membership_status', v_membership_status,
      'membership_type', v_membership_type,
      'user_membership_id', v_user_membership_id,
      'corroborating_subscription_payment', v_subscription_id,
      'corroborating_subscription_payment_external_ref', v_subscription_external_ref,
      'corroborating_subscription_payment_created_at', v_subscription_created_at,
      'phase_1_rule', 'membership-status-based v2'
    );
  end if;

  -- Gold-label data lesson: Glofox cannot express partner-billed recurring
  -- members. Consult audited adjudication only after the source signal fails,
  -- and expose the applied override in derivation_basis — never silently.
  if not v_recurring then
    select ro.id, ro.reason into v_override_id, v_override_reason
    from public.relationship_overrides ro
    where ro.tenant_id = p_tenant and ro.active
      and ro.forced_relationship = 'recurring_member'
      and ro.person_external_ref = any (v_external_refs);
    if found then
      v_recurring := true;
      v_recurring_basis := jsonb_build_object(
        'override_id', v_override_id,
        'override_reason', v_override_reason,
        'membership_status', v_membership_status,
        'membership_type', v_membership_type,
        'phase_1_rule', 'owner-adjudication override v3'
      );
    end if;
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
  'SERVICE-ROLE ONLY. Atomically derives effective-dated relationship facts and the one KPI primary relationship using rule version 3 membership evidence plus visible audited adjudication. The catalog-join arm is retained but dormant because Glofox user_membership_id is an instance id, not a catalog item id; a future API fix can light it up.';

-- RLS + grants ----------------------------------------------------------------
-- Members may review adjudications; clients may never create, mutate, or
-- delete them. The director/service role owns writes in v1.
alter table public.relationship_overrides enable row level security;

drop policy if exists relationship_overrides_select on public.relationship_overrides;
create policy relationship_overrides_select on public.relationship_overrides
  for select
  using (tenant_id in (select app.current_tenant_ids()));

revoke all on public.relationship_overrides from anon;
revoke insert, update, delete on public.relationship_overrides from authenticated;
grant select on public.relationship_overrides to authenticated;
