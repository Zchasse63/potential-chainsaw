-- Phase 3 · unit 1 — communications consent evidence, hard suppressions,
-- immutable message history, and the Resend/Twilio webhook inbox.
--
-- Send-time policy remains in @kelo/comms so the worker can re-evaluate fresh
-- consent, suppression, and studio-local quiet hours immediately before a
-- provider call. Imported Glofox consent already lives on people; this
-- migration preserves that tri-state evidence without treating it as Kelo
-- marketing consent (owner decision D2 is enforced by the TS policy default).

-- Consent evidence ----------------------------------------------------------
create table if not exists public.communication_consents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  person_id   uuid not null references public.people (id) on delete cascade,
  channel     text not null check (channel in ('email', 'sms')),
  status      text not null
              check (status in ('granted', 'revoked', 'imported_granted', 'imported_unknown')),
  evidence    jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists communication_consents_current_idx
  on public.communication_consents
  (tenant_id, person_id, channel, occurred_at desc, created_at desc, id desc);

comment on table public.communication_consents is
  'Append-only per-channel consent evidence. Current consent is the latest occurred_at/created_at/id row; corrections append, never rewrite history.';

-- Preserve the mapper-owned Glofox tri-state as evidence. TRUE is imported
-- evidence (not native Kelo consent); FALSE is an explicit revocation; NULL is
-- unknown. ON CONFLICT is intentionally unnecessary because this migration is
-- applied once and the table is new.
insert into public.communication_consents (
  tenant_id,
  person_id,
  channel,
  status,
  evidence,
  occurred_at
)
select
  p.tenant_id,
  p.id,
  evidence.channel,
  case evidence.value
    when true then 'imported_granted'
    when false then 'revoked'
    else 'imported_unknown'
  end,
  jsonb_build_object(
    'source', 'glofox_import',
    'details', jsonb_build_object('imported_value', evidence.value)
  ),
  coalesce(p.source_created_at, p.created_at)
from public.people p
cross join lateral (
  values
    ('email'::text, p.consent_email),
    ('sms'::text, p.consent_sms)
) as evidence(channel, value);

-- SECURITY INVOKER is deliberate: authenticated callers see only evidence
-- rows admitted by communication_consents RLS. The explicit tenant/person
-- pair prevents a caller from combining identifiers across tenants.
create or replace function public.current_consent(
  p_tenant uuid,
  p_person uuid,
  p_channel text
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select cc.status
  from public.communication_consents cc
  where cc.tenant_id = p_tenant
    and cc.person_id = p_person
    and cc.channel = p_channel
    and p_channel in ('email', 'sms')
  order by cc.occurred_at desc, cc.created_at desc, cc.id desc
  limit 1;
$$;

-- Address-scoped hard blocks -------------------------------------------------
create table if not exists public.comms_suppressions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  channel    text not null check (channel in ('email', 'sms')),
  address    text not null,
  person_id  uuid references public.people (id) on delete set null,
  reason     text not null
             check (reason in ('stop_reply', 'unsub_link', 'hard_bounce', 'complaint', 'manual')),
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, address)
);

create index if not exists comms_suppressions_person_idx
  on public.comms_suppressions (tenant_id, person_id, created_at desc)
  where person_id is not null;

comment on table public.comms_suppressions is
  'Address-scoped send-time hard blocks. Staff may see suppressions but have no client write path and cannot override them.';

-- Every outbound and inbound message ----------------------------------------
create table if not exists public.comms_log (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  person_id           uuid references public.people (id) on delete set null,
  channel             text not null check (channel in ('email', 'sms')),
  direction           text not null default 'outbound'
                      check (direction in ('outbound', 'inbound')),
  template_key        text,
  subject             text,
  body_preview        text check (body_preview is null or char_length(body_preview) <= 200),
  to_address          text not null,
  provider            text check (provider in ('resend', 'twilio', 'dry_run')),
  provider_message_id text,
  status              text not null
                      check (status in (
                        'queued', 'sent', 'delivered', 'bounced', 'failed',
                        'suppressed', 'skipped_quiet_hours',
                        'skipped_no_consent', 'dry_run'
                      )),
  status_detail       text,
  campaign_key        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists comms_log_tenant_person_created_idx
  on public.comms_log (tenant_id, person_id, created_at desc);

create index if not exists comms_log_tenant_provider_message_idx
  on public.comms_log (tenant_id, provider_message_id)
  where provider_message_id is not null;

create or replace trigger comms_log_touch_updated_at
  before update on public.comms_log
  for each row execute function app.touch_updated_at();

comment on table public.comms_log is
  'Every email/SMS attempt and inbound SMS. body_preview is capped at 200 characters; full-body retention lands with the phase-3 retention matrix.';

-- Provider inbox -------------------------------------------------------------
create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('resend', 'twilio')),
  event_id     text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       text not null default 'received'
               check (status in ('received', 'processed', 'error')),
  error        text,
  unique (provider, event_id)
);

comment on table public.webhook_events is
  'Signature-verified Resend/Twilio inbox, deduped before processing. No tenant_id: events resolve tenancy through the referenced message/address. The generic tenant guard skips this table; explicit deny-all client RLS is still mandatory.';

-- RLS -----------------------------------------------------------------------
alter table public.communication_consents enable row level security;
alter table public.comms_suppressions enable row level security;
alter table public.comms_log enable row level security;
alter table public.webhook_events enable row level security;

drop policy if exists communication_consents_select on public.communication_consents;
create policy communication_consents_select on public.communication_consents
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists comms_suppressions_select on public.comms_suppressions;
create policy comms_suppressions_select on public.comms_suppressions
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists comms_log_select on public.comms_log;
create policy comms_log_select on public.comms_log
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- webhook_events intentionally has no tenant_id. The service role bypasses
-- RLS; every client role is denied explicitly.
drop policy if exists webhook_events_no_client_access on public.webhook_events;
create policy webhook_events_no_client_access on public.webhook_events
  for all to authenticated, anon
  using (false) with check (false);

-- Exact grants ---------------------------------------------------------------
revoke all on public.communication_consents from anon, authenticated, service_role;
revoke all on public.comms_suppressions from anon, authenticated, service_role;
revoke all on public.comms_log from anon, authenticated, service_role;
revoke all on public.webhook_events from anon, authenticated, service_role;

grant select on public.communication_consents to authenticated, service_role;
grant insert on public.communication_consents to service_role;

grant select on public.comms_suppressions to authenticated, service_role;
grant insert on public.comms_suppressions to service_role;

grant select on public.comms_log to authenticated, service_role;
grant insert, update on public.comms_log to service_role;

grant select, insert, update on public.webhook_events to service_role;

-- Consent evidence is hard append-only for every application role. Suppression
-- and log deletion are also forbidden: staff cannot override an opt-out, and
-- "every message ever" cannot silently lose rows. A future verified member
-- re-opt-in flow may append consent and use a narrowly guarded definer to lift
-- a suppression; no such override exists in this unit.
revoke update, delete on public.communication_consents
  from anon, authenticated, service_role;
revoke update, delete on public.comms_suppressions
  from anon, authenticated, service_role;
revoke delete on public.comms_log
  from anon, authenticated, service_role;
revoke delete on public.webhook_events
  from anon, authenticated, service_role;

revoke all on function public.current_consent(uuid, uuid, text) from public;
grant execute on function public.current_consent(uuid, uuid, text)
  to authenticated, service_role;
