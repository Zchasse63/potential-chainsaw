-- 0032 — allow front_desk to capture waiver signatures at the desk.
--
-- Cross-layer role mismatch caught in review: the waiver desk-capture path
-- (routes/waivers.ts POST /waivers/sign + the web screen) is offered to
-- owner/manager/front_desk, but app.record_waiver_signature (migration 0028)
-- restricted source='desk' to owner/manager only — so a front-desk staffer
-- capturing a signature would get 42501 despite the UI allowing it. Desk
-- capture is inherently a FRONT-DESK workflow (the "Waiver needed" desk queue is
-- a front-desk tool consulted at check-in), so the RPC is the wrong layer. This
-- CREATE OR REPLACE (0028 is applied to prod — cannot edit in place) widens the
-- desk-source role check to include front_desk. All other behavior — the
-- append-only insert, the acknowledged/typed-name checks, the pre_arrival_link
-- and member_portal branches, the active-version requirement — is unchanged.
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
    -- Desk capture is a front-desk workflow (widened from owner/manager in 0028).
    select tu.role into v_actor_role
    from public.tenant_users tu
    where tu.tenant_id = p_tenant
      and tu.user_id = p_actor
      and tu.status = 'active'
      and tu.role in ('owner', 'manager', 'front_desk');
    if not found then
      raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
    end if;
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
