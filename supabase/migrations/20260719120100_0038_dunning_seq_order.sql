-- 0038 — deterministic dunning-ledger ordering (attack-suite catch).
--
-- Block (29) proved app.record_dunning_stage can append a DUPLICATE stage: the
-- latest-stage read ordered by (occurred_at desc, created_at desc, id desc),
-- but occurred_at/created_at TIE for any same-instant sequence (a single
-- transaction's now() is frozen; production same-second interleavings tie too)
-- and the id tiebreaker is a RANDOM uuid — "latest" was nondeterministic and
-- the same-stage idempotency guard could read a stale row. The fix: a
-- monotonic identity column as THE ordering key. (dunning_states is empty in
-- production — no backfill concern.) The function below is 0037's body
-- VERBATIM with only the ORDER BY changed.
alter table public.dunning_states
  add column if not exists seq bigint generated always as identity;

create index if not exists dunning_states_sub_seq_idx
  on public.dunning_states (tenant_id, subscription_id, seq desc);

comment on column public.dunning_states.seq is
  'Monotonic insertion order — THE ordering key for latest-stage reads. occurred_at is the business timestamp (ties within a second/transaction); seq cannot tie.';

create or replace function app.record_dunning_stage(
  p_tenant           uuid,
  p_subscription     uuid,
  p_stage            text,
  p_payment          uuid default null,
  p_now              timestamptz default now(),
  p_grace_expires_at timestamptz default null,
  p_detail           jsonb default '{}'::jsonb,
  -- QUIET-HOURS-AWARE SEND TIME (F5): the run_at for the dunning comms.send job.
  -- Computed studio-local by the worker (dunning.ts) so a quiet-hours-blocked
  -- reminder is DELIVERED LATER instead of being terminally skipped and lost.
  -- Defaults to now() (immediate) for non-comms callers / backward compatibility.
  p_run_at           timestamptz default now()
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
  order by ds.seq desc  -- deterministic insertion order (0038)
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

        -- run_at is the quiet-hours-aware send time (F5): a reminder computed at
        -- 02:00 studio-local defers to 09:00 the same day rather than being
        -- enqueued at now() and terminally skipped as quiet_hours by the send
        -- processor. The at-send-time policy re-check stays authoritative.
        perform app.enqueue_job(
          'comms.send', jsonb_build_object('comms_log_id', v_log_id),
          p_tenant, coalesce(p_run_at, now()), 100, 5, 'comms.send:' || v_log_id::text
        );
      end if;
    end if;
  end if;
end;
$$;
