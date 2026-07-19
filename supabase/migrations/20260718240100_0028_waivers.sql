-- Phase 4 · unit 3 — versioned waivers, immutable signature evidence, and
-- single-use pre-arrival signing links. The desk queue introduced here is
-- ADVISORY. Booking-time enforcement deliberately lands with phase 6.

-- Versioned legal document --------------------------------------------------
create table if not exists public.waiver_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  version        int not null check (version > 0),
  title          text,
  body           text not null check (length(trim(body)) > 0),
  effective_from timestamptz not null default now(),
  active         boolean not null default true,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (tenant_id, version)
);

create unique index if not exists waiver_versions_one_active_per_tenant
  on public.waiver_versions (tenant_id)
  where active;
create unique index if not exists waiver_versions_tenant_id_id_key
  on public.waiver_versions (tenant_id, id);

comment on table public.waiver_versions is
  'Versioned waiver legal text. Publishing is app.activate_waiver_version(); signed or active text cannot be edited in place.';
comment on column public.waiver_versions.active is
  'Exactly one active version per tenant, enforced by waiver_versions_one_active_per_tenant.';

-- Append-only legal evidence ------------------------------------------------
create table if not exists public.waiver_signatures (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  person_id         uuid not null references public.people (id) on delete cascade,
  waiver_version_id uuid not null references public.waiver_versions (id),
  typed_name        text not null check (length(trim(typed_name)) > 0),
  acknowledged      boolean not null check (acknowledged),
  signed_at         timestamptz not null default now(),
  ip_hash           text,
  user_agent        text,
  source            text not null
                    check (source in ('desk', 'pre_arrival_link', 'member_portal')),
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, waiver_version_id)
    references public.waiver_versions (tenant_id, id)
);

create index if not exists waiver_signatures_tenant_person_signed_idx
  on public.waiver_signatures (tenant_id, person_id, signed_at desc);

comment on table public.waiver_signatures is
  'APPEND-ONLY legal evidence. Corrections and re-signing always append a new row; UPDATE and DELETE are revoked from every application role.';

-- Hashed, expiring, single-use bearer links ---------------------------------
create table if not exists public.waiver_link_tokens (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  person_id         uuid not null references public.people (id) on delete cascade,
  waiver_version_id uuid not null references public.waiver_versions (id),
  token_hash        text not null,
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (token_hash),
  foreign key (tenant_id, waiver_version_id)
    references public.waiver_versions (tenant_id, id)
);

create index if not exists waiver_link_tokens_tenant_person_status_idx
  on public.waiver_link_tokens
    (tenant_id, person_id, waiver_version_id, expires_at desc);

comment on table public.waiver_link_tokens is
  'Pre-arrival bearer links. Only SHA-256 hashes are stored here. The raw high-entropy token exists only in the queued comms body/URL delivered to the signer.';

-- Active/signed version protection -----------------------------------------
create or replace function app.protect_waiver_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if current_user = 'authenticated' and new.active then
      raise exception 'new waiver versions must be activated through app.activate_waiver_version()'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.active or exists (
      select 1 from public.waiver_signatures ws where ws.waiver_version_id = old.id
    ) then
      raise exception 'active or signed waiver versions cannot be deleted'
        using errcode = '23503';
    end if;
    return old;
  end if;

  if new.tenant_id is distinct from old.tenant_id
     or new.version is distinct from old.version
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'waiver version identity is immutable' using errcode = '22023';
  end if;

  if new.active is distinct from old.active and current_user = 'authenticated' then
    raise exception 'waiver activation requires app.activate_waiver_version()'
      using errcode = '42501';
  end if;

  if new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.effective_from is distinct from old.effective_from then
    if old.active or exists (
      select 1 from public.waiver_signatures ws where ws.waiver_version_id = old.id
    ) then
      raise exception 'active or signed waiver text is immutable; create a new version'
        using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger waiver_versions_protect_legal_text
  before insert or update or delete on public.waiver_versions
  for each row execute function app.protect_waiver_version();

-- Advisory status -----------------------------------------------------------
create or replace function public.current_waiver_status(
  p_tenant uuid,
  p_person uuid
)
returns table (
  has_current_signature boolean,
  signed_version int,
  active_version int,
  needs_signature boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_active_id uuid;
  v_active_version int;
  v_signed_version int;
  v_has_current boolean := false;
  v_has_relationship boolean := false;
begin
  -- Returning no row for an inaccessible/mismatched person avoids turning
  -- this invoker function into an identifier oracle.
  if not exists (
    select 1 from public.people p where p.tenant_id = p_tenant and p.id = p_person
  ) then
    return;
  end if;

  select wv.id, wv.version into v_active_id, v_active_version
  from public.waiver_versions wv
  where wv.tenant_id = p_tenant and wv.active
  limit 1;

  select wv.version into v_signed_version
  from public.waiver_signatures ws
  join public.waiver_versions wv on wv.id = ws.waiver_version_id
  where ws.tenant_id = p_tenant and ws.person_id = p_person
  order by ws.signed_at desc, ws.created_at desc, ws.id desc
  limit 1;

  if v_active_id is not null then
    select exists (
      select 1
      from public.waiver_signatures ws
      where ws.tenant_id = p_tenant
        and ws.person_id = p_person
        and ws.waiver_version_id = v_active_id
    ) into v_has_current;
  end if;

  select
    exists (
      select 1 from public.person_relationships pr
      where pr.tenant_id = p_tenant
        and pr.person_id = p_person
        and pr.valid_to is null
    )
    or exists (
      select 1
      from public.glofox_bookings gb
      join public.people p on p.id = p_person and p.tenant_id = p_tenant
      where gb.tenant_id = p_tenant
        and (
          gb.person_external_ref = p.external_ref
          or exists (
            select 1 from public.person_external_refs per
            where per.tenant_id = p_tenant
              and per.person_id = p_person
              and per.system = 'glofox'
              and per.external_ref = gb.person_external_ref
          )
        )
    )
  into v_has_relationship;

  return query select
    v_has_current,
    v_signed_version,
    v_active_version,
    v_active_id is not null and v_has_relationship and not v_has_current;
end;
$$;

-- Sole publication path -----------------------------------------------------
create or replace function app.activate_waiver_version(
  p_tenant uuid,
  p_version_id uuid,
  p_actor uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_target public.waiver_versions%rowtype;
  v_previous uuid;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'waiver activation actor must be the authenticated user'
      using errcode = '42501';
  end if;

  select tu.role into v_actor_role
  from public.tenant_users tu
  where tu.tenant_id = p_tenant
    and tu.user_id = p_actor
    and tu.status = 'active'
    and tu.role in ('owner', 'manager');
  if not found then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant::text, 0)
  );
  select wv.* into v_target
  from public.waiver_versions wv
  where wv.tenant_id = p_tenant and wv.id = p_version_id
  for update;
  if not found then raise exception 'waiver version not found' using errcode = 'P0002'; end if;

  if v_target.active and not exists (
    select 1 from public.waiver_versions wv
    where wv.tenant_id = p_tenant and wv.active and wv.id <> p_version_id
  ) then
    return false;
  end if;

  select wv.id into v_previous
  from public.waiver_versions wv
  where wv.tenant_id = p_tenant and wv.active
  order by wv.version desc
  limit 1;

  update public.waiver_versions
  set active = false
  where tenant_id = p_tenant and active and id <> p_version_id;
  update public.waiver_versions
  set active = true
  where tenant_id = p_tenant and id = p_version_id;

  insert into public.audit_events
    (tenant_id, actor_user_id, actor_role, action, target_type, target_id, metadata)
  values
    (p_tenant, p_actor, v_actor_role, 'waiver.version_activated',
     'waiver_version', p_version_id::text,
     jsonb_build_object('version', v_target.version, 'previous_version_id', v_previous));
  return true;
end;
$$;

-- Sole signature capture path ----------------------------------------------
create or replace function app.record_waiver_signature(
  p_tenant uuid,
  p_person uuid,
  p_waiver_version uuid,
  p_typed_name text,
  p_acknowledged boolean,
  p_source text,
  p_ip_hash text,
  p_user_agent text,
  p_link_token_hash text default null,
  p_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.waiver_versions%rowtype;
  v_token public.waiver_link_tokens%rowtype;
  v_signature_id uuid;
  v_actor_role text;
begin
  if p_typed_name is null or length(trim(p_typed_name)) = 0 then
    raise exception 'typed name is required' using errcode = '22023';
  end if;
  if p_acknowledged is distinct from true then
    raise exception 'waiver acknowledgement is required' using errcode = '22023';
  end if;
  if p_source not in ('desk', 'pre_arrival_link', 'member_portal') then
    raise exception 'invalid waiver signature source' using errcode = '22023';
  end if;
  if length(p_typed_name) > 200 or length(coalesce(p_user_agent, '')) > 1000 then
    raise exception 'waiver attribution field is too long' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.people p where p.tenant_id = p_tenant and p.id = p_person
  ) then
    raise exception 'person not found' using errcode = 'P0002';
  end if;
  select wv.* into v_version
  from public.waiver_versions wv
  where wv.tenant_id = p_tenant and wv.id = p_waiver_version;
  if not found then raise exception 'waiver version not found' using errcode = 'P0002'; end if;

  if p_source = 'pre_arrival_link' then
    if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role'
       or p_link_token_hash is null then
      raise exception 'a valid bearer link is required' using errcode = '42501';
    end if;
    select wlt.* into v_token
    from public.waiver_link_tokens wlt
    where wlt.tenant_id = p_tenant
      and wlt.person_id = p_person
      and wlt.waiver_version_id = p_waiver_version
      and wlt.token_hash = p_link_token_hash
    for update;
    if not found or v_token.consumed_at is not null or v_token.expires_at <= now() then
      raise exception 'waiver link is unavailable' using errcode = 'P0002';
    end if;
  elsif p_source = 'desk' then
    if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
      raise exception 'desk capture actor must be authenticated' using errcode = '42501';
    end if;
    select tu.role into v_actor_role
    from public.tenant_users tu
    where tu.tenant_id = p_tenant
      and tu.user_id = p_actor
      and tu.status = 'active'
      and tu.role in ('owner', 'manager');
    if not found then raise exception 'owner or manager role required' using errcode = '42501'; end if;
    if not v_version.active then
      raise exception 'desk capture must use the active waiver version' using errcode = '22023';
    end if;
  else
    raise exception 'member portal capture is deferred until the member surface ships'
      using errcode = '42501';
  end if;

  insert into public.waiver_signatures (
    tenant_id, person_id, waiver_version_id, typed_name, acknowledged,
    ip_hash, user_agent, source
  ) values (
    p_tenant, p_person, p_waiver_version, trim(p_typed_name), true,
    p_ip_hash, p_user_agent, p_source
  ) returning id into v_signature_id;

  if p_source = 'pre_arrival_link' then
    update public.waiver_link_tokens
    set consumed_at = now()
    where id = v_token.id and consumed_at is null;
  end if;

  insert into public.audit_events
    (tenant_id, actor_user_id, actor_role, action, target_type, target_id, metadata)
  values
    (p_tenant, p_actor, v_actor_role, 'waiver.signature_recorded',
     'waiver_signature', v_signature_id::text,
     jsonb_build_object(
       'person_id', p_person,
       'waiver_version_id', p_waiver_version,
       'waiver_version', v_version.version,
       'source', p_source
     ));
  return v_signature_id;
end;
$$;

-- Authenticated batch enqueue path. The worker owns token minting so raw
-- tokens never cross the staff API response boundary.
create or replace function app.enqueue_waiver_links(
  p_tenant uuid,
  p_actor uuid,
  p_idempotency_key text,
  p_person uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_job uuid;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'waiver link actor must be authenticated' using errcode = '42501';
  end if;
  select tu.role into v_role from public.tenant_users tu
  where tu.tenant_id = p_tenant and tu.user_id = p_actor
    and tu.status = 'active' and tu.role in ('owner', 'manager');
  if not found then raise exception 'owner or manager role required' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if p_person is not null and not exists (
    select 1 from public.people p where p.tenant_id = p_tenant and p.id = p_person
  ) then
    raise exception 'person not found' using errcode = 'P0002';
  end if;

  v_job := app.enqueue_job(
    'waivers.send_links',
    case when p_person is null then '{}'::jsonb
         else jsonb_build_object('person_id', p_person) end,
    p_tenant,
    now(),
    80,
    5,
    'waivers.send_links:' || p_tenant::text || ':' || p_idempotency_key
  );
  insert into public.audit_events
    (tenant_id, actor_user_id, actor_role, action, target_type, target_id, metadata)
  values
    (p_tenant, p_actor, v_role, 'waiver.links_enqueued', 'job', v_job::text,
     jsonb_strip_nulls(jsonb_build_object('person_id', p_person)));
  return v_job;
end;
$$;

-- PostgREST-visible invoker wrappers ---------------------------------------
create or replace function public.activate_waiver_version(
  p_tenant uuid, p_version_id uuid, p_actor uuid
)
returns boolean language sql security invoker set search_path = ''
as $$ select app.activate_waiver_version(p_tenant, p_version_id, p_actor); $$;

create or replace function public.record_waiver_signature(
  p_tenant uuid, p_person uuid, p_waiver_version uuid, p_typed_name text,
  p_acknowledged boolean, p_source text, p_ip_hash text, p_user_agent text,
  p_link_token_hash text default null, p_actor uuid default null
)
returns uuid language sql security invoker set search_path = ''
as $$
  select app.record_waiver_signature(
    p_tenant, p_person, p_waiver_version, p_typed_name, p_acknowledged,
    p_source, p_ip_hash, p_user_agent, p_link_token_hash, p_actor
  );
$$;

create or replace function public.enqueue_waiver_links(
  p_tenant uuid, p_actor uuid, p_idempotency_key text, p_person uuid default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select app.enqueue_waiver_links(p_tenant, p_actor, p_idempotency_key, p_person); $$;

-- RLS ----------------------------------------------------------------------
alter table public.waiver_versions enable row level security;
alter table public.waiver_signatures enable row level security;
alter table public.waiver_link_tokens enable row level security;

create policy waiver_versions_select on public.waiver_versions
  for select using (tenant_id in (select app.current_tenant_ids()));
create policy waiver_versions_insert on public.waiver_versions
  for insert with check (
    app.has_tenant_role(tenant_id, array['owner', 'manager'])
    and created_by = (select auth.uid())
    and not active
  );
create policy waiver_versions_update on public.waiver_versions
  for update using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy waiver_versions_delete on public.waiver_versions
  for delete using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy waiver_signatures_select on public.waiver_signatures
  for select using (tenant_id in (select app.current_tenant_ids()));
create policy waiver_link_tokens_select on public.waiver_link_tokens
  for select using (tenant_id in (select app.current_tenant_ids()));

-- Exact grants. Signatures have no direct insert/update/delete path, even for
-- service_role: the definer RPC above is the only writer and always appends.
revoke all on public.waiver_versions from anon, authenticated, service_role;
grant select on public.waiver_versions to authenticated, service_role;
grant insert, delete on public.waiver_versions to authenticated;
grant update (title, body, effective_from) on public.waiver_versions to authenticated;
grant insert, update, delete on public.waiver_versions to service_role;

revoke all on public.waiver_signatures from anon, authenticated, service_role;
grant select on public.waiver_signatures to authenticated, service_role;
revoke insert, update, delete on public.waiver_signatures
  from anon, authenticated, service_role;

revoke all on public.waiver_link_tokens from anon, authenticated, service_role;
grant select on public.waiver_link_tokens to authenticated, service_role;
grant insert, update on public.waiver_link_tokens to service_role;
revoke delete on public.waiver_link_tokens from anon, authenticated, service_role;

revoke all on function public.current_waiver_status(uuid, uuid) from public;
revoke all on function public.activate_waiver_version(uuid, uuid, uuid) from public;
revoke all on function public.record_waiver_signature(
  uuid, uuid, uuid, text, boolean, text, text, text, text, uuid
) from public;
revoke all on function public.enqueue_waiver_links(uuid, uuid, text, uuid) from public;

grant execute on function public.current_waiver_status(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.activate_waiver_version(uuid, uuid, uuid)
  to authenticated;
grant execute on function public.record_waiver_signature(
  uuid, uuid, uuid, text, boolean, text, text, text, text, uuid
) to authenticated, service_role;
grant execute on function public.enqueue_waiver_links(uuid, uuid, text, uuid)
  to authenticated;

revoke all on function app.protect_waiver_version() from public;
revoke all on function app.activate_waiver_version(uuid, uuid, uuid) from public;
revoke all on function app.record_waiver_signature(
  uuid, uuid, uuid, text, boolean, text, text, text, text, uuid
) from public;
revoke all on function app.enqueue_waiver_links(uuid, uuid, text, uuid) from public;
grant execute on function app.activate_waiver_version(uuid, uuid, uuid) to authenticated;
grant execute on function app.record_waiver_signature(
  uuid, uuid, uuid, text, boolean, text, text, text, text, uuid
) to authenticated, service_role;
grant execute on function app.enqueue_waiver_links(uuid, uuid, text, uuid) to authenticated;

