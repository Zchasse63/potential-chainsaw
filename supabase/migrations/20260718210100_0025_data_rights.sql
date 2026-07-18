-- Phase 3 · unit 3 — data rights: the versioned retention matrix, asynchronous
-- DSAR exports, and audited person pseudonymization.
--
-- Evidence boundary: credit_ledger, person_relationship_log, audit_events,
-- communication_consents, briefing_feedback, and campaign_attributions are
-- append-only. Person erasure scrubs direct identifiers while retaining their
-- pseudonymous person_id links for financial, dispute, waiver, chargeback,
-- consent, and attribution evidence.

-- The mutable identity row gains an explicit tombstone. phone_e164 remains a
-- generated column: clearing phone clears it automatically.
alter table public.people
  add column if not exists address jsonb,
  add column if not exists deleted_at timestamptz,
  add column if not exists pseudonym_label text;

create index if not exists people_tenant_deleted_idx
  on public.people (tenant_id, deleted_at)
  where deleted_at is not null;

comment on column public.people.deleted_at is
  'Data-rights tombstone. A non-null value means direct identity fields were pseudonymized; append-only facts retain this person_id.';
comment on column public.people.pseudonym_label is
  'Stable non-PII label used after erasure; never derived from the former name, email, phone, or address.';

-- Prevent a later Glofox upsert from rehydrating a tombstoned identity. The
-- erasure update itself sees OLD.deleted_at = NULL and is therefore allowed.
create or replace function app.keep_deleted_person_pseudonymous()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    new.first_name := old.first_name;
    new.last_name := old.last_name;
    new.email := old.email;
    new.phone := old.phone;
    new.address := old.address;
    new.deleted_at := old.deleted_at;
    new.pseudonym_label := old.pseudonym_label;
    new.active := false;
  end if;
  return new;
end;
$$;

create or replace trigger people_keep_deleted_pseudonymous
  before update on public.people
  for each row execute function app.keep_deleted_person_pseudonymous();

-- Versioned retention matrix -------------------------------------------------
create table if not exists public.retention_policies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references public.tenants (id) on delete cascade,
  data_class     text not null
                 check (data_class in (
                   'comms_content', 'ai_artifacts', 'raw_payloads',
                   'import_quarantine', 'webhook_events', 'reconciliations'
                 )),
  retention_days int not null check (retention_days >= 0),
  action         text not null check (action in ('delete', 'scrub_body', 'pseudonymize')),
  legal_basis    text not null,
  preserves      text not null,
  version        int not null check (version > 0),
  created_at     timestamptz not null default now()
);

create unique index if not exists retention_policies_scope_class_version_key
  on public.retention_policies (
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    data_class,
    version
  );
create index if not exists retention_policies_tenant_class_version_idx
  on public.retention_policies (tenant_id, data_class, version desc);

comment on table public.retention_policies is
  'Versioned data-retention matrix. tenant_id NULL is the Kelo default; the newest tenant-scoped row overrides the newest global row for its data class.';

-- AI artifacts expire after one year, but briefing_feedback is append-only.
-- Break the old ON DELETE CASCADE before any sweep can remove an artifact.
-- artifact_id deliberately becomes an opaque historical reference after its
-- payload expires: the feedback row itself is neither updated nor deleted.
alter table public.briefing_feedback
  drop constraint if exists briefing_feedback_artifact_id_fkey;
comment on column public.briefing_feedback.artifact_id is
  'Append-only historical artifact reference. The referenced AI payload may expire per retention_policies; this feedback row and identifier never mutate.';

insert into public.retention_policies
  (id, tenant_id, data_class, retention_days, action, legal_basis, preserves, version)
values
  ('25000000-0000-4000-8000-000000000001', null, 'comms_content', 730, 'scrub_body',
   'Operational send history and legal compliance; content minimization after two years.',
   'Keeps each comms_log row, delivery metadata, consent/suppression evidence, and per-person send history; only subject/body content is scrubbed.', 1),
  ('25000000-0000-4000-8000-000000000002', null, 'ai_artifacts', 365, 'delete',
   'AI data minimization under zero-data-retention provider terms.',
   'Keeps append-only briefing_feedback evidence; deterministic source facts and metric definitions remain independently auditable.', 1),
  ('25000000-0000-4000-8000-000000000003', null, 'raw_payloads', 1095, 'delete',
   'Three-year provenance and mapping-audit window.',
   'Keeps all mapped native facts, append-only ledgers, audit events, and reconciliation evidence; deletion never touches native tables.', 1),
  ('25000000-0000-4000-8000-000000000004', null, 'import_quarantine', 365, 'delete',
   'Minimize rejected vendor payloads after the exception-review window.',
   'Keeps resolved native facts, sync run summaries, and audit decisions outside the quarantined payload.', 1),
  ('25000000-0000-4000-8000-000000000005', null, 'webhook_events', 180, 'delete',
   'Minimize provider callback payloads after delivery processing and replay windows.',
   'Keeps comms_log delivery/send metadata, consent evidence, suppressions, and provider message identifiers.', 1),
  ('25000000-0000-4000-8000-000000000006', null, 'reconciliations', 730, 'delete',
   'Two-year operational correctness and cutover evidence window.',
   'Keeps native financial facts, transactions, append-only ledgers, audit events, and current health state.', 1)
on conflict do nothing;

-- Append-only erasure audit --------------------------------------------------
create table if not exists public.person_deletions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  person_id      uuid not null references public.people (id) on delete cascade,
  requested_by   uuid,
  reason         text,
  mode           text not null default 'pseudonymize'
                 check (mode in ('pseudonymize', 'hard')),
  scrubbed_fields text[],
  preserved_note text,
  executed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists person_deletions_tenant_person_created_idx
  on public.person_deletions (tenant_id, person_id, created_at desc);

comment on table public.person_deletions is
  'Append-only erasure audit. hard is reserved for a future evidence-free case; the shipped workflow pseudonymizes by default.';

-- Async DSAR / tenant export jobs -------------------------------------------
create table if not exists public.data_exports (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  subject_person_id uuid references public.people (id) on delete restrict,
  requested_by      uuid,
  status            text not null default 'queued'
                    check (status in ('queued', 'running', 'ready', 'error', 'expired')),
  artifact          jsonb,
  row_counts        jsonb,
  error             text,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists data_exports_tenant_created_idx
  on public.data_exports (tenant_id, created_at desc);
create index if not exists data_exports_expiry_idx
  on public.data_exports (expires_at)
  where status = 'ready';

create or replace trigger data_exports_touch_updated_at
  before update on public.data_exports
  for each row execute function app.touch_updated_at();

comment on table public.data_exports is
  'Owner/manager-initiated asynchronous DSAR and tenant exports. artifact intentionally contains the subject person own PII and expires after a short download window.';

-- RLS -----------------------------------------------------------------------
alter table public.retention_policies enable row level security;
alter table public.person_deletions enable row level security;
alter table public.data_exports enable row level security;

drop policy if exists retention_policies_select on public.retention_policies;
create policy retention_policies_select on public.retention_policies
  for select
  using (tenant_id is null or tenant_id in (select app.current_tenant_ids()));

drop policy if exists person_deletions_select on public.person_deletions;
create policy person_deletions_select on public.person_deletions
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists data_exports_select on public.data_exports;
create policy data_exports_select on public.data_exports
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- One-transaction person pseudonymization ----------------------------------
create or replace function app.pseudonymize_person(
  p_tenant uuid,
  p_person uuid,
  p_actor uuid,
  p_reason text
)
returns public.person_deletions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person public.people%rowtype;
  v_audit public.person_deletions%rowtype;
  v_email text;
  v_phone text;
  v_preserved constant text :=
    'credit_ledger, transactions, relationship_log, audit_events, attributions retained as append-only financial/dispute/waiver evidence per retention_policies; consent revocations and address-scoped suppressions retained to prevent future contact';
begin
  if p_actor is null then
    raise exception 'person erasure requires an actor' using errcode = '22023';
  end if;
  -- Authenticated callers must be an active owner/manager of this tenant and
  -- cannot forge the actor. service_role calls have auth.uid() NULL and are
  -- trusted only through the service-only EXECUTE grant.
  if (select auth.uid()) is not null then
    if p_actor is distinct from (select auth.uid()) then
      raise exception 'actor must match authenticated user' using errcode = '42501';
    end if;
    if not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
      raise exception 'owner or manager role required' using errcode = '42501';
    end if;
  end if;

  select p.* into v_person
  from public.people p
  where p.id = p_person and p.tenant_id = p_tenant
  for update;

  if not found then
    raise exception 'person not found in tenant' using errcode = 'P0002';
  end if;

  -- Idempotency: return the original erasure audit without appending another
  -- consent/audit row or touching any evidence.
  if v_person.deleted_at is not null then
    select d.* into v_audit
    from public.person_deletions d
    where d.tenant_id = p_tenant and d.person_id = p_person
    order by d.created_at desc, d.id desc
    limit 1;
    return v_audit;
  end if;

  v_email := nullif(lower(trim(v_person.email::text)), '');
  v_phone := v_person.phone_e164;

  -- Suppress the original destinations BEFORE clearing mutable identity.
  if v_email is not null then
    insert into public.comms_suppressions
      (tenant_id, channel, address, person_id, reason)
    values (p_tenant, 'email', v_email, p_person, 'manual')
    on conflict (tenant_id, channel, address) do nothing;
  end if;
  if v_phone is not null then
    insert into public.comms_suppressions
      (tenant_id, channel, address, person_id, reason)
    values (p_tenant, 'sms', v_phone, p_person, 'manual')
    on conflict (tenant_id, channel, address) do nothing;
  end if;

  insert into public.communication_consents
    (tenant_id, person_id, channel, status, evidence, occurred_at)
  values
    (p_tenant, p_person, 'email', 'revoked',
     jsonb_build_object('source', 'person_erasure', 'actor', p_actor), now()),
    (p_tenant, p_person, 'sms', 'revoked',
     jsonb_build_object('source', 'person_erasure', 'actor', p_actor), now());

  update public.comms_log
  set subject = '[erased]',
      body_preview = '[erased]',
      to_address = '[erased]'
  where tenant_id = p_tenant and person_id = p_person;

  update public.people
  set first_name = 'Deleted',
      last_name = null,
      email = null,
      phone = null,
      address = null,
      active = false,
      consent_email = false,
      consent_sms = false,
      deleted_at = now(),
      pseudonym_label = 'deleted-' || left(replace(p_person::text, '-', ''), 12)
  where id = p_person and tenant_id = p_tenant;

  insert into public.person_deletions
    (tenant_id, person_id, requested_by, reason, mode, scrubbed_fields,
     preserved_note, executed_at)
  values
    (p_tenant, p_person, p_actor, p_reason, 'pseudonymize',
     array[
       'people.first_name', 'people.last_name', 'people.email', 'people.phone',
       'people.phone_e164', 'people.address', 'people.consent_email',
       'people.consent_sms', 'comms_log.subject', 'comms_log.body_preview',
       'comms_log.to_address'
     ]::text[],
     v_preserved, now())
  returning * into v_audit;

  return v_audit;
end;
$$;

comment on function app.pseudonymize_person(uuid, uuid, uuid, text) is
  'Idempotent one-transaction erasure: scrubs mutable identity/content, suppresses both known destinations, revokes consent, tombstones the person, and retains append-only evidence.';

-- Narrow service-only retention writer. The worker chooses an effective
-- versioned policy; this function owns the exact table/action allowlist so the
-- service role never gains broad DELETE on the raw zone (or any ledger).
create or replace function app.apply_retention_policy(
  p_tenant uuid,
  p_data_class text,
  p_retention_days int,
  p_action text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touched int := 0;
  v_policy public.retention_policies%rowtype;
begin
  if p_retention_days < 0 then
    raise exception 'retention days cannot be negative' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'retention tenant not found' using errcode = 'P0002';
  end if;

  select rp.* into v_policy
  from public.retention_policies rp
  where rp.data_class = p_data_class
    and (
      (p_data_class = 'webhook_events' and rp.tenant_id is null)
      or (p_data_class <> 'webhook_events' and (rp.tenant_id is null or rp.tenant_id = p_tenant))
    )
  order by (rp.tenant_id is not null) desc, rp.version desc
  limit 1;
  if not found
     or v_policy.retention_days is distinct from p_retention_days
     or v_policy.action is distinct from p_action then
    raise exception 'retention request does not match the effective matrix policy'
      using errcode = '22023';
  end if;

  case p_data_class
    when 'comms_content' then
      if p_action <> 'scrub_body' then return 0; end if;
      update public.comms_log
      set subject = '[retention-scrub]', body_preview = '[retention-scrub]'
      where tenant_id = p_tenant
        and created_at < now() - (p_retention_days * interval '1 day')
        and (subject is distinct from '[retention-scrub]'
             or body_preview is distinct from '[retention-scrub]');
    when 'ai_artifacts' then
      if p_action <> 'delete' then return 0; end if;
      delete from public.ai_artifacts
      where tenant_id = p_tenant
        and created_at < now() - (p_retention_days * interval '1 day');
    when 'raw_payloads' then
      if p_action <> 'delete' then return 0; end if;
      delete from public.glofox_raw
      where tenant_id = p_tenant
        and fetched_at < now() - (p_retention_days * interval '1 day');
    when 'import_quarantine' then
      if p_action <> 'delete' then return 0; end if;
      delete from public.import_quarantine
      where tenant_id = p_tenant
        and created_at < now() - (p_retention_days * interval '1 day');
    when 'webhook_events' then
      if p_action <> 'delete' then return 0; end if;
      -- webhook_events predates tenancy. The worker permits only the GLOBAL
      -- policy to reach this branch; a tenant override is never applied here.
      delete from public.webhook_events
      where received_at < now() - (p_retention_days * interval '1 day');
    when 'reconciliations' then
      if p_action <> 'delete' then return 0; end if;
      delete from public.reconciliations
      where tenant_id = p_tenant
        and created_at < now() - (p_retention_days * interval '1 day');
    else
      raise exception 'unsupported retention data class %', p_data_class
        using errcode = '22023';
  end case;
  get diagnostics v_touched = row_count;
  return v_touched;
end;
$$;

create or replace function app.expire_data_exports(p_tenant uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touched int;
begin
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'export tenant not found' using errcode = 'P0002';
  end if;
  update public.data_exports
  set status = 'expired', artifact = null
  where tenant_id = p_tenant
    and status = 'ready'
    and expires_at <= now();
  get diagnostics v_touched = row_count;
  return v_touched;
end;
$$;

-- Authenticated request bridge: creates the export row and enqueues exactly
-- one person.export job for an idempotency key. The worker alone assembles PII.
create or replace function app.request_person_export(
  p_tenant uuid,
  p_person uuid,
  p_actor uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_export uuid;
  v_existing_payload jsonb;
  v_key text;
begin
  if p_actor is null then
    raise exception 'person export requires an actor' using errcode = '22023';
  end if;
  if p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null then
    if p_actor is distinct from (select auth.uid()) then
      raise exception 'actor must match authenticated user' using errcode = '42501';
    end if;
    if not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
      raise exception 'owner or manager role required' using errcode = '42501';
    end if;
  end if;
  if not exists (
    select 1 from public.people p where p.id = p_person and p.tenant_id = p_tenant
  ) then
    raise exception 'person not found in tenant' using errcode = 'P0002';
  end if;

  v_key := 'person.export:' || p_tenant::text || ':' || p_person::text || ':' || p_idempotency_key;
  -- Serialize the lookup+create pair so concurrent retries cannot leave an
  -- orphan data_exports row before app.enqueue_job observes its unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_key, 0));
  select j.payload into v_existing_payload
  from public.jobs j
  where j.kind = 'person.export' and j.idempotency_key = v_key;
  if found then
    return (v_existing_payload ->> 'export_id')::uuid;
  end if;

  insert into public.data_exports (tenant_id, subject_person_id, requested_by, status)
  values (p_tenant, p_person, p_actor, 'queued')
  returning id into v_export;

  perform app.enqueue_job(
    'person.export',
    jsonb_build_object('export_id', v_export, 'person_id', p_person, 'actor_id', p_actor),
    p_tenant,
    now(),
    100,
    5,
    v_key
  );
  return v_export;
end;
$$;

-- Exact privileges -----------------------------------------------------------
revoke all on public.retention_policies from anon, authenticated, service_role;
revoke all on public.person_deletions from anon, authenticated, service_role;
revoke all on public.data_exports from anon, authenticated, service_role;

grant select on public.retention_policies to authenticated, service_role;
grant select on public.person_deletions to authenticated, service_role;
grant select on public.data_exports to authenticated, service_role;
grant insert on public.retention_policies to service_role;
grant insert on public.person_deletions to service_role;
grant insert, update, delete on public.data_exports to service_role;

revoke update, delete on public.person_deletions
  from anon, authenticated, service_role;
revoke update, delete on public.retention_policies
  from anon, authenticated;

revoke all on function app.keep_deleted_person_pseudonymous() from public;
revoke all on function app.pseudonymize_person(uuid, uuid, uuid, text) from public;
revoke all on function app.apply_retention_policy(uuid, text, int, text) from public;
revoke all on function app.expire_data_exports(uuid) from public;
revoke all on function app.request_person_export(uuid, uuid, uuid, text) from public;
grant execute on function app.pseudonymize_person(uuid, uuid, uuid, text)
  to authenticated, service_role;
grant execute on function app.apply_retention_policy(uuid, text, int, text)
  to service_role;
grant execute on function app.expire_data_exports(uuid) to service_role;
grant execute on function app.request_person_export(uuid, uuid, uuid, text)
  to authenticated, service_role;
