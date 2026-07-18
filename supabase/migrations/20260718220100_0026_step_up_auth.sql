-- Phase 4 · unit 1 — staff step-up PIN authorization.
--
-- The API compares PINs with Node scrypt. PostgreSQL owns the shared lockout
-- state so five failures cannot be spread across API instances. PINs are not
-- login credentials and there is deliberately no email/reset-token path.

alter table public.tenant_users
  add column if not exists step_up_pin_set_at timestamptz,
  add column if not exists step_up_locked_until timestamptz,
  add column if not exists step_up_fail_count int not null default 0
    check (step_up_fail_count >= 0);

-- Supports a composite FK so a service insert cannot pair tenant A with a
-- tenant_users row belonging to tenant B.
create unique index if not exists tenant_users_tenant_id_id_key
  on public.tenant_users (tenant_id, id);

create table if not exists public.step_up_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  tenant_user_id uuid not null,
  kind           text not null
                 check (kind in ('set', 'rotate', 'verify_success', 'verify_fail', 'lockout')),
  action_context text,
  ip_hash        text,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, tenant_user_id)
    references public.tenant_users (tenant_id, id) on delete cascade
);

create index if not exists step_up_events_tenant_user_created_idx
  on public.step_up_events (tenant_id, tenant_user_id, created_at desc);

comment on table public.step_up_events is
  'Append-only PIN audit and shared rate-limit evidence. PINs and PIN hashes never appear here.';
comment on column public.step_up_events.action_context is
  'Action authorized by the attempt, for example refund_over_threshold or manual_grant.';

alter table public.step_up_events enable row level security;

drop policy if exists step_up_events_manager_select on public.step_up_events;
create policy step_up_events_manager_select on public.step_up_events
  for select
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

-- Evidence is append-only even for the service role. Definer functions and
-- service workers may append; no application role can rewrite history.
revoke all on public.step_up_events from anon, authenticated, service_role;
grant select on public.step_up_events to authenticated, service_role;
grant insert on public.step_up_events to service_role;
revoke update, delete on public.step_up_events from anon, authenticated, service_role;

-- The only credential setter. p_user and p_actor are auth.users ids; the
-- tenant_users row id is resolved under a row lock and written to the audit.
create or replace function app.set_step_up_pin(
  p_tenant uuid,
  p_user uuid,
  p_pin_hash text,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.tenant_users%rowtype;
  v_actor public.tenant_users%rowtype;
  v_kind text;
  v_actor_rank int;
  v_target_rank int;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'PIN actor must be the authenticated user' using errcode = '42501';
  end if;

  -- Fixed-format validation prevents a direct RPC caller from storing a fast
  -- or unsalted credential. Parameters match apps/api/src/auth/stepup.ts:
  -- scrypt N=32768, r=8, p=1, 16-byte salt, 32-byte derived key (base64url).
  if p_pin_hash is null
     or p_pin_hash !~ '^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid step-up PIN hash format' using errcode = '22023';
  end if;

  select tu.* into v_target
  from public.tenant_users tu
  where tu.tenant_id = p_tenant
    and tu.user_id = p_user
    and tu.status = 'active'
  for update;
  if not found then
    raise exception 'active target membership not found' using errcode = 'P0002';
  end if;

  select tu.* into v_actor
  from public.tenant_users tu
  where tu.tenant_id = p_tenant
    and tu.user_id = p_actor
    and tu.status = 'active';
  if not found then
    raise exception 'active actor membership not found' using errcode = '42501';
  end if;

  -- Owner/manager PIN changes require an MFA-authenticated access token. This
  -- prevents a magic-link/password-reset session from becoming PIN-reset
  -- authority through the same compromised email channel.
  if v_actor.role in ('owner', 'manager')
     and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    raise exception 'owner or manager PIN changes require MFA re-authentication'
      using errcode = '42501';
  end if;

  if p_user <> p_actor then
    v_actor_rank := case v_actor.role
      when 'owner' then 4 when 'manager' then 3
      when 'front_desk' then 2 when 'trainer' then 1 else 0 end;
    v_target_rank := case v_target.role
      when 'owner' then 4 when 'manager' then 3
      when 'front_desk' then 2 when 'trainer' then 1 else 0 end;
    if v_actor.role not in ('owner', 'manager') or v_actor_rank <= v_target_rank then
      raise exception 'only an owner or manager may set a lower-role PIN'
        using errcode = '42501';
    end if;
  end if;

  v_kind := case when v_target.step_up_pin_hash is null then 'set' else 'rotate' end;

  update public.tenant_users
  set step_up_pin_hash = p_pin_hash,
      step_up_pin_set_at = now(),
      step_up_fail_count = 0,
      step_up_locked_until = null
  where id = v_target.id;

  insert into public.step_up_events (tenant_id, tenant_user_id, kind)
  values (p_tenant, v_target.id, v_kind);

  -- step_up_events identifies the credential subject; audit_events preserves
  -- the authenticated actor when a manager sets a lower-role user's PIN.
  insert into public.audit_events
    (tenant_id, actor_user_id, actor_role, action, target_type, target_id, metadata)
  values
    (p_tenant, p_actor, v_actor.role, 'staff.step_up_pin_' || v_kind,
     'tenant_user', v_target.id::text, jsonb_build_object('subject_user_id', p_user));
end;
$$;

comment on function app.set_step_up_pin(uuid, uuid, text, uuid) is
  'Sole PIN set/rotate path: authenticated self, or owner/manager targeting a strictly lower role. No email-reset path exists.';

-- Records the result of the application-side constant-time scrypt comparison.
-- The membership row lock makes the five-failure counter shared and atomic.
create or replace function app.record_step_up_attempt(
  p_tenant uuid,
  p_user uuid,
  p_success boolean,
  p_context text,
  p_ip_hash text
)
returns table (
  locked_until timestamptz,
  fail_count int,
  remaining_attempts int,
  attempt_recorded boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.tenant_users%rowtype;
begin
  -- The comparison result is an authorization claim. Only the API's service
  -- client may submit it; an ordinary authenticated client must not be able
  -- to forge success and clear its own failure counter.
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    raise exception 'step-up outcomes may only be recorded by the API service role'
      using errcode = '42501';
  end if;
  if p_context is null or length(trim(p_context)) < 1 or length(p_context) > 100 then
    raise exception 'step-up action context is required' using errcode = '22023';
  end if;

  select tu.* into v_target
  from public.tenant_users tu
  where tu.tenant_id = p_tenant
    and tu.user_id = p_user
    and tu.status = 'active'
  for update;
  if not found then
    raise exception 'active membership not found' using errcode = 'P0002';
  end if;

  -- A concurrent fifth failure wins over an already-running comparison.
  if v_target.step_up_locked_until is not null
     and v_target.step_up_locked_until > now() then
    return query select v_target.step_up_locked_until, v_target.step_up_fail_count,
      0, false;
    return;
  end if;

  -- Once a prior 15-minute lock has elapsed, begin a fresh five-try window.
  if v_target.step_up_locked_until is not null then
    v_target.step_up_fail_count := 0;
    v_target.step_up_locked_until := null;
  end if;

  if p_success then
    update public.tenant_users
    set step_up_fail_count = 0, step_up_locked_until = null
    where id = v_target.id;
    insert into public.step_up_events
      (tenant_id, tenant_user_id, kind, action_context, ip_hash)
    values (p_tenant, v_target.id, 'verify_success', p_context, p_ip_hash);
    return query select null::timestamptz, 0, 5, true;
    return;
  end if;

  v_target.step_up_fail_count := v_target.step_up_fail_count + 1;
  if v_target.step_up_fail_count >= 5 then
    v_target.step_up_locked_until := now() + interval '15 minutes';
  end if;

  update public.tenant_users
  set step_up_fail_count = v_target.step_up_fail_count,
      step_up_locked_until = v_target.step_up_locked_until
  where id = v_target.id;

  insert into public.step_up_events
    (tenant_id, tenant_user_id, kind, action_context, ip_hash)
  values (p_tenant, v_target.id, 'verify_fail', p_context, p_ip_hash);

  if v_target.step_up_locked_until is not null then
    insert into public.step_up_events
      (tenant_id, tenant_user_id, kind, action_context, ip_hash)
    values (p_tenant, v_target.id, 'lockout', p_context, p_ip_hash);
  end if;

  return query select v_target.step_up_locked_until, v_target.step_up_fail_count,
    greatest(0, 5 - v_target.step_up_fail_count), true;
end;
$$;

comment on function app.record_step_up_attempt(uuid, uuid, boolean, text, text) is
  'Records an API-side scrypt comparison and atomically enforces the shared five-fail/15-minute lockout.';

create or replace function app.step_up_status(p_tenant uuid, p_user uuid)
returns table (pin_set boolean, locked_until timestamptz, fail_count int)
language sql
stable
security invoker
set search_path = ''
as $$
  select tu.step_up_pin_set_at is not null,
         case when tu.step_up_locked_until > now() then tu.step_up_locked_until else null end,
         case when tu.step_up_locked_until is not null
                   and tu.step_up_locked_until <= now() then 0
              else tu.step_up_fail_count end
  from public.tenant_users tu
  where tu.tenant_id = p_tenant
    and tu.user_id = p_user
    and tu.status = 'active';
$$;

-- PostgREST exposes public, not app. These invoker wrappers retain app.* as
-- the security boundary while making the RPCs callable by the API client.
create or replace function public.set_step_up_pin(
  p_tenant uuid, p_user uuid, p_pin_hash text, p_actor uuid
)
returns void language sql security invoker set search_path = ''
as $$ select app.set_step_up_pin(p_tenant, p_user, p_pin_hash, p_actor); $$;

create or replace function public.record_step_up_attempt(
  p_tenant uuid, p_user uuid, p_success boolean, p_context text, p_ip_hash text
)
returns table (
  locked_until timestamptz,
  fail_count int,
  remaining_attempts int,
  attempt_recorded boolean
)
language sql security invoker set search_path = ''
as $$ select * from app.record_step_up_attempt(p_tenant, p_user, p_success, p_context, p_ip_hash); $$;

create or replace function public.step_up_status(p_tenant uuid, p_user uuid)
returns table (pin_set boolean, locked_until timestamptz, fail_count int)
language sql stable security invoker set search_path = ''
as $$ select * from app.step_up_status(p_tenant, p_user); $$;

-- Remove direct credential-column writes. Role/status roster management keeps
-- its existing owner-only RLS path; the definer function above owns PIN writes.
revoke update on public.tenant_users from authenticated, service_role;
grant update (role, status) on public.tenant_users to authenticated, service_role;

-- Authenticated/browser clients can read roster state but never credential
-- material. The API's server-only service client owns the sole hash read and
-- still filters tenant_id + user_id explicitly.
revoke select on public.tenant_users from authenticated, service_role;
grant select (
  id, tenant_id, user_id, role, status, mfa_required, invited_by,
  created_at, updated_at, step_up_pin_set_at, step_up_locked_until,
  step_up_fail_count
) on public.tenant_users to authenticated;
grant select on public.tenant_users to service_role;

revoke all on function app.set_step_up_pin(uuid, uuid, text, uuid) from public;
revoke all on function app.record_step_up_attempt(uuid, uuid, boolean, text, text) from public;
revoke all on function app.step_up_status(uuid, uuid) from public;
grant execute on function app.set_step_up_pin(uuid, uuid, text, uuid)
  to authenticated, service_role;
grant execute on function app.record_step_up_attempt(uuid, uuid, boolean, text, text)
  to authenticated, service_role;
grant execute on function app.step_up_status(uuid, uuid)
  to authenticated, service_role;
revoke all on function public.set_step_up_pin(uuid, uuid, text, uuid) from public;
revoke all on function public.record_step_up_attempt(uuid, uuid, boolean, text, text) from public;
revoke all on function public.step_up_status(uuid, uuid) from public;
grant execute on function public.set_step_up_pin(uuid, uuid, text, uuid)
  to authenticated, service_role;
grant execute on function public.record_step_up_attempt(uuid, uuid, boolean, text, text)
  to authenticated, service_role;
grant execute on function public.step_up_status(uuid, uuid)
  to authenticated, service_role;
