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
-- (2) MATVIEW GUARD: matviews support neither RLS nor security_invoker, so
--     every matview in public OR app MUST be unreadable by client roles
--     (threat model §1); app matviews are read only through tenancy-verifying
--     definer functions (e.g. app.person_credit_balance over
--     app.credit_balances, migration 0008).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select schemaname, matviewname
    from pg_catalog.pg_matviews
    where schemaname in ('public', 'app')
  loop
    perform app_test.assert(
      not has_table_privilege('anon', format('%I.%I', r.schemaname, r.matviewname), 'select'),
      format('(2) matview %s.%s is readable by anon', r.schemaname, r.matviewname));
    perform app_test.assert(
      not has_table_privilege('authenticated', format('%I.%I', r.schemaname, r.matviewname), 'select'),
      format('(2) matview %s.%s is readable by authenticated', r.schemaname, r.matviewname));
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
-- (12) Member-read isolation on observability tables: seed one sync_state and
--      one alerts row per tenant (as superuser); uB must see ZERO of tenant
--      A's rows and exactly her own tenant's (member-readable, not world-).
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.sync_state (tenant_id, entity) values (v_a, 'members');
  insert into public.sync_state (tenant_id, entity) values (v_b, 'members');
  insert into public.alerts (tenant_id, kind, severity, title)
    values (v_a, 'import_failed', 'critical', 'tenant A alert');
  insert into public.alerts (tenant_id, kind, severity, title)
    values (v_b, 'import_failed', 'critical', 'tenant B alert');

  perform app_test.become(v_ub);
  select count(*) into n from public.sync_state where tenant_id = v_a;
  perform app_test.assert(n = 0, '(12) uB can SELECT tenant A sync_state');
  select count(*) into n from public.alerts where tenant_id = v_a;
  perform app_test.assert(n = 0, '(12) uB can SELECT tenant A alerts');
  select count(*) into n from public.sync_state where tenant_id = v_b;
  perform app_test.assert(n = 1, '(12) uB cannot read her OWN sync_state');
  select count(*) into n from public.alerts where tenant_id = v_b;
  perform app_test.assert(n = 1, '(12) uB cannot read her OWN alerts');
end
$$;

-- ---------------------------------------------------------------------------
-- (13) jobs/job_runs are service-role only: seed one of each (as superuser),
--      then as uB a SELECT must return 0 rows OR raise — leakage impossible
--      (deny-all policy + revoked grants). Probing a seeded row, not an empty
--      table, is what makes this a real leak test.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ub uuid; v_job uuid; n int := 0; raised boolean := false;
begin
  reset role;
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.jobs (kind) values ('noop') returning id into v_job;
  insert into public.job_runs (job_id, attempt, worker, status)
    values (v_job, 1, 'seed', 'running');

  perform app_test.become(v_ub);
  begin
    select count(*) into n from public.jobs;
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised or n = 0, '(13) uB can read public.jobs');

  n := 0; raised := false;
  begin
    select count(*) into n from public.job_runs;
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised or n = 0, '(13) uB can read public.job_runs');
end
$$;

-- ---------------------------------------------------------------------------
-- (14) Clients can read observability tables but NEVER write them, even for
--      their OWN tenant: uB's INSERT into sync_state/alerts must raise
--      (no client write policy, no grant — the service role writes).
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
    insert into public.sync_state (tenant_id, entity) values (v_b, 'payments');
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised, '(14) uB could INSERT into sync_state');

  raised := false;
  begin
    insert into public.alerts (tenant_id, kind, severity, title)
      values (v_b, 'forged', 'info', 'forged alert');
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised, '(14) uB could INSERT into alerts');
end
$$;

-- ---------------------------------------------------------------------------
-- (15) INTRA-TENANT: a MANAGER cannot escalate — tenant_users writes are
--      owner-only, so uM's self-promotion, self-deletion, and promotion of
--      another member must each match 0 rows (USING filters them silently).
--      Seeds uM as manager of tenant A (as superuser) for this and probe (16).
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ua uuid; v_um uuid; n int; v_role text;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a';

  insert into auth.users (id, email) values (gen_random_uuid(), 'um@example.test')
    returning id into v_um;
  insert into public.tenant_users (tenant_id, user_id, role)
    values (v_a, v_um, 'manager');
  insert into app_test.ctx (key, val) values ('user_m', v_um::text);

  -- self-escalation: manager → owner
  perform app_test.become(v_um);
  update public.tenant_users set role = 'owner' where user_id = v_um;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(15) manager uM could self-escalate to owner');
  reset role;
  select role into v_role from public.tenant_users
    where tenant_id = v_a and user_id = v_um;
  perform app_test.assert(v_role = 'manager',
    '(15) uM role was changed by the self-escalation attempt');

  -- self-removal: delete own membership row
  perform app_test.become(v_um);
  delete from public.tenant_users where user_id = v_um;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(15) manager uM could delete their own membership');
  reset role;
  select count(*) into n from public.tenant_users
    where tenant_id = v_a and user_id = v_um;
  perform app_test.assert(n = 1, '(15) uM membership row was deleted');

  -- promote someone else: still not owner, so also 0 rows
  perform app_test.become(v_um);
  update public.tenant_users set role = 'owner' where user_id = v_ua;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(15) manager uM could promote uA to owner');
  reset role;
  select role into v_role from public.tenant_users
    where tenant_id = v_a and user_id = v_ua;
  perform app_test.assert(v_role = 'owner',
    '(15) uA role was changed by the manager escalation attempt');
end
$$;

-- ---------------------------------------------------------------------------
-- (16) INTRA-TENANT: even an OWNER cannot modify their OWN membership row
--      (self-deactivation must match 0 rows) — but CAN modify OTHER members
--      (POSITIVE control: uA demotes uM to trainer, 1 row). Proves the
--      no-self rule without vacuously breaking owner administration.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_ua uuid; v_um uuid; n int; v_text text;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a';
  select val::uuid into v_um from app_test.ctx where key = 'user_m';

  perform app_test.become(v_ua);
  update public.tenant_users set status = 'deactivated' where user_id = v_ua;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(16) owner uA could modify their own membership row');
  reset role;
  select status into v_text from public.tenant_users
    where tenant_id = v_a and user_id = v_ua;
  perform app_test.assert(v_text = 'active',
    '(16) uA status was changed by the self-modification attempt');

  perform app_test.become(v_ua);
  update public.tenant_users set role = 'trainer' where user_id = v_um;
  get diagnostics n = row_count;
  perform app_test.assert(n = 1, '(16) owner uA could not modify another member (uM)');
  reset role;
  select role into v_text from public.tenant_users
    where tenant_id = v_a and user_id = v_um;
  perform app_test.assert(v_text = 'trainer',
    '(16) uM role was not updated by owner uA');
end
$$;

-- ---------------------------------------------------------------------------
-- (17) EVIDENCE FORGERY: an audit_events insert attributing the action to
--      SOMEONE ELSE must raise (WITH CHECK: actor = self or NULL); self- and
--      null-actor inserts must succeed (positive controls).
-- ---------------------------------------------------------------------------
do $$
declare
  v_b uuid; v_ua uuid; v_ub uuid; n int; raised boolean := false;
begin
  reset role;
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  perform app_test.become(v_ub);

  begin
    insert into public.audit_events (tenant_id, actor_user_id, action)
      values (v_b, v_ua, 'forged');
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised,
    '(17) uB could forge actor_user_id on audit_events');

  insert into public.audit_events (tenant_id, actor_user_id, action)
    values (v_b, v_ub, 'self-ok');
  get diagnostics n = row_count;
  perform app_test.assert(n = 1,
    '(17) uB could not insert a self-attributed audit event');

  insert into public.audit_events (tenant_id, actor_user_id, action)
    values (v_b, null, 'system-ok');
  get diagnostics n = row_count;
  perform app_test.assert(n = 1,
    '(17) uB could not insert a null-actor (system) audit event');
end
$$;

-- ---------------------------------------------------------------------------
-- (18) glofox_raw is service-only + APPEND-ONLY: seed one row for tenant B
--      (as superuser); as uB a SELECT must return 0 rows OR raise (deny-all
--      policy + revoked grants — probing a seeded row, not an empty table).
--      The append-only invariant is verified at the PRIVILEGE level (a
--      superuser bypasses RLS, so statement probes as superuser prove
--      nothing): no app role holds UPDATE/DELETE on the raw zone.
-- ---------------------------------------------------------------------------
do $$
declare
  v_b uuid; v_ub uuid; n int := 0; raised boolean := false;
begin
  reset role;
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.glofox_raw (tenant_id, endpoint, payload, payload_hash)
    values (v_b, 'members.list', '{"seed": true}', 'seed-hash');

  perform app_test.become(v_ub);
  begin
    select count(*) into n from public.glofox_raw;
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised or n = 0, '(18) uB can read public.glofox_raw');

  reset role;
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.glofox_raw', 'select'),
    '(18) authenticated holds SELECT on glofox_raw — raw zone is service-only');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.glofox_raw', 'update'),
    '(18) service_role holds UPDATE on glofox_raw — raw zone must be immutable');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.glofox_raw', 'delete'),
    '(18) service_role holds DELETE on glofox_raw — raw zone must be immutable');
end
$$;

-- ---------------------------------------------------------------------------
-- (19) import_quarantine: member-SELECT isolation + owner/manager resolution.
--      Seed one row per tenant (as superuser); uB (owner of B) sees ONLY her
--      own tenant's row, CAN resolve it (POSITIVE control, 1 row — the review
--      UI path), and CANNOT insert (must raise — the service role writes).
--      The column-list grant is asserted directly: resolution columns only.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int; raised boolean := false;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.import_quarantine (tenant_id, entity, external_ref, payload, reason)
    values (v_a, 'members', 'glofox-a-1', '{}', 'unknown glofox_event');
  insert into public.import_quarantine (tenant_id, entity, external_ref, payload, reason)
    values (v_b, 'members', 'glofox-b-1', '{}', 'unknown glofox_event');

  perform app_test.become(v_ub);
  select count(*) into n from public.import_quarantine where tenant_id = v_a;
  perform app_test.assert(n = 0, '(19) uB can SELECT tenant A import_quarantine');
  select count(*) into n from public.import_quarantine where tenant_id = v_b;
  perform app_test.assert(n = 1, '(19) uB cannot read her OWN import_quarantine');

  -- Positive control: an owner resolves her own tenant's row (review UI).
  update public.import_quarantine
    set status = 'resolved', resolved_at = now(), resolution_note = 'fixed mapping'
    where tenant_id = v_b;
  get diagnostics n = row_count;
  perform app_test.assert(n = 1,
    '(19) owner uB could not resolve her own quarantine row');

  -- No client INSERT, even for her own tenant (the service role writes).
  begin
    insert into public.import_quarantine (tenant_id, entity, payload, reason)
      values (v_b, 'members', '{}', 'forged');
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised, '(19) uB could INSERT into import_quarantine');

  reset role;
  perform app_test.assert(
    not has_column_privilege('authenticated', 'public.import_quarantine', 'payload', 'update'),
    '(19) authenticated holds column UPDATE on import_quarantine.payload — evidence must be immutable');
  perform app_test.assert(
    has_column_privilege('authenticated', 'public.import_quarantine', 'status', 'update'),
    '(19) authenticated lacks column UPDATE on import_quarantine.status — review UI cannot resolve');
end
$$;

-- ---------------------------------------------------------------------------
-- (20) People + plan_catalog slice (migration 0008): member-read isolation,
--      no client writes on people, and the A8 kelo_type column-grant scoping
--      on plan_catalog — asserted in both directions with a positive control.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int; raised boolean := false;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.people (tenant_id, first_name, external_ref)
    values (v_a, 'Alice', 'gf-a-1');
  insert into public.people (tenant_id, first_name, external_ref)
    values (v_b, 'Bob', 'gf-b-1');
  insert into public.plan_catalog (tenant_id, external_ref, name, plan_code, glofox_type)
    values (v_a, 'mem-a', 'Plan A', '100', 'time');
  insert into public.plan_catalog (tenant_id, external_ref, name, plan_code, glofox_type)
    values (v_b, 'mem-b', 'Plan B', '200', 'num_classes');

  perform app_test.become(v_ub);
  select count(*) into n from public.people where tenant_id = v_a;
  perform app_test.assert(n = 0, '(20) uB can SELECT tenant A people');
  select count(*) into n from public.people where tenant_id = v_b;
  perform app_test.assert(n = 1, '(20) uB cannot read her OWN people');

  begin
    insert into public.people (tenant_id, first_name) values (v_b, 'Forged');
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised, '(20) uB could INSERT into people');

  -- A8 mapping: owner updates kelo_type on her OWN tenant's row (positive
  -- control, 1 row) but a cross-tenant update matches 0 rows.
  update public.plan_catalog set kelo_type = 'unlimited' where tenant_id = v_b;
  get diagnostics n = row_count;
  perform app_test.assert(n = 1, '(20) owner uB could not set kelo_type on her own catalog');
  update public.plan_catalog set kelo_type = 'pack' where tenant_id = v_a;
  get diagnostics n = row_count;
  perform app_test.assert(n = 0, '(20) uB cross-tenant kelo_type update matched rows');

  reset role;
  perform app_test.assert(
    has_column_privilege('authenticated', 'public.plan_catalog', 'kelo_type', 'update'),
    '(20) authenticated lacks the kelo_type column grant — A8 mapping UI cannot work');
  perform app_test.assert(
    not has_column_privilege('authenticated', 'public.plan_catalog', 'name', 'update'),
    '(20) authenticated can UPDATE plan_catalog.name — imported catalog must be client-immutable');
  perform app_test.assert(
    not has_column_privilege('authenticated', 'public.plan_catalog', 'price', 'update'),
    '(20) authenticated can UPDATE plan_catalog.price — imported catalog must be client-immutable');
end
$$;

-- ---------------------------------------------------------------------------
-- (21) credit_ledger (invariant #6): member-read isolation; NO client INSERT;
--      append-only at the PRIVILEGE level — even service_role cannot
--      UPDATE/DELETE ledger rows.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; v_pa uuid; v_pb uuid; n int; raised boolean := false;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select id into v_pa from public.people where tenant_id = v_a limit 1;
  select id into v_pb from public.people where tenant_id = v_b limit 1;

  insert into public.credit_ledger (tenant_id, person_id, entry_type, delta, external_ref)
    values (v_a, v_pa, 'grant', 10, 'credit-a-1');
  insert into public.credit_ledger (tenant_id, person_id, entry_type, delta, external_ref)
    values (v_b, v_pb, 'grant', 5, 'credit-b-1');

  perform app_test.become(v_ub);
  select count(*) into n from public.credit_ledger where tenant_id = v_a;
  perform app_test.assert(n = 0, '(21) uB can SELECT tenant A credit_ledger');
  select count(*) into n from public.credit_ledger where tenant_id = v_b;
  perform app_test.assert(n = 1, '(21) uB cannot read her OWN credit_ledger');

  begin
    insert into public.credit_ledger (tenant_id, person_id, entry_type, delta)
      values (v_b, v_pb, 'grant', 99);
  exception
    when others then raised := true;
  end;
  perform app_test.assert(raised, '(21) uB could INSERT into credit_ledger');

  reset role;
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.credit_ledger', 'update'),
    '(21) service_role holds UPDATE on credit_ledger — the ledger must be append-only');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.credit_ledger', 'delete'),
    '(21) service_role holds DELETE on credit_ledger — the ledger must be append-only');
end
$$;

-- ---------------------------------------------------------------------------
-- (22) Facts slice (migration 0009) + the balance read path: transactions
--      member-isolation; app.credit_balances unreadable by every app role;
--      app.person_credit_balance returns own-tenant data (positive control)
--      and ZERO rows cross-tenant.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; v_pa uuid; v_pb uuid; n int; v_balance int;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select id into v_pa from public.people where tenant_id = v_a limit 1;
  select id into v_pb from public.people where tenant_id = v_b limit 1;

  insert into public.glofox_transactions
    (tenant_id, external_ref, transaction_status, amount, currency, glofox_event_class)
    values (v_a, 'txn-a-1', 'PAID', 42.00, 'USD', 'book_class');
  insert into public.glofox_transactions
    (tenant_id, external_ref, transaction_status, amount, currency, glofox_event_class)
    values (v_b, 'txn-b-1', 'ERROR', 30.00, 'USD', 'subscription_payment');

  -- Refresh the matview so the definer reader has rows (non-concurrent inside
  -- this transaction: the seeded ledger rows above are not yet visible to a
  -- concurrent refresh, and plain refresh is fine for the probe).
  refresh materialized view app.credit_balances;

  perform app_test.become(v_ub);
  select count(*) into n from public.glofox_transactions where tenant_id = v_a;
  perform app_test.assert(n = 0, '(22) uB can SELECT tenant A glofox_transactions');
  select count(*) into n from public.glofox_transactions where tenant_id = v_b;
  perform app_test.assert(n = 1, '(22) uB cannot read her OWN glofox_transactions');

  -- The balance read path: own tenant returns the seeded balance (positive
  -- control)…
  select balance into v_balance from app.person_credit_balance(v_b, v_pb);
  perform app_test.assert(v_balance = 5,
    '(22) person_credit_balance did not return uB''s own-tenant balance');
  -- …and a cross-tenant call returns ZERO ROWS (indistinguishable from empty).
  select count(*) into n from app.person_credit_balance(v_a, v_pa);
  perform app_test.assert(n = 0,
    '(22) person_credit_balance leaked a cross-tenant balance to uB');

  reset role;
  perform app_test.assert(
    not has_table_privilege('anon', 'app.credit_balances', 'select'),
    '(22) anon can read app.credit_balances');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'app.credit_balances', 'select'),
    '(22) authenticated can read app.credit_balances');
  perform app_test.assert(
    not has_table_privilege('service_role', 'app.credit_balances', 'select'),
    '(22) service_role can read app.credit_balances directly — the definer fn is the only path');
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
