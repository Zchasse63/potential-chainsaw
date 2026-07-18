-- Phase 3 · unit 2 — outreach drafts, the ApprovalCeremony, lifecycle
-- proposals, and windowed attribution.
--
-- Merge-field allowlist (resolved server-side, never by the drafting model):
--   {{first_name}}  — people.first_name, falling back to "there"
--   {{studio_name}} — tenants.name
-- No other merge field is accepted by the approval RPC. The AI drafting
-- input is de-identified; recipient identity enters only during preview/send.

-- Template registry ----------------------------------------------------------
create table if not exists public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants (id) on delete cascade,
  key         text not null,
  version     int not null check (version > 0),
  channel     text not null check (channel in ('email', 'sms')),
  kind        text not null
              check (kind in ('marketing', 'transactional', 'transactional_quiet')),
  subject     text,
  body        text not null,
  segment_key text,
  created_at  timestamptz not null default now(),
  check (channel = 'email' or subject is null),
  check (
    replace(replace(body, '{{first_name}}', ''), '{{studio_name}}', '') !~ '\{\{[^}]+\}\}'
    and replace(replace(coalesce(subject, ''), '{{first_name}}', ''), '{{studio_name}}', '') !~ '\{\{[^}]+\}\}'
  )
);

create unique index if not exists message_templates_tenant_key_version_key
  on public.message_templates
  (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key, version);
create index if not exists message_templates_segment_idx
  on public.message_templates (segment_key, channel, version desc)
  where segment_key is not null;

comment on table public.message_templates is
  'Versioned global/tenant message registry. Only {{first_name}} and {{studio_name}} are valid merge fields; approval resolves them server-side.';

insert into public.message_templates
  (id, tenant_id, key, version, channel, kind, subject, body, segment_key)
values
  ('24000000-0000-4000-8000-000000000001', null, 'at_risk_winback_email', 1,
   'email', 'marketing', 'A note from {{studio_name}}',
   'Hi {{first_name}}, we have missed seeing you at {{studio_name}}. If returning feels right, we would be glad to help you find a comfortable next visit.',
   'at_risk'),
  ('24000000-0000-4000-8000-000000000002', null, 'at_risk_winback_sms', 1,
   'sms', 'marketing', null,
   'Hi {{first_name}}, we have missed you at {{studio_name}}. Reply if you would like help planning your next visit. Reply STOP to opt out.',
   'at_risk'),
  ('24000000-0000-4000-8000-000000000003', null, 'credits_expiring_nudge', 1,
   'email', 'marketing', 'A reminder about your {{studio_name}} credits',
   'Hi {{first_name}}, a quick reminder from {{studio_name}}: you have credits nearing expiry. We would be happy to help you find a time to use them.',
   'credits_expiring'),
  ('24000000-0000-4000-8000-000000000004', null, 'hooked_conversion_offer', 1,
   'email', 'marketing', 'Keep your rhythm at {{studio_name}}',
   'Hi {{first_name}}, you have built a great rhythm with {{studio_name}}. If a membership would make visits easier, reply and we will share the straightforward options.',
   'hooked'),
  ('24000000-0000-4000-8000-000000000005', null, 'new_welcome', 1,
   'email', 'marketing', 'Welcome to {{studio_name}}',
   'Hi {{first_name}}, welcome to {{studio_name}}. We are glad you are here. Reply anytime if you would like help choosing your next visit.',
   'new')
on conflict do nothing;

-- Campaign batch + immutable recipient plan ---------------------------------
create table if not exists public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  name          text not null,
  segment_key   text not null,
  template_key  text not null,
  channel       text not null check (channel in ('email', 'sms')),
  kind          text not null
                check (kind in ('marketing', 'transactional', 'transactional_quiet')),
  -- Exact content snapshot reviewed by the ApprovalCeremony. Seeded template
  -- copy is the floor; optional de-identified AI drafting may refine it.
  draft_subject text,
  draft_body    text not null,
  draft_source  text not null default 'template'
                check (draft_source in ('template', 'ai')),
  status        text not null default 'draft'
                check (status in (
                  'draft', 'pending_approval', 'approved', 'sending', 'sent', 'cancelled'
                )),
  created_by    uuid references auth.users (id) on delete set null,
  approved_by   uuid references auth.users (id) on delete set null,
  approved_at   timestamptz,
  scheduled_for timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (channel = 'email' or draft_subject is null),
  check (
    replace(replace(draft_body, '{{first_name}}', ''), '{{studio_name}}', '') !~ '\{\{[^}]+\}\}'
    and replace(replace(coalesce(draft_subject, ''), '{{first_name}}', ''), '{{studio_name}}', '') !~ '\{\{[^}]+\}\}'
  )
);

create index if not exists campaigns_tenant_status_created_idx
  on public.campaigns (tenant_id, status, created_at desc);

create or replace trigger campaigns_touch_updated_at
  before update on public.campaigns
  for each row execute function app.touch_updated_at();

create table if not exists public.campaign_sends (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  campaign_id    uuid not null references public.campaigns (id) on delete cascade,
  person_id      uuid not null references public.people (id) on delete cascade,
  channel        text not null check (channel in ('email', 'sms')),
  planned_status text not null
                 check (planned_status in (
                   'eligible', 'skip_no_consent', 'skip_suppressed',
                   'skip_quiet_hours', 'skip_no_address'
                 )),
  comms_log_id   uuid references public.comms_log (id),
  created_at     timestamptz not null default now(),
  unique (campaign_id, person_id)
);

create index if not exists campaign_sends_tenant_campaign_idx
  on public.campaign_sends (tenant_id, campaign_id);

-- Attribution is correlation, not causality. Holdouts/incrementality are v2.
create table if not exists public.campaign_attributions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  campaign_send_id uuid not null references public.campaign_sends (id) on delete cascade,
  person_id        uuid not null references public.people (id) on delete cascade,
  event_type       text not null check (event_type in ('booking', 'purchase')),
  event_ref        text not null,
  occurred_at      timestamptz not null,
  attributed_at    timestamptz not null default now(),
  window_days      int not null check (window_days > 0),
  unique (campaign_send_id, event_type, event_ref)
);

create index if not exists campaign_attributions_tenant_person_idx
  on public.campaign_attributions (tenant_id, person_id, occurred_at desc);

-- Direct authenticated updates can edit drafts or cancel a proposal, but can
-- never manufacture or rewrite an approval. A SECURITY DEFINER RPC executes
-- as its owner, so it is the only authenticated path through this trigger.
create or replace function app.protect_campaign_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and (
    old.status in ('approved', 'sending', 'sent')
    or
    new.approved_by is distinct from old.approved_by
    or new.approved_at is distinct from old.approved_at
    or (
      new.status is distinct from old.status
      and (
        new.status in ('approved', 'sending', 'sent')
        or old.status in ('approved', 'sending', 'sent')
      )
    )
  ) then
    raise exception 'campaign approval and send transitions require app.approve_campaign()'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger campaigns_protect_approval
  before update on public.campaigns
  for each row execute function app.protect_campaign_approval();

-- Policy preview -------------------------------------------------------------
-- Mirrors @kelo/comms canSend ordering: suppression → marketing consent →
-- quiet hours. comms.send repeats this against fresh state and is authoritative.
create or replace function app.build_campaign_plan(p_campaign uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_timezone text;
  v_quiet_start time;
  v_quiet_end time;
  v_local_time time;
  v_imported_opt_in boolean;
  v_count int;
begin
  select c.* into v_campaign
  from public.campaigns c
  where c.id = p_campaign
  for update;

  if not found then raise exception 'campaign not found' using errcode = 'P0002'; end if;
  if v_campaign.status in ('approved', 'sending', 'sent', 'cancelled') then
    raise exception 'campaign cannot be planned from status %', v_campaign.status;
  end if;
  if (select auth.uid()) is not null
     and not app.has_tenant_role(v_campaign.tenant_id, array['owner', 'manager']) then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;

  select coalesce(l.timezone, 'UTC') into v_timezone
  from public.locations l
  where l.tenant_id = v_campaign.tenant_id
  order by l.created_at, l.id
  limit 1;
  v_timezone := coalesce(v_timezone, 'UTC');

  select
    coalesce(
      nullif(t.settings ->> 'quiet_start', '')::time,
      nullif(t.settings -> 'quiet_hours' ->> 'start', '')::time,
      '21:00'::time
    ),
    coalesce(
      nullif(t.settings ->> 'quiet_end', '')::time,
      nullif(t.settings -> 'quiet_hours' ->> 'end', '')::time,
      '09:00'::time
    ),
    coalesce((t.settings ->> 'imported_consent_optin')::boolean, false)
  into v_quiet_start, v_quiet_end, v_imported_opt_in
  from public.tenants t where t.id = v_campaign.tenant_id;
  v_local_time := (now() at time zone v_timezone)::time;

  insert into public.campaign_sends
    (tenant_id, campaign_id, person_id, channel, planned_status)
  select
    v_campaign.tenant_id,
    v_campaign.id,
    cohort.person_id,
    v_campaign.channel,
    case
      -- SMS uses the CANONICAL E.164 identity (people.phone_e164, unit 3.1b):
      -- an un-normalizable raw phone has no reliable SMS address → skip.
      when (v_campaign.channel = 'email' and nullif(trim(p.email::text), '') is null)
        or (v_campaign.channel = 'sms' and p.phone_e164 is null)
        then 'skip_no_address'
      when suppression.reason is not null and (
        v_campaign.channel = 'sms'
        or v_campaign.kind = 'marketing'
        or suppression.reason = 'hard_bounce'
      ) then 'skip_suppressed'
      when v_campaign.kind = 'marketing' and not coalesce((
        consent.status = 'granted'
        or (
          p.source = 'glofox'
          and consent.status = 'imported_granted'
          and v_imported_opt_in
        )
      ), false) then 'skip_no_consent'
      when v_campaign.kind <> 'transactional'
        and v_quiet_start <> v_quiet_end
        and case
          when v_quiet_start < v_quiet_end
            then v_local_time >= v_quiet_start and v_local_time < v_quiet_end
          else v_local_time >= v_quiet_start or v_local_time < v_quiet_end
        end
        then 'skip_quiet_hours'
      else 'eligible'
    end
  from public.segment_current(v_campaign.tenant_id) cohort
  join public.people p
    on p.id = cohort.person_id and p.tenant_id = v_campaign.tenant_id
  left join lateral (
    select cc.status
    from public.communication_consents cc
    where cc.tenant_id = v_campaign.tenant_id
      and cc.person_id = p.id
      and cc.channel = v_campaign.channel
    order by cc.occurred_at desc, cc.created_at desc, cc.id desc
    limit 1
  ) consent on true
  left join lateral (
    select cs.reason
    from public.comms_suppressions cs
    where cs.tenant_id = v_campaign.tenant_id
      and cs.channel = v_campaign.channel
      and case
        when v_campaign.channel = 'email' then lower(cs.address) = lower(p.email::text)
        else public.to_e164_us(cs.address) = p.phone_e164
      end
    order by cs.created_at desc, cs.id desc
    limit 1
  ) suppression on true
  where cohort.segment_key = v_campaign.segment_key
  on conflict (campaign_id, person_id) do update
    set planned_status = excluded.planned_status,
        channel = excluded.channel;

  delete from public.campaign_sends cs
  where cs.campaign_id = v_campaign.id
    and not exists (
      select 1 from public.segment_current(v_campaign.tenant_id) cohort
      where cohort.person_id = cs.person_id
        and cohort.segment_key = v_campaign.segment_key
    );

  select count(*)::int into v_count
  from public.campaign_sends cs where cs.campaign_id = v_campaign.id;

  update public.campaigns c
  set status = 'pending_approval'
  where c.id = v_campaign.id;
  return v_count;
end;
$$;

comment on function app.build_campaign_plan(uuid) is
  'Materializes a policy preview only. It creates no comms_log or job rows; comms.send remains the authoritative fresh policy check.';

-- Explicit approval: the sole enqueue path ----------------------------------
create or replace function app.approve_campaign(p_campaign uuid, p_actor uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_send record;
  v_log_id uuid;
  v_subject text;
  v_body text;
  v_enqueued int := 0;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'approval actor must be the authenticated user' using errcode = '42501';
  end if;

  select c.* into v_campaign
  from public.campaigns c
  where c.id = p_campaign
  for update;
  if not found then raise exception 'campaign not found' using errcode = 'P0002'; end if;

  if not app.has_tenant_role(v_campaign.tenant_id, array['owner', 'manager']) then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;
  if v_campaign.status = 'cancelled' then raise exception 'campaign is cancelled'; end if;
  if v_campaign.status in ('sending', 'sent') then
    select count(*)::int into v_enqueued
    from public.campaign_sends cs
    where cs.campaign_id = v_campaign.id and cs.comms_log_id is not null;
    return v_enqueued;
  end if;
  if v_campaign.status <> 'pending_approval' then
    raise exception 'campaign must be pending approval';
  end if;

  update public.campaigns c
  set status = 'approved', approved_by = p_actor, approved_at = now()
  where c.id = v_campaign.id;

  for v_send in
    select cs.id as campaign_send_id, cs.person_id, p.first_name,
           case when v_campaign.channel = 'email' then p.email::text else p.phone_e164 end as address,
           t.name as studio_name
    from public.campaign_sends cs
    join public.people p on p.id = cs.person_id and p.tenant_id = cs.tenant_id
    join public.tenants t on t.id = cs.tenant_id
    where cs.campaign_id = v_campaign.id
      and cs.planned_status = 'eligible'
      and cs.comms_log_id is null
    order by cs.created_at, cs.id
    for update of cs
  loop
    -- DOCUMENTED MERGE-FIELD ALLOWLIST: first_name + studio_name only.
    v_subject := replace(replace(
      v_campaign.draft_subject,
      '{{first_name}}', coalesce(nullif(v_send.first_name, ''), 'there')
    ), '{{studio_name}}', v_send.studio_name);
    v_body := replace(replace(
      v_campaign.draft_body,
      '{{first_name}}', coalesce(nullif(v_send.first_name, ''), 'there')
    ), '{{studio_name}}', v_send.studio_name);

    if coalesce(v_subject, '') ~ '\{\{' or v_body ~ '\{\{' then
      raise exception 'campaign contains a merge field outside the allowlist';
    end if;

    insert into public.comms_log
      (tenant_id, person_id, channel, direction, template_key, subject,
       body_preview, to_address, status, campaign_key)
    values
      (v_campaign.tenant_id, v_send.person_id, v_campaign.channel, 'outbound',
       v_campaign.template_key, v_subject, left(v_body, 200), v_send.address,
       'queued', v_campaign.id::text)
    returning id into v_log_id;

    update public.campaign_sends cs
    set comms_log_id = v_log_id
    where cs.id = v_send.campaign_send_id and cs.comms_log_id is null;

    perform app.enqueue_job(
      'comms.send', jsonb_build_object('comms_log_id', v_log_id),
      v_campaign.tenant_id, now(), 100, 5, 'comms.send:' || v_log_id::text
    );
    v_enqueued := v_enqueued + 1;
  end loop;

  update public.campaigns c set status = 'sending' where c.id = v_campaign.id;
  return v_enqueued;
end;
$$;

comment on function app.approve_campaign(uuid, uuid) is
  'OWNER/MANAGER explicit ApprovalCeremony only. Idempotently resolves first_name/studio_name, queues eligible comms, audits approved_by/approved_at, and never calls providers.';

-- PostgREST exposes the public API schema. These invoker wrappers preserve the
-- app.* functions as the security/transaction boundary while making them
-- callable through the ordinary user-scoped Supabase client.
create or replace function public.build_campaign_plan(p_campaign uuid)
returns int language sql security invoker set search_path = ''
as $$ select app.build_campaign_plan(p_campaign); $$;

create or replace function public.approve_campaign(p_campaign uuid, p_actor uuid)
returns int language sql security invoker set search_path = ''
as $$ select app.approve_campaign(p_campaign, p_actor); $$;

-- RLS ------------------------------------------------------------------------
alter table public.message_templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_sends enable row level security;
alter table public.campaign_attributions enable row level security;

create policy message_templates_select on public.message_templates for select
  using (tenant_id is null or tenant_id in (select app.current_tenant_ids()));

create policy campaigns_select on public.campaigns for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy campaigns_insert on public.campaigns for insert
  with check (tenant_id in (select app.current_tenant_ids()));
create policy campaigns_update on public.campaigns for update
  using (tenant_id in (select app.current_tenant_ids()))
  with check (tenant_id in (select app.current_tenant_ids()));

create policy campaign_sends_select on public.campaign_sends for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy campaign_attributions_select on public.campaign_attributions for select
  using (tenant_id in (select app.current_tenant_ids()));

revoke all on public.message_templates, public.campaigns, public.campaign_sends,
  public.campaign_attributions from anon, authenticated, service_role;

grant select on public.message_templates to authenticated, service_role;
grant insert, update on public.message_templates to service_role;
grant select, insert, update on public.campaigns to authenticated, service_role;
grant select on public.campaign_sends, public.campaign_attributions to authenticated, service_role;
grant insert, update, delete on public.campaign_sends to service_role;
grant insert on public.campaign_attributions to service_role;

revoke delete on public.message_templates, public.campaigns, public.campaign_attributions
  from anon, authenticated, service_role;
revoke update, delete on public.campaign_attributions
  from anon, authenticated, service_role;

revoke all on function app.build_campaign_plan(uuid) from public;
grant execute on function app.build_campaign_plan(uuid) to authenticated, service_role;
revoke all on function public.build_campaign_plan(uuid) from public;
grant execute on function public.build_campaign_plan(uuid) to authenticated, service_role;

revoke all on function app.approve_campaign(uuid, uuid) from public;
grant execute on function app.approve_campaign(uuid, uuid) to authenticated;
revoke all on function public.approve_campaign(uuid, uuid) from public;
grant execute on function public.approve_campaign(uuid, uuid) to authenticated;
