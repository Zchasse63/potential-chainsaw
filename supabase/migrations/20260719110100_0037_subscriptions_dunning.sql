-- Phase 5 · unit 5.6 — SUBSCRIPTIONS + THE DUNNING STATE MACHINE. Recurring
-- memberships and the append-only per-subscription dunning ledger that drives
-- the failed-payment recovery workflow. Builds on the billing core (0033):
-- customers, plans/plan_prices, payments, the stripe_events inbox, and the
-- jobs queue's comms.send path.
--
-- Money invariants enforced here (plan-final §5/§6, threat-model §6):
--   * The webhook/inbox is the confirmation authority: subscriptions.status is
--     synced by the service role (the inbox processor), never by an optimistic
--     client. Stripe Billing owns invoice RETRIES (Smart Retries); Kelo owns the
--     comms/workflow — the dunning STATE MACHINE below.
--   * dunning_states is an APPEND-ONLY ledger (invariant #6): UPDATE/DELETE are
--     revoked from EVERY role including service_role. Each stage transition is a
--     NEW row; history is never rewritten. The attack suite (block 29) re-asserts
--     it, and block 26 lists it in the append-only grant guard.
--   * A subscription is NEVER auto-cancelled — the 'cancelled' stage only mirrors
--     a Stripe-side cancellation delivered through the inbox.
--   * One live subscription per plan per customer (partial unique).

-- Recurring membership ---------------------------------------------------------
create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants (id) on delete cascade,
  customer_id            uuid not null,
  plan_id                uuid not null,
  -- A simple FK: plan_prices carries no (tenant_id, id) composite key (its rows
  -- are immutable phases, keyed by id). Tenant consistency of the plan itself is
  -- enforced by the composite FK below; the chosen price belongs to that plan.
  plan_price_id          uuid not null references public.plan_prices (id),
  stripe_subscription_id text,
  status                 text not null default 'incomplete'
                         check (status in ('incomplete', 'active', 'past_due', 'paused', 'cancelled')),
  current_period_end     timestamptz,
  grace_expires_at       timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- Composite FKs keep the customer/plan tenant-consistent (0033 style).
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id),
  foreign key (tenant_id, plan_id)
    references public.plans (tenant_id, id),
  -- Composite unique so dunning_states carries a tenant-consistent FK.
  unique (tenant_id, id)
);

-- One LIVE subscription per plan per customer. A cancelled subscription frees
-- the slot for a resubscribe; incomplete/active/past_due/paused all hold it.
create unique index subscriptions_one_live_idx
  on public.subscriptions (tenant_id, customer_id, plan_id)
  where status in ('incomplete', 'active', 'past_due', 'paused');

create unique index subscriptions_stripe_id_key
  on public.subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

create index subscriptions_tenant_status_idx
  on public.subscriptions (tenant_id, status);
create index subscriptions_customer_idx
  on public.subscriptions (tenant_id, customer_id);

create or replace trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function app.touch_updated_at();

comment on table public.subscriptions is
  'Recurring membership per (customer, plan). stripe_subscription_id is null until the Connect subscription is created. status is webhook-synced by the service role — NO optimistic client write (invariant #5). Partial unique subscriptions_one_live_idx enforces one live subscription per plan per customer. current_period_end/grace_expires_at drive the dunning state machine.';

-- APPEND-ONLY per-subscription dunning ledger ---------------------------------
-- Every stage transition is a NEW row; the CURRENT dunning stage is the latest
-- occurred_at/created_at/id row (mirrors communication_consents). No mutable
-- "state" column exists anywhere — the ledger IS the state.
create table public.dunning_states (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  subscription_id uuid not null,
  stage           text not null
                  check (stage in (
                    'grace_started', 'reminder_sent', 'final_notice',
                    'past_due', 'recovered', 'cancelled'
                  )),
  payment_id      uuid references public.payments (id),
  occurred_at     timestamptz not null default now(),
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, subscription_id)
    references public.subscriptions (tenant_id, id) on delete cascade
);

create index dunning_states_current_idx
  on public.dunning_states
  (tenant_id, subscription_id, occurred_at desc, created_at desc, id desc);

comment on table public.dunning_states is
  'APPEND-ONLY per-subscription dunning ledger (invariant #6). Each stage transition (grace_started→reminder_sent→final_notice→past_due, plus recovered/cancelled) is a NEW row; the current stage is the latest row. UPDATE/DELETE are revoked from every role including service_role. The state machine advances it via app.record_dunning_stage (definer); nothing rewrites history.';

-- The SOLE writer of dunning transitions + subscription lifecycle side-effects.
-- SECURITY DEFINER: it appends the ledger row, applies the matching subscription
-- mutation (grace window / past_due / recovered / cancelled), and enqueues the
-- dunning comms for the comms-bearing stages — all in one place so the inbox
-- (event-driven) and the billing.dunning processor (time-driven) share it. It is
-- IDEMPOTENT: a re-call whose target stage already equals the subscription's
-- latest stage is a no-op (no duplicate row, no duplicate comms). The caller
-- (which reads the latest stage and decides the next transition) is the primary
-- guard; this backstop closes the same-stage re-run window.
create or replace function app.record_dunning_stage(
  p_tenant           uuid,
  p_subscription     uuid,
  p_stage            text,
  p_payment          uuid default null,
  p_now              timestamptz default now(),
  p_grace_expires_at timestamptz default null,
  p_detail           jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_latest    text;
  v_tpl_key   text;
  v_channel   text;
  v_subject   text;
  v_body      text;
  v_person    uuid;
  v_first     text;
  v_address   text;
  v_studio    text;
  v_log_id    uuid;
begin
  -- Idempotency backstop: never append the SAME stage twice in a row.
  select ds.stage into v_latest
  from public.dunning_states ds
  where ds.tenant_id = p_tenant
    and ds.subscription_id = p_subscription
  order by ds.occurred_at desc, ds.created_at desc, ds.id desc
  limit 1;

  if v_latest is not distinct from p_stage then
    return;
  end if;

  insert into public.dunning_states
    (tenant_id, subscription_id, stage, payment_id, occurred_at, detail)
  values
    (p_tenant, p_subscription, p_stage, p_payment,
     coalesce(p_now, now()), coalesce(p_detail, '{}'::jsonb));

  -- Subscription lifecycle side-effects. past_due/recovered never override a
  -- Stripe-side cancellation (monotonic terminal 'cancelled').
  if p_stage = 'grace_started' then
    update public.subscriptions s
    set grace_expires_at = p_grace_expires_at
    where s.id = p_subscription and s.tenant_id = p_tenant;
  elsif p_stage = 'past_due' then
    update public.subscriptions s
    set status = 'past_due'
    where s.id = p_subscription and s.tenant_id = p_tenant and s.status <> 'cancelled';
  elsif p_stage = 'recovered' then
    update public.subscriptions s
    set status = 'active', grace_expires_at = null
    where s.id = p_subscription and s.tenant_id = p_tenant and s.status <> 'cancelled';
  elsif p_stage = 'cancelled' then
    update public.subscriptions s
    set status = 'cancelled', grace_expires_at = null
    where s.id = p_subscription and s.tenant_id = p_tenant;
  end if;

  -- Dunning comms for the two member-facing nudges. Kind 'transactional_quiet'
  -- is inferred downstream by comms.send from the 'dunning_' template_key prefix
  -- (consent-exempt but quiet-hours-blocked). Merge fields resolved here, from
  -- the tenant-or-global 'dunning_reminder' template. Skipped when the person
  -- has no deliverable address (comms_log.to_address is NOT NULL).
  if p_stage in ('grace_started', 'reminder_sent') then
    select mt.key, mt.channel, mt.subject, mt.body
    into v_tpl_key, v_channel, v_subject, v_body
    from public.message_templates mt
    where (mt.tenant_id is null or mt.tenant_id = p_tenant)
      and mt.key = 'dunning_reminder'
    order by (mt.tenant_id is not null) desc, mt.version desc
    limit 1;

    if v_tpl_key is not null then
      select p.id, p.first_name,
             case when v_channel = 'email' then p.email::text else p.phone_e164 end,
             t.name
      into v_person, v_first, v_address, v_studio
      from public.subscriptions s
      join public.customers cu on cu.id = s.customer_id and cu.tenant_id = s.tenant_id
      join public.people p on p.id = cu.person_id and p.tenant_id = s.tenant_id
      join public.tenants t on t.id = s.tenant_id
      where s.id = p_subscription and s.tenant_id = p_tenant;

      if v_address is not null and v_address <> '' then
        v_subject := replace(replace(
          coalesce(v_subject, ''),
          '{{first_name}}', coalesce(nullif(v_first, ''), 'there')
        ), '{{studio_name}}', coalesce(v_studio, 'the studio'));
        v_body := replace(replace(
          v_body,
          '{{first_name}}', coalesce(nullif(v_first, ''), 'there')
        ), '{{studio_name}}', coalesce(v_studio, 'the studio'));

        insert into public.comms_log
          (tenant_id, person_id, channel, direction, template_key,
           subject, body_preview, to_address, status)
        values
          (p_tenant, v_person, v_channel, 'outbound', v_tpl_key,
           nullif(v_subject, ''), left(v_body, 200), v_address, 'queued')
        returning id into v_log_id;

        perform app.enqueue_job(
          'comms.send', jsonb_build_object('comms_log_id', v_log_id),
          p_tenant, now(), 100, 5, 'comms.send:' || v_log_id::text
        );
      end if;
    end if;
  end if;
end;
$$;

comment on function app.record_dunning_stage(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb) is
  'The ONLY writer of a dunning transition. Appends the ledger row, applies the matching subscription side-effect (grace window / past_due / recovered→active / cancelled), and enqueues the dunning comms for grace_started/reminder_sent. Idempotent: a re-call at the current latest stage is a no-op. Definer-owned; the worker (service role) is the sole caller.';

-- The dunning QUEUE read (owner/manager surface, unit 5.8): subscriptions in an
-- open dunning cycle (grace/past_due) with their current stage + the member name.
-- SECURITY INVOKER so subscriptions RLS scopes it to the caller's tenant.
create or replace function public.dunning_queue(p_tenant uuid)
returns table (
  subscription_id    uuid,
  customer_id        uuid,
  person_id          uuid,
  person_name        text,
  plan_id            uuid,
  status             text,
  stage              text,
  grace_expires_at   timestamptz,
  current_period_end timestamptz,
  occurred_at        timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    s.id,
    s.customer_id,
    p.id,
    nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
    s.plan_id,
    s.status,
    latest.stage,
    s.grace_expires_at,
    s.current_period_end,
    latest.occurred_at
  from public.subscriptions s
  join public.customers cu on cu.id = s.customer_id and cu.tenant_id = s.tenant_id
  join public.people p on p.id = cu.person_id and p.tenant_id = s.tenant_id
  cross join lateral (
    select ds.stage, ds.occurred_at
    from public.dunning_states ds
    where ds.tenant_id = s.tenant_id
      and ds.subscription_id = s.id
    order by ds.occurred_at desc, ds.created_at desc, ds.id desc
    limit 1
  ) latest
  where s.tenant_id = p_tenant
    and latest.stage in ('grace_started', 'reminder_sent', 'final_notice', 'past_due')
  order by s.grace_expires_at asc nulls last, latest.occurred_at desc;
$$;

comment on function public.dunning_queue(uuid) is
  'Owner/manager dunning queue: subscriptions whose latest dunning stage is still open (grace_started/reminder_sent/final_notice/past_due), with the current stage and the member name. SECURITY INVOKER — subscriptions RLS scopes rows to the caller''s tenant.';

-- The global dunning_reminder template (transactional_quiet). Only {{first_name}}
-- and {{studio_name}} are valid merge fields (message_templates check).
insert into public.message_templates
  (id, tenant_id, key, version, channel, kind, subject, body, segment_key)
values
  ('37000000-0000-4000-8000-000000000001', null, 'dunning_reminder', 1,
   'email', 'transactional_quiet', 'A payment issue on your {{studio_name}} membership',
   'Hi {{first_name}}, we were not able to process the latest payment for your {{studio_name}} membership. Please update your payment details so your membership continues without interruption.',
   null);

-- RLS -------------------------------------------------------------------------
alter table public.subscriptions enable row level security;
alter table public.dunning_states enable row level security;

create policy subscriptions_select on public.subscriptions for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy dunning_states_select on public.dunning_states for select
  using (tenant_id in (select app.current_tenant_ids()));

-- Exact grants ----------------------------------------------------------------
revoke all on public.subscriptions, public.dunning_states
  from anon, authenticated, service_role;

-- Subscriptions: member-read; the service role writes (creation + webhook sync).
grant select on public.subscriptions to authenticated, service_role;
grant insert, update on public.subscriptions to service_role;

-- Dunning ledger: member-read; the service role INSERTS transitions. UPDATE and
-- DELETE are revoked from EVERY role (append-only) — the ledger never mutates.
grant select on public.dunning_states to authenticated, service_role;
grant insert on public.dunning_states to service_role;
revoke update, delete on public.dunning_states from anon, authenticated, service_role;

-- record_dunning_stage mutates money/subscription state — service role only,
-- never an interactive client.
revoke all on function app.record_dunning_stage(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb)
  from public;
grant execute on function app.record_dunning_stage(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb)
  to service_role;

revoke all on function public.dunning_queue(uuid) from public;
grant execute on function public.dunning_queue(uuid) to authenticated, service_role;
