-- supabase/tests/rls_attack.sql — portable cross-tenant attack suite.
--
-- No pgTAP, no Docker, no Supabase CLI. Runs anywhere via:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_attack.sql
-- Any failed assertion RAISEs EXCEPTION → psql exits non-zero → CI fails.
-- The whole file is wrapped in BEGIN … ROLLBACK: NON-DESTRUCTIVE, safe to run
-- against a shared dev branch.
--
-- Prerequisites: migrations applied. On plain Postgres also run
-- supabase/tests/_bootstrap.sql first (scripts/db-test.sh does both); on real
-- Supabase the auth shim already exists — run this file alone.

begin;

-- ---------------------------------------------------------------------------
-- Test scaffolding (lives only inside this transaction; rolled back at the end)
-- ---------------------------------------------------------------------------
create schema app_test;

create table app_test.ctx (key text primary key, val text not null);
create table app_test.log (msg text not null, at timestamptz not null default now());

-- Assertion helper. SECURITY DEFINER so the log insert works while the session
-- is impersonating anon/authenticated (they hold no privileges on app_test.log).
create or replace function app_test.assert(cond boolean, msg text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if cond is not true then
    raise exception 'RLS-FAIL: %', msg;
  end if;
  insert into app_test.log (msg) values (msg);
end;
$$;

-- "Become user": switch the local role + JWT claims so auth.uid()/auth.role()
-- and the RLS policies see this user. Effect lasts to end of transaction, so
-- every test block starts with `reset role` to get back to the superuser.
create or replace function app_test.become(p_user uuid, p_role text default 'authenticated')
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_role not in ('authenticated', 'anon') then
    raise exception 'become(): unsupported role %', p_role;
  end if;
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role)::text, true);
end;
$$;

revoke execute on function app_test.assert(boolean, text) from public;
revoke execute on function app_test.become(uuid, text) from public;
grant usage on schema app_test to authenticated, anon;
grant execute on function app_test.assert(boolean, text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- (1) GENERIC GUARD: every public table with a tenant_id column MUST have RLS
--     enabled AND at least one policy. A new tenant-scoped table missing either
--     fails the build here — invariant #7.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname, c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')          -- ordinary + partitioned tables
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        where a.attrelid = c.oid
          and a.attname = 'tenant_id'
          and a.attnum > 0
          and not a.attisdropped
      )
  loop
    perform app_test.assert(r.relrowsecurity,
      format('(1) public.%s has tenant_id but RLS is disabled', r.relname));
    perform app_test.assert(
      exists (select 1 from pg_catalog.pg_policies p
              where p.schemaname = 'public' and p.tablename = r.relname),
      format('(1) public.%s has tenant_id but no RLS policy', r.relname));
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) MATVIEW GUARD: matviews support neither RLS nor security_invoker, so any
--     public matview MUST be unreadable by client roles (threat model §1).
--     Phase 0 has none → no-op, but the guard must exist.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select matviewname from pg_catalog.pg_matviews where schemaname = 'public'
  loop
    perform app_test.assert(
      not has_table_privilege('anon', format('public.%I', r.matviewname), 'select'),
      format('(2) matview public.%s is readable by anon', r.matviewname));
    perform app_test.assert(
      not has_table_privilege('authenticated', format('public.%I', r.matviewname), 'select'),
      format('(2) matview public.%s is readable by authenticated', r.matviewname));
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Seed (as superuser): tenant A + tenant B, users uA/uB, memberships,
-- one location and one audit event per tenant.
-- ---------------------------------------------------------------------------
do $$
declare
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_user_a   uuid;
  v_user_b   uuid;
begin
  insert into public.tenants (name, slug) values ('Tenant A', 'tenant-a')
    returning id into v_tenant_a;
  insert into public.tenants (name, slug) values ('Tenant B', 'tenant-b')
    returning id into v_tenant_b;

  insert into auth.users (id, email) values (gen_random_uuid(), 'ua@example.test')
    returning id into v_user_a;
  insert into auth.users (id, email) values (gen_random_uuid(), 'ub@example.test')
    returning id into v_user_b;

  insert into public.tenant_users (tenant_id, user_id, role)
    values (v_tenant_a, v_user_a, 'owner');
  insert into public.tenant_users (tenant_id, user_id, role)
    values (v_tenant_b, v_user_b, 'owner');

  insert into public.locations (tenant_id, name, timezone)
    values (v_tenant_a, 'A HQ', 'America/New_York');
  insert into public.locations (tenant_id, name, timezone)
    values (v_tenant_b, 'B HQ', 'America/Chicago');

  insert into public.audit_events (tenant_id, actor_user_id, actor_role, action)
    values (v_tenant_a, v_user_a, 'owner', 'seed');
  insert into public.audit_events (tenant_id, actor_user_id, actor_role, action)
    values (v_tenant_b, v_user_b, 'owner', 'seed');

  insert into app_test.ctx (key, val) values
    ('tenant_a', v_tenant_a::text),
    ('tenant_b', v_tenant_b::text),
    ('user_a',   v_user_a::text),
    ('user_b',   v_user_b::text);
end
$$;

-- ---------------------------------------------------------------------------
-- (3) Cross-tenant SELECT: uB must see zero of tenant A's locations.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ub uuid; n int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  select count(*) into n from public.locations where tenant_id = v_a;
  perform app_test.assert(n = 0, '(3) uB can SELECT tenant A locations');
end
$$;

-- ---------------------------------------------------------------------------
-- (4) Cross-tenant SELECT on tenant_users.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ub uuid; n int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  select count(*) into n from public.tenant_users where tenant_id = v_a;
  perform app_test.assert(n = 0, '(4) uB can SELECT tenant A tenant_users');
end
$$;

-- ---------------------------------------------------------------------------
-- (5) Cross-tenant SELECT on audit_events.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ub uuid; n int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  select count(*) into n from public.audit_events where tenant_id = v_a;
  perform app_test.assert(n = 0, '(5) uB can SELECT tenant A audit_events');
end
$$;

-- ---------------------------------------------------------------------------
-- (6) Cross-tenant INSERT into locations MUST raise (RLS with-check).
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ub uuid; raised boolean := false;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  begin
    insert into public.locations (tenant_id, name, timezone)
      values (v_a, 'x', 'America/New_York');
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised, '(6) uB could INSERT a location into tenant A');
end
$$;

-- ---------------------------------------------------------------------------
-- (7) Cross-tenant UPDATE must affect 0 rows and leave A's data unchanged.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ub uuid; n int; v_name text;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  update public.locations set name = 'hacked' where tenant_id = v_a;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(7) uB cross-tenant UPDATE matched rows');
  reset role;
  select name into v_name from public.locations where tenant_id = v_a;
  perform app_test.assert(v_name = 'A HQ',
    '(7) tenant A location name was changed by uB');
end
$$;

-- ---------------------------------------------------------------------------
-- (8) Cross-tenant DELETE must affect 0 rows; A's location must still exist.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ub uuid; n int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  delete from public.locations where tenant_id = v_a;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(8) uB cross-tenant DELETE matched rows');
  reset role;
  select count(*) into n from public.locations where tenant_id = v_a;
  perform app_test.assert(n = 1, '(8) tenant A location was deleted by uB');
end
$$;

-- ---------------------------------------------------------------------------
-- (9) Helper re-verification: as uB, has_tenant_role(A, owner) is false and
--     current_tenant_ids() contains B and NOT A.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);
  perform app_test.assert(not app.has_tenant_role(v_a, array['owner']),
    '(9) has_tenant_role(A, owner) is true for uB');
  select count(*) into n from app.current_tenant_ids() t where t = v_b;
  perform app_test.assert(n = 1, '(9) current_tenant_ids() missing tenant B for uB');
  select count(*) into n from app.current_tenant_ids() t where t = v_a;
  perform app_test.assert(n = 0, '(9) current_tenant_ids() contains tenant A for uB');
end
$$;

-- ---------------------------------------------------------------------------
-- (10) Append-only evidence: even for uB's OWN tenant, UPDATE and DELETE on
--      audit_events MUST raise (privilege revoked from all app roles).
-- ---------------------------------------------------------------------------
do $$
declare
  v_b uuid; v_ub uuid; raised boolean;
begin
  reset role;
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);

  raised := false;
  begin
    update public.audit_events set action = 'x' where tenant_id = v_b;
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised,
    '(10) uB could UPDATE audit_events — append-only violated');

  raised := false;
  begin
    delete from public.audit_events where tenant_id = v_b;
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised,
    '(10) uB could DELETE audit_events — append-only violated');
end
$$;

-- ---------------------------------------------------------------------------
-- (11) anon with null JWT claims: SELECT on tenant_users returns 0 rows OR
--      raises permission denied — either is acceptable, leakage is not.
-- ---------------------------------------------------------------------------
do $$
declare
  n int; raised boolean := false;
begin
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', 'null', true);
  begin
    select count(*) into n from public.tenant_users;
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised or n = 0, '(11) anon can read tenant_users');
end
$$;

-- ---------------------------------------------------------------------------
-- Verdict
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  reset role;
  select count(*) into n from app_test.log;
  raise notice 'RLS ATTACK SUITE PASSED (%)', n;
end
$$;

rollback;
