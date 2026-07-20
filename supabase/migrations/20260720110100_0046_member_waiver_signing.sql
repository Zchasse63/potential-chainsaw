-- Phase 8 · unit 8.3i — member self-serve waiver signing (plan-member-app §7).
--
-- Implements the `member_portal` branch of app.record_waiver_signature, which
-- 0028 shipped stubbed ("deferred until the member surface ships"). The member
-- surface now ships, so an unsigned-waiver member can read + type-name +
-- checkbox-accept the ACTIVE waiver in-flow instead of the front-desk dead-end.
--
-- SECURITY: member_portal has NO token (unlike pre_arrival_link) and NO
-- auth.uid() (members hold no Supabase JWT), so it trusts p_person exactly like
-- book_session/hold_session already do — the person-scoping guarantee is an
-- API-layer property (resolveMember → memberOf, never the request body). The
-- in-body gate here is `auth.jwt()->>'role' = 'service_role'` (the member API's
-- client), which structurally denies an `authenticated` STAFF client — who can
-- reach this public wrapper — from forging a member's legal signature for an
-- arbitrary person. Mirrors the service-role gate on refresh_member_session
-- (0045) and pre_arrival_link (0028). Attack block 39 proves it.

-- Idempotency backstop: the in-body pre-check collapses the common double-tap;
-- this partial unique index makes it airtight under a genuine concurrent race
-- (the second insert raises unique_violation, caught below → the winning row).
create unique index if not exists waiver_signatures_member_portal_once
  on public.waiver_signatures (tenant_id, person_id, waiver_version_id)
  where source = 'member_portal';

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
  v_replayed boolean := false;
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
    -- member_portal (self-serve, in-flow). SERVICE-ROLE ONLY — see header.
    if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
      raise exception 'member portal capture may only be performed by the API service role'
        using errcode = '42501';
    end if;
    if not v_version.active then
      raise exception 'member portal capture must use the active waiver version'
        using errcode = '22023';
    end if;
    -- Idempotent fast path: a resubmit of an already-signed active version
    -- returns the SAME row — no duplicate legal-evidence row, no double audit.
    select ws.id into v_signature_id
    from public.waiver_signatures ws
    where ws.tenant_id = p_tenant and ws.person_id = p_person
      and ws.waiver_version_id = p_waiver_version and ws.source = 'member_portal'
    order by ws.signed_at desc, ws.created_at desc, ws.id desc
    limit 1;
    if v_signature_id is not null then
      return v_signature_id;
    end if;
  end if;

  begin
    insert into public.waiver_signatures (
      tenant_id, person_id, waiver_version_id, typed_name, acknowledged,
      ip_hash, user_agent, source
    ) values (
      p_tenant, p_person, p_waiver_version, trim(p_typed_name), true,
      p_ip_hash, p_user_agent, p_source
    ) returning id into v_signature_id;
  exception when unique_violation then
    -- Only waiver_signatures_member_portal_once can raise this (desk /
    -- pre_arrival_link carry no such constraint): a concurrent double-submit
    -- that beat the fast path. Return the winning row, skip the duplicate audit.
    select ws.id into v_signature_id
    from public.waiver_signatures ws
    where ws.tenant_id = p_tenant and ws.person_id = p_person
      and ws.waiver_version_id = p_waiver_version and ws.source = 'member_portal'
    order by ws.signed_at desc, ws.created_at desc, ws.id desc
    limit 1;
    if v_signature_id is null then raise; end if;
    v_replayed := true;
  end;

  if p_source = 'pre_arrival_link' then
    update public.waiver_link_tokens
    set consumed_at = now()
    where id = v_token.id and consumed_at is null;
  end if;

  if not v_replayed then
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
  end if;
  return v_signature_id;
end;
$$;

-- CREATE OR REPLACE with an IDENTICAL signature preserves the 0028 grants;
-- reasserted here for auditability (the definer RPC stays the only signature
-- writer — waiver_signatures has no direct insert grant for any role).
revoke all on function app.record_waiver_signature(
  uuid, uuid, uuid, text, boolean, text, text, text, text, uuid
) from public;
grant execute on function app.record_waiver_signature(
  uuid, uuid, uuid, text, boolean, text, text, text, text, uuid
) to authenticated, service_role;
