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
-- (23) Trust-engine tables (migration 0011): reconciliations + import_snapshots
--      are member-read, service-write. Seed one row per tenant; uB sees only
--      her own and cannot insert (the service role writes).
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int; raised boolean := false;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.reconciliations (tenant_id, entity, status) values (v_a, 'members', 'match');
  insert into public.reconciliations (tenant_id, entity, status) values (v_b, 'members', 'drift');
  insert into public.import_snapshots (tenant_id, entity, external_refs, ref_count)
    values (v_a, 'members', array['a1'], 1);
  insert into public.import_snapshots (tenant_id, entity, external_refs, ref_count)
    values (v_b, 'members', array['b1'], 1);

  perform app_test.become(v_ub);
  select count(*) into n from public.reconciliations where tenant_id = v_a;
  perform app_test.assert(n = 0, '(23) uB can SELECT tenant A reconciliations');
  select count(*) into n from public.reconciliations where tenant_id = v_b;
  perform app_test.assert(n = 1, '(23) uB cannot read her OWN reconciliations');
  select count(*) into n from public.import_snapshots where tenant_id = v_a;
  perform app_test.assert(n = 0, '(23) uB can SELECT tenant A import_snapshots');

  begin
    insert into public.reconciliations (tenant_id, entity, status) values (v_b, 'forged', 'match');
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(23) uB could INSERT into reconciliations');
end
$$;

-- ---------------------------------------------------------------------------
-- (24) deletion_candidates: member-read isolation; owner/manager may resolve
--      via the `status` COLUMN grant ONLY (positive control); no client INSERT;
--      the evidence column external_ref is NOT client-updatable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int; raised boolean := false;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.deletion_candidates (tenant_id, entity, external_ref, first_missing_at)
    values (v_a, 'members', 'gone-a', now());
  insert into public.deletion_candidates (tenant_id, entity, external_ref, first_missing_at)
    values (v_b, 'members', 'gone-b', now());

  perform app_test.become(v_ub);
  select count(*) into n from public.deletion_candidates where tenant_id = v_a;
  perform app_test.assert(n = 0, '(24) uB can SELECT tenant A deletion_candidates');
  select count(*) into n from public.deletion_candidates where tenant_id = v_b;
  perform app_test.assert(n = 1, '(24) uB cannot read her OWN deletion_candidates');

  -- Positive control: owner resolves her own tenant's candidate via `status`.
  update public.deletion_candidates set status = 'dismissed' where tenant_id = v_b;
  get diagnostics n = row_count;
  perform app_test.assert(n = 1, '(24) owner uB could not dismiss her own deletion candidate');

  begin
    insert into public.deletion_candidates (tenant_id, entity, external_ref, first_missing_at)
      values (v_b, 'members', 'forged', now());
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(24) uB could INSERT into deletion_candidates');

  reset role;
  perform app_test.assert(
    has_column_privilege('authenticated', 'public.deletion_candidates', 'status', 'update'),
    '(24) authenticated lacks the status column grant — the review UI cannot resolve');
  perform app_test.assert(
    not has_column_privilege('authenticated', 'public.deletion_candidates', 'external_ref', 'update'),
    '(24) authenticated can UPDATE deletion_candidates.external_ref — evidence must be immutable');
end
$$;

-- ---------------------------------------------------------------------------
-- (25) Relationship typing (migration 0012): person_relationships +
--      person_relationship_log are member-read, service-write; the log is
--      append-only even for service_role. Seed one row per tenant; uB sees
--      only her own and cannot insert.
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

  insert into public.person_relationships (tenant_id, person_id, relationship_type, rule_version)
    values (v_a, v_pa, 'recurring_member', 1);
  insert into public.person_relationships (tenant_id, person_id, relationship_type, rule_version)
    values (v_b, v_pb, 'pack_holder', 1);
  insert into public.person_relationship_log (tenant_id, person_id, to_primary, rule_version)
    values (v_a, v_pa, 'recurring_member', 1);
  insert into public.person_relationship_log (tenant_id, person_id, to_primary, rule_version)
    values (v_b, v_pb, 'pack_holder', 1);

  perform app_test.become(v_ub);
  select count(*) into n from public.person_relationships where tenant_id = v_a;
  perform app_test.assert(n = 0, '(25) uB can SELECT tenant A person_relationships');
  select count(*) into n from public.person_relationships where tenant_id = v_b;
  perform app_test.assert(n = 1, '(25) uB cannot read her OWN person_relationships');
  select count(*) into n from public.person_relationship_log where tenant_id = v_a;
  perform app_test.assert(n = 0, '(25) uB can SELECT tenant A person_relationship_log');

  begin
    insert into public.person_relationships (tenant_id, person_id, relationship_type, rule_version)
      values (v_b, v_pb, 'guest', 1);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(25) uB could INSERT into person_relationships');

  -- The transition log is append-only even for the OWNING tenant's owner.
  raised := false;
  begin
    update public.person_relationship_log set to_primary = 'x' where tenant_id = v_b;
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(25) uB could UPDATE person_relationship_log — append-only violated');

  reset role;
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.person_relationship_log', 'update'),
    '(25) service_role holds UPDATE on person_relationship_log — the transition log must be append-only');
end
$$;

-- ---------------------------------------------------------------------------
-- Verdict
-- ---------------------------------------------------------------------------
-- (26) APPEND-ONLY GRANT GUARD (invariant #6: ledgers/evidence are append-only).
--      Every append-only table must deny UPDATE and DELETE to every client role
--      (anon, authenticated, service_role) — inserts + the definer/owner append,
--      but history is never rewritten. A migration that accidentally grants
--      write to one of these (e.g. `grant update on public.credit_ledger`) fails
--      HERE, not in production.
--
--      The explicit list is the FLOOR: it also covers the pre-convention ledgers
--      (credit_ledger, audit_events, person_relationship_log, briefing_feedback,
--      campaign_attributions) whose table comments predate the APPEND-ONLY
--      marker. Part (b) adds a comment-driven anti-drift meta-guard so the list
--      can't silently fall behind: any table that DECLARES itself append-only in
--      its comment must appear in the list. (A pure comment sweep is unsafe on
--      its own — it would false-positive `bookings`, whose comment merely names
--      the append-only DEBIT it links while its own status legitimately mutates.)
do $$
declare
  append_only_tables text[] := array[
    'credit_ledger', 'gift_card_ledger', 'waiver_signatures', 'audit_events',
    'communication_consents', 'step_up_events', 'person_relationship_log',
    'briefing_feedback', 'campaign_attributions', 'person_deletions',
    'ask_misses', 'schedule_publish_log', 'plan_prices', 'dunning_states',
    'verify_runs', 'authority_flips', 'member_verification_events', 'claim_codes'
  ];
  -- Tables whose comment mentions "append-only" descriptively, not as a
  -- privilege claim on themselves (bookings: RPC-written, status advances).
  excused text[] := array['bookings'];
  t text;
  role_name text;
  r record;
begin
  reset role;

  -- (a) the guarantee — every listed table denies UPDATE + DELETE to every role.
  foreach t in array append_only_tables loop
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      perform app_test.assert(
        not has_table_privilege(role_name, format('public.%I', t), 'UPDATE'),
        format('(26) append-only public.%s grants UPDATE to %s', t, role_name));
      perform app_test.assert(
        not has_table_privilege(role_name, format('public.%I', t), 'DELETE'),
        format('(26) append-only public.%s grants DELETE to %s', t, role_name));
    end loop;
  end loop;

  -- (b) anti-drift meta-guard — a new ledger tagged APPEND-ONLY in its comment
  --     but forgotten from the list above fails HERE (never silently unguarded).
  for r in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and obj_description(c.oid) ilike '%append-only%'
  loop
    if not (r.relname = any(excused)) then
      perform app_test.assert(r.relname = any(append_only_tables),
        format('(26) public.%s declares itself APPEND-ONLY but is missing from the grant-guard list', r.relname));
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- (27) BILLING CORE (migration 0033): the money spine. Member-read isolation +
--      NO client write path across stripe_accounts/plans/plan_prices/customers/
--      stripe_commands/payments/idempotency_keys; the stripe_events inbox is
--      deny-all; plan_prices is append-only even for the owning tenant's owner,
--      and superseded_at moves ONLY through the definer. Seed one row per tenant
--      (as superuser); uB sees only her own and can forge nothing.
--      (invariant #7: every new table gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; v_pb uuid;
  v_plan_a uuid; v_plan_b uuid; v_price_b uuid; v_cust_b uuid; v_cmd_b uuid;
  v_ts timestamptz; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select id into v_pb from public.people where tenant_id = v_b limit 1;

  insert into public.stripe_accounts (tenant_id) values (v_a);
  insert into public.stripe_accounts (tenant_id) values (v_b);
  insert into public.plans (tenant_id, kelo_type, name) values (v_a, 'recurring', 'Plan A')
    returning id into v_plan_a;
  insert into public.plans (tenant_id, kelo_type, name) values (v_b, 'recurring', 'Plan B')
    returning id into v_plan_b;
  insert into public.plan_prices (tenant_id, plan_id, amount_cents, interval)
    values (v_a, v_plan_a, 9900, 'month');
  insert into public.plan_prices (tenant_id, plan_id, amount_cents, interval)
    values (v_b, v_plan_b, 9900, 'month') returning id into v_price_b;
  insert into public.customers (tenant_id, person_id) values (v_b, v_pb)
    returning id into v_cust_b;
  insert into public.stripe_commands (tenant_id, kind, idempotency_key)
    values (v_a, 'create_payment_intent', 'a-1');
  insert into public.stripe_commands (tenant_id, kind, idempotency_key)
    values (v_b, 'create_payment_intent', 'b-1') returning id into v_cmd_b;
  insert into public.payments (tenant_id, customer_id, amount_cents, status, command_id)
    values (v_a, null, 9900, 'processing', null);
  insert into public.payments (tenant_id, customer_id, amount_cents, status, command_id)
    values (v_b, v_cust_b, 9900, 'processing', v_cmd_b);
  insert into public.idempotency_keys (tenant_id, key, request_hash)
    values (v_a, 'req-a', 'hash-a');
  insert into public.idempotency_keys (tenant_id, key, request_hash)
    values (v_b, 'req-b', 'hash-b');
  insert into public.stripe_events (event_id, type, payload)
    values ('evt_seed_b', 'payment_intent.succeeded', '{}');

  perform app_test.become(v_ub);

  -- Member-read isolation: zero of A's rows, exactly her own.
  select count(*) into n from public.stripe_accounts where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A stripe_accounts');
  select count(*) into n from public.plans where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A plans');
  select count(*) into n from public.plan_prices where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A plan_prices');
  select count(*) into n from public.customers where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A customers');
  select count(*) into n from public.stripe_commands where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A stripe_commands');
  select count(*) into n from public.payments where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A payments');
  select count(*) into n from public.idempotency_keys where tenant_id = v_a;
  perform app_test.assert(n = 0, '(27) uB can SELECT tenant A idempotency_keys');
  select count(*) into n from public.payments where tenant_id = v_b;
  perform app_test.assert(n = 1, '(27) uB cannot read her OWN payments');

  -- The webhook inbox is deny-all: even own-tenant probing yields nothing.
  n := 0; raised := false;
  begin
    select count(*) into n from public.stripe_events;
  exception when others then raised := true;
  end;
  perform app_test.assert(raised or n = 0, '(27) uB can read public.stripe_events');

  -- No client write path for money, even for her OWN tenant.
  raised := false;
  begin
    insert into public.payments (tenant_id, amount_cents, status)
      values (v_b, 100, 'succeeded');
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(27) uB could INSERT into payments');

  raised := false;
  begin
    insert into public.stripe_commands (tenant_id, kind, idempotency_key)
      values (v_b, 'create_refund', 'forged');
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(27) uB could INSERT into stripe_commands');

  raised := false;
  begin
    insert into public.plan_prices (tenant_id, plan_id, amount_cents)
      values (v_b, v_plan_b, 1);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(27) uB could INSERT into plan_prices');

  -- Price history is append-only even for the owning tenant's owner.
  raised := false;
  begin
    update public.plan_prices set amount_cents = 1 where tenant_id = v_b;
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(27) uB could UPDATE plan_prices — prices must be immutable');

  reset role;
  -- plan_prices is append-only at the PRIVILEGE level (service_role included);
  -- superseded_at moves only through the definer app.supersede_plan_price.
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.plan_prices', 'update'),
    '(27) service_role holds UPDATE on plan_prices — the definer is the only writer');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.plan_prices', 'delete'),
    '(27) service_role holds DELETE on plan_prices — price history is append-only');
  -- payments carries a webhook-flipped status — the service role writes it, but
  -- no client role may INSERT money (no optimistic UI for money).
  perform app_test.assert(
    has_table_privilege('service_role', 'public.payments', 'update'),
    '(27) service_role lacks UPDATE on payments — the webhook cannot confirm');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.payments', 'insert'),
    '(27) authenticated holds INSERT on payments — money has no optimistic client write');

  -- Positive control: the definer closes a price phase (superseded_at set)
  -- without any client UPDATE grant. Clear the JWT so the service-role branch
  -- runs (auth.uid() null → no interactive role check).
  perform set_config('request.jwt.claims', 'null', true);
  perform app.supersede_plan_price(v_b, v_price_b);
  select superseded_at into v_ts from public.plan_prices where id = v_price_b;
  perform app_test.assert(v_ts is not null,
    '(27) app.supersede_plan_price did not set superseded_at');
end
$$;

-- ---------------------------------------------------------------------------
-- (28) PAYMENT-INTENT + REFUND RPCs (migration 0034): the intent layer that
--      feeds the outbox. Proves cross-tenant + actor-binding refusal,
--      (tenant_id, idempotency_key) idempotency (a duplicate returns the same
--      result and never writes a second command), the refundable ceiling + the
--      succeeded precondition, and — the money invariant — that create_refund
--      NEVER flips the payment status (the webhook is the confirmation
--      authority). Reuses block-27 seeds (customer, the processing payment);
--      seeds one succeeded payment (superuser) for the refund path.
--      (invariant #5/#7: every new RPC gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ua uuid; v_ub uuid;
  v_cust_b uuid; v_succ uuid; v_proc uuid;
  v_pay uuid; v_pay2 uuid; v_cmd uuid; v_cmd2 uuid;
  v_status text; v_msg text; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select id into v_cust_b from public.customers where tenant_id = v_b limit 1;
  select id into v_proc from public.payments
    where tenant_id = v_b and status = 'processing' limit 1;
  insert into public.payments (tenant_id, customer_id, amount_cents, currency, status)
    values (v_b, v_cust_b, 8000, 'usd', 'succeeded') returning id into v_succ;

  perform app_test.become(v_ub);

  -- Positive: uB (owner of B) records an intent for her own tenant + customer.
  v_pay := app.create_payment_intent(v_b, v_cust_b, 5000, 'usd', 'pi-b-1', v_ub);
  perform app_test.assert(v_pay is not null, '(28) create_payment_intent returned null');
  select count(*) into n from public.stripe_commands
    where tenant_id = v_b and idempotency_key = 'pi-b-1' and kind = 'create_payment_intent';
  perform app_test.assert(n = 1, '(28) create_payment_intent did not write exactly one command');
  select count(*) into n from public.payments
    where tenant_id = v_b and id = v_pay and status = 'requires_payment';
  perform app_test.assert(n = 1,
    '(28) create_payment_intent did not write a requires_payment payment');

  -- Idempotent on (tenant, key): a duplicate returns the SAME payment, no 2nd command.
  v_pay2 := app.create_payment_intent(v_b, v_cust_b, 5000, 'usd', 'pi-b-1', v_ub);
  perform app_test.assert(v_pay2 = v_pay, '(28) duplicate key returned a different payment');
  select count(*) into n from public.stripe_commands
    where tenant_id = v_b and idempotency_key = 'pi-b-1' and kind = 'create_payment_intent';
  perform app_test.assert(n = 1, '(28) duplicate create_payment_intent wrote a second command');

  -- Cross-tenant: uB cannot record an intent for tenant A (role re-check → 42501).
  raised := false;
  begin
    perform app.create_payment_intent(v_a, v_cust_b, 5000, 'usd', 'pi-x', v_ub);
  exception when insufficient_privilege then raised := true;
  end;
  perform app_test.assert(raised, '(28) uB could create_payment_intent for tenant A');

  -- A customer that is not tenant B's is rejected (P0002 = customer not found).
  raised := false;
  begin
    perform app.create_payment_intent(v_b, gen_random_uuid(), 5000, 'usd', 'pi-y', v_ub);
  exception when no_data_found then raised := true;
  end;
  perform app_test.assert(raised, '(28) create_payment_intent accepted a foreign customer');

  -- Actor spoof: the actor must be the authenticated caller (42501).
  raised := false;
  begin
    perform app.create_payment_intent(v_b, v_cust_b, 5000, 'usd', 'pi-z', v_ua);
  exception when insufficient_privilege then raised := true;
  end;
  perform app_test.assert(raised, '(28) create_payment_intent accepted a spoofed actor');

  -- Refund a succeeded payment within the refundable ceiling.
  v_cmd := app.create_refund(v_b, v_succ, 3000, 'rf-b-1', v_ub, 'partial');
  perform app_test.assert(v_cmd is not null, '(28) create_refund returned null');
  select count(*) into n from public.stripe_commands
    where tenant_id = v_b and idempotency_key = 'rf-b-1' and kind = 'create_refund';
  perform app_test.assert(n = 1, '(28) create_refund did not write exactly one command');

  -- THE money invariant: the payment status is untouched — the webhook flips it.
  select status into v_status from public.payments where id = v_succ;
  perform app_test.assert(v_status = 'succeeded',
    '(28) create_refund flipped the payment status — only the webhook is the authority');

  -- Idempotent refund: a duplicate key returns the same command, no 2nd command.
  v_cmd2 := app.create_refund(v_b, v_succ, 3000, 'rf-b-1', v_ub, 'partial');
  perform app_test.assert(v_cmd2 = v_cmd, '(28) duplicate refund key returned a different command');
  select count(*) into n from public.stripe_commands
    where tenant_id = v_b and idempotency_key = 'rf-b-1' and kind = 'create_refund';
  perform app_test.assert(n = 1, '(28) duplicate create_refund wrote a second command');

  -- Over-refund: remaining is 8000 - 3000 = 5000; 6000 must be refused on THAT
  -- exact ground (22023 + message), not merely "some error".
  raised := false; v_msg := '';
  begin
    perform app.create_refund(v_b, v_succ, 6000, 'rf-b-2', v_ub, null);
  exception when invalid_parameter_value then raised := true; v_msg := sqlerrm;
  end;
  perform app_test.assert(raised and v_msg like '%refund exceeds refundable%',
    '(28) create_refund allowed exceeding the refundable amount');

  -- A non-succeeded (processing) payment cannot be refunded (22023 + message).
  raised := false; v_msg := '';
  begin
    perform app.create_refund(v_b, v_proc, 100, 'rf-proc', v_ub, null);
  exception when invalid_parameter_value then raised := true; v_msg := sqlerrm;
  end;
  perform app_test.assert(raised and v_msg like '%only a succeeded payment%',
    '(28) create_refund allowed refunding a non-succeeded payment');

  -- Cross-tenant refund is refused (role re-check → 42501).
  raised := false;
  begin
    perform app.create_refund(v_a, v_succ, 100, 'rf-x', v_ub, null);
  exception when insufficient_privilege then raised := true;
  end;
  perform app_test.assert(raised, '(28) uB could create_refund against tenant A');
end
$$;

-- ---------------------------------------------------------------------------
-- (29) SUBSCRIPTIONS + THE DUNNING LEDGER (migration 0037). Member-read
--      isolation + NO client write path on subscriptions/dunning_states; the
--      dunning ledger is APPEND-ONLY for EVERY role (service_role included); the
--      subscriptions.status is webhook-synced (service writes, no client insert);
--      the one-live-sub partial unique holds; and app.record_dunning_stage (the
--      SOLE dunning writer, definer) advances the ledger + subscription status.
--      Reuses block-27's plans/prices/customers seeds (same transaction).
--      (invariant #5/#6/#7: every new table/RPC gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; v_pa uuid;
  v_cust_a uuid; v_cust_b uuid;
  v_plan_a uuid; v_plan_b uuid; v_price_a uuid; v_price_b uuid;
  v_sub_a uuid; v_sub_b uuid;
  v_status text; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select id into v_pa from public.people where tenant_id = v_a limit 1;
  select id into v_cust_b from public.customers where tenant_id = v_b limit 1;
  select id into v_plan_a from public.plans where tenant_id = v_a limit 1;
  select id into v_plan_b from public.plans where tenant_id = v_b limit 1;
  select id into v_price_a from public.plan_prices where tenant_id = v_a limit 1;
  select id into v_price_b from public.plan_prices where tenant_id = v_b limit 1;
  -- Tenant A needs its own customer (block 27 only seeded B's).
  insert into public.customers (tenant_id, person_id) values (v_a, v_pa)
    returning id into v_cust_a;

  insert into public.subscriptions (tenant_id, customer_id, plan_id, plan_price_id, status)
    values (v_a, v_cust_a, v_plan_a, v_price_a, 'active') returning id into v_sub_a;
  insert into public.subscriptions (tenant_id, customer_id, plan_id, plan_price_id, status)
    values (v_b, v_cust_b, v_plan_b, v_price_b, 'past_due') returning id into v_sub_b;
  insert into public.dunning_states (tenant_id, subscription_id, stage)
    values (v_a, v_sub_a, 'grace_started');
  insert into public.dunning_states (tenant_id, subscription_id, stage)
    values (v_b, v_sub_b, 'past_due');

  perform app_test.become(v_ub);

  -- Member-read isolation: zero of A's rows, exactly her own.
  select count(*) into n from public.subscriptions where tenant_id = v_a;
  perform app_test.assert(n = 0, '(29) uB can SELECT tenant A subscriptions');
  select count(*) into n from public.dunning_states where tenant_id = v_a;
  perform app_test.assert(n = 0, '(29) uB can SELECT tenant A dunning_states');
  select count(*) into n from public.subscriptions where tenant_id = v_b;
  perform app_test.assert(n = 1, '(29) uB cannot read her OWN subscriptions');

  -- No client write path: subscriptions are webhook-synced, the ledger is service-only.
  raised := false;
  begin
    insert into public.subscriptions (tenant_id, customer_id, plan_id, plan_price_id, status)
      values (v_b, v_cust_b, v_plan_b, v_price_b, 'active');
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(29) uB could INSERT into subscriptions');

  raised := false;
  begin
    insert into public.dunning_states (tenant_id, subscription_id, stage)
      values (v_b, v_sub_b, 'recovered');
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(29) uB could INSERT into dunning_states');

  reset role;
  -- The dunning ledger is append-only at the PRIVILEGE level (service_role too).
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.dunning_states', 'update'),
    '(29) service_role holds UPDATE on dunning_states — the ledger is append-only');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.dunning_states', 'delete'),
    '(29) service_role holds DELETE on dunning_states — the ledger is append-only');
  -- subscriptions.status is webhook-synced: the service role writes it; no client insert.
  perform app_test.assert(
    has_table_privilege('service_role', 'public.subscriptions', 'update'),
    '(29) service_role lacks UPDATE on subscriptions — the webhook cannot sync status');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.subscriptions', 'insert'),
    '(29) authenticated holds INSERT on subscriptions — no optimistic client write');

  -- The one-live-sub partial unique: a second LIVE sub for the same (tenant,
  -- customer, plan) is refused (v_sub_a is already 'active').
  raised := false;
  begin
    insert into public.subscriptions (tenant_id, customer_id, plan_id, plan_price_id, status)
      values (v_a, v_cust_a, v_plan_a, v_price_a, 'active');
  exception when others then raised := true;
  end;
  perform app_test.assert(raised,
    '(29) a second live subscription for the same plan+customer was allowed');

  -- Positive control: app.record_dunning_stage (definer, the sole writer) advances
  -- the ledger AND flips subscription status. Clear the JWT so the service branch runs.
  perform set_config('request.jwt.claims', 'null', true);
  perform app.record_dunning_stage(v_a, v_sub_a, 'past_due', null, now(), null, '{}'::jsonb);
  select status into v_status from public.subscriptions where id = v_sub_a;
  perform app_test.assert(v_status = 'past_due',
    '(29) app.record_dunning_stage did not flip subscription status to past_due');
  select count(*) into n from public.dunning_states
    where subscription_id = v_sub_a and stage = 'past_due';
  perform app_test.assert(n = 1, '(29) app.record_dunning_stage did not append the past_due stage');

  -- Idempotent: a re-call at the current latest stage appends NO duplicate.
  perform app.record_dunning_stage(v_a, v_sub_a, 'past_due', null, now(), null, '{}'::jsonb);
  select count(*) into n from public.dunning_states
    where subscription_id = v_sub_a and stage = 'past_due';
  perform app_test.assert(n = 1, '(29) app.record_dunning_stage appended a DUPLICATE past_due stage');
end
$$;

-- ---------------------------------------------------------------------------
-- (30) verify_runs (migration 0036): the nightly money-verification history.
--      Member-read isolation (a tenant sees ONLY its own runs); a GLOBAL run
--      (tenant_id null) matches no membership and stays hidden; NO client write
--      path. Reuses block-27's tenants; verify_runs has no unique(tenant_id)/
--      event_id, so there is nothing to collide with. (invariant #7.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  insert into public.verify_runs (tenant_id, started_at, finished_at, ok, violations)
    values (v_a, now(), now(), true, '[]');
  insert into public.verify_runs (tenant_id, started_at, finished_at, ok, violations)
    values (v_b, now(), now(), false, '[{"check":"over_refund"}]');
  -- The real cadence writes GLOBAL runs (tenant null) — those must be invisible.
  insert into public.verify_runs (tenant_id, started_at, finished_at, ok, violations)
    values (null, now(), now(), true, '[]');

  perform app_test.become(v_ub);

  -- Isolation: uB sees only her own run, never tenant A's nor the global one.
  select count(*) into n from public.verify_runs where tenant_id = v_a;
  perform app_test.assert(n = 0, '(30) uB can SELECT tenant A verify_runs');
  select count(*) into n from public.verify_runs where tenant_id is null;
  perform app_test.assert(n = 0, '(30) uB can SELECT global (null-tenant) verify_runs');
  select count(*) into n from public.verify_runs where tenant_id = v_b;
  perform app_test.assert(n = 1, '(30) uB cannot read her OWN verify_runs');

  -- No client write path (the service role writes run history).
  raised := false;
  begin
    insert into public.verify_runs (tenant_id, started_at, ok)
      values (v_b, now(), true);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(30) uB could INSERT into verify_runs');

  reset role;
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.verify_runs', 'insert'),
    '(30) authenticated holds INSERT on verify_runs — run history is service-written');
  perform app_test.assert(
    has_table_privilege('service_role', 'public.verify_runs', 'insert'),
    '(30) service_role lacks INSERT on verify_runs — verify_money cannot record a run');

  -- APPEND-ONCE (F4, invariant #6): a completed run is a fact, never edited —
  -- UPDATE and DELETE are revoked from EVERY role INCLUDING service_role (the
  -- repo ledger pattern; block 26 also lists verify_runs — keep consistent).
  declare
    role_name text;
  begin
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      perform app_test.assert(
        not has_table_privilege(role_name, 'public.verify_runs', 'update'),
        format('(30) verify_runs grants UPDATE to %s — runs are append-once', role_name));
      perform app_test.assert(
        not has_table_privilege(role_name, 'public.verify_runs', 'delete'),
        format('(30) verify_runs grants DELETE to %s — runs are append-once', role_name));
    end loop;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- (31) POS CHECKOUT + GIFT-CARD REDEMPTION (migration 0039). Proves server-side
--      pricing (client-sent line prices are ignored), cross-tenant checkout
--      refusal, the front_desk-discount refusal (a discount is a manager
--      decision), inline cash gift-card issuance + the append-only 'issue'
--      entry, idempotent checkout AND redemption, over-redemption refusal, and
--      that the redemption ledger stays append-only (block 26 lists
--      gift_card_ledger; re-assert on the redeem path). Seeds tenant-B catalog +
--      a front_desk user; reuses block-27/29 tenants/people.
--      (invariant #5/#6/#7: every new RPC gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; v_uf uuid; v_pb uuid;
  v_retail_b uuid; v_gcp_b uuid; v_plan_dropin_b uuid;
  v_lines jsonb; v_res jsonb; v_order uuid; v_payment uuid;
  v_gc_code text; v_card uuid; v_redeem jsonb;
  v_status text; v_tender text; v_msg text; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select id into v_pb from public.people where tenant_id = v_b limit 1;

  -- A front_desk user in tenant B (the seed only creates owners).
  insert into auth.users (id, email) values (gen_random_uuid(), 'fd-b@example.test')
    returning id into v_uf;
  insert into public.tenant_users (tenant_id, user_id, role) values (v_b, v_uf, 'front_desk');

  -- Tenant-B catalog: retail, gift-card denomination, and a drop_in plan + its
  -- CURRENT price phase (one-time, interval null).
  insert into public.retail_products (tenant_id, name, price_cents)
    values (v_b, 'Towel', 1500) returning id into v_retail_b;
  insert into public.gift_card_products (tenant_id, name, amount_cents)
    values (v_b, 'GC 50', 5000) returning id into v_gcp_b;
  insert into public.plans (tenant_id, kelo_type, name)
    values (v_b, 'drop_in', 'Drop-in') returning id into v_plan_dropin_b;
  insert into public.plan_prices (tenant_id, plan_id, amount_cents, interval)
    values (v_b, v_plan_dropin_b, 2500, null);

  perform app_test.become(v_ub);

  -- Positive: uB (owner of B) rings a CASH sale (retail x2 + gift card + drop_in).
  v_lines := jsonb_build_array(
    jsonb_build_object('kind', 'retail',    'ref_id', v_retail_b,       'qty', 2),
    jsonb_build_object('kind', 'gift_card', 'ref_id', v_gcp_b,          'qty', 1),
    jsonb_build_object('kind', 'drop_in',   'ref_id', v_plan_dropin_b,  'qty', 1)
  );
  v_res := app.pos_checkout(v_b, v_ub, 'pos-b-1', v_pb, v_lines, 'cash', 0);
  v_order := (v_res ->> 'order_id')::uuid;
  v_payment := (v_res ->> 'payment_id')::uuid;
  perform app_test.assert(v_order is not null, '(31) pos_checkout returned no order');

  -- SERVER-SIDE PRICING: subtotal = 2*1500 + 5000 + 2500 = 10500 (no client price).
  select subtotal_cents into n from public.pos_orders where id = v_order;
  perform app_test.assert(n = 10500, '(31) pos_checkout mispriced the order server-side');

  -- CASH → a succeeded payment recorded in-body, tender 'cash' (the documented
  -- webhook exception).
  select status, tender into v_status, v_tender from public.payments where id = v_payment;
  perform app_test.assert(v_status = 'succeeded' and v_tender = 'cash',
    '(31) cash checkout did not record a succeeded cash payment');

  -- The gift card issued INLINE: a raw code was returned once and an append-only
  -- 'issue' entry exists at the denomination amount.
  v_gc_code := (v_res -> 'gift_card_codes' -> 0 ->> 'code');
  perform app_test.assert(v_gc_code is not null, '(31) cash gift-card sale returned no code');
  select gift_card_id into v_card from public.pos_order_lines
    where order_id = v_order and kind = 'gift_card';
  perform app_test.assert(v_card is not null, '(31) gift-card line was not issued inline');
  select count(*) into n from public.gift_card_ledger
    where gift_card_id = v_card and entry_type = 'issue' and amount_cents = 5000;
  perform app_test.assert(n = 1, '(31) gift-card issue ledger entry missing');

  -- Client-sent line prices are IGNORED: an injected unit_price_cents is not read.
  v_res := app.pos_checkout(v_b, v_ub, 'pos-price-ignore', v_pb,
    jsonb_build_array(jsonb_build_object(
      'kind', 'retail', 'ref_id', v_retail_b, 'qty', 1, 'unit_price_cents', 1, 'price_cents', 1)),
    'cash', 0);
  select unit_price_cents into n from public.pos_order_lines
    where order_id = (v_res ->> 'order_id')::uuid and kind = 'retail';
  perform app_test.assert(n = 1500, '(31) pos_checkout trusted a client-sent line price');

  -- Idempotent: the same key returns the same order, no second order.
  v_res := app.pos_checkout(v_b, v_ub, 'pos-b-1', v_pb, v_lines, 'cash', 0);
  perform app_test.assert((v_res ->> 'order_id')::uuid = v_order,
    '(31) duplicate pos_checkout key created a different order');
  select count(*) into n from public.pos_orders where tenant_id = v_b and idempotency_key = 'pos-b-1';
  perform app_test.assert(n = 1, '(31) duplicate pos_checkout wrote a second order');

  -- Cross-tenant: uB cannot check out against tenant A (role re-check → 42501).
  raised := false;
  begin perform app.pos_checkout(v_a, v_ub, 'pos-x', null, v_lines, 'cash', 0);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(31) uB could pos_checkout for tenant A');

  -- An unknown line kind is refused on THAT ground (22023 + message).
  raised := false; v_msg := '';
  begin
    perform app.pos_checkout(v_b, v_ub, 'pos-badkind', v_pb,
      jsonb_build_array(jsonb_build_object('kind', 'bogus', 'ref_id', v_retail_b, 'qty', 1)),
      'cash', 0);
  exception when invalid_parameter_value then raised := true; v_msg := sqlerrm; end;
  perform app_test.assert(raised and v_msg like '%unknown line kind%',
    '(31) pos_checkout accepted an unknown line kind');

  -- REDEEM: a partial redemption appends a NEGATIVE entry; balance = 5000 - 2000.
  v_redeem := app.redeem_gift_card(v_b, v_ub, v_gc_code, 2000, 'rd-b-1');
  perform app_test.assert((v_redeem ->> 'balance_cents')::int = 3000,
    '(31) redemption balance math wrong (5000 - 2000)');
  select count(*) into n from public.gift_card_ledger
    where gift_card_id = v_card and entry_type = 'redeem' and amount_cents = -2000;
  perform app_test.assert(n = 1, '(31) redeem ledger entry missing or not negative');

  -- Idempotent redemption: the same key appends no second entry.
  v_redeem := app.redeem_gift_card(v_b, v_ub, v_gc_code, 2000, 'rd-b-1');
  select count(*) into n from public.gift_card_ledger
    where gift_card_id = v_card and idempotency_key = 'rd-b-1';
  perform app_test.assert(n = 1, '(31) duplicate redeem key wrote a second ledger entry');

  -- OVER-REDEMPTION: only 3000 remains; 4000 must be refused on THAT exact
  -- balance ground (22023 + message), never for an unrelated reason.
  raised := false; v_msg := '';
  begin perform app.redeem_gift_card(v_b, v_ub, v_gc_code, 4000, 'rd-b-2');
  exception when invalid_parameter_value then raised := true; v_msg := sqlerrm; end;
  perform app_test.assert(raised and v_msg like '%redemption exceeds gift card balance%',
    '(31) redeem allowed exceeding the balance');

  -- FRONT_DESK + DISCOUNT → refused (a discount is a manager decision → 42501).
  reset role;  -- become() is superuser-only; drop the uB impersonation first
  perform app_test.become(v_uf);
  raised := false;
  begin perform app.pos_checkout(v_b, v_uf, 'pos-fd-disc', v_pb, v_lines, 'cash', 500);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(31) front_desk could apply a discount');

  -- front_desk CAN check out with NO discount (positive control).
  v_res := app.pos_checkout(v_b, v_uf, 'pos-fd-ok', v_pb,
    jsonb_build_array(jsonb_build_object('kind', 'retail', 'ref_id', v_retail_b, 'qty', 1)),
    'cash', 0);
  perform app_test.assert((v_res ->> 'order_id') is not null,
    '(31) front_desk could not check out without a discount');

  reset role;
  -- The redemption ledger is append-only at the PRIVILEGE level (service_role
  -- too) — a redeem NEVER mutates a balance, only appends (block 26 lists it).
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.gift_card_ledger', 'update'),
    '(31) service_role holds UPDATE on gift_card_ledger — the redemption ledger is append-only');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.gift_card_ledger', 'delete'),
    '(31) service_role holds DELETE on gift_card_ledger — the redemption ledger is append-only');
  -- The receipt tables have NO client/service write path (definer RPCs write).
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.pos_orders', 'insert'),
    '(31) authenticated holds INSERT on pos_orders — orders are RPC-written');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.pos_order_lines', 'insert'),
    '(31) authenticated holds INSERT on pos_order_lines — lines are RPC-written');
end
$$;

-- ---------------------------------------------------------------------------
-- (32) NATIVE BOOKING ENGINE (migration 0040): server-side seat holds + the
--      four money/booking RPCs (hold / freeze / book / cancel). Proves:
--        * cross-tenant hold/book/cancel refusal (role re-check in-body) + the
--          availability read is RLS-scoped (uB sees zero of A's sessions);
--        * the WAIVER enforcer — needs_signature ⇒ book raises waiver_required;
--        * DB-ENFORCED no-oversell: a SEQUENTIAL over-capacity fill is refused
--          (FOR UPDATE serialization + the belt-and-suspenders trigger);
--        * the APPEND-ONLY credit debit — the ledger row COUNT grows by one and
--          a negative 'debit' is appended (never an in-place balance update);
--        * the 12h cancel policy — ≥12h appends a POSITIVE refund_credit and
--          restores the balance; <12h forfeits (the debit stands, no refund);
--        * a live hold reserves the seat and is BOUND to (person, session) — a
--          hold cannot book a foreign person; booking consumes the hold;
--        * booking idempotency replay — the same key returns the same booking
--          and appends NO second booking and NO second debit.
--      bookings/booking_holds are RPC-written (NO client INSERT path) and are
--      NOT append-only (status advances; holds are ephemeral), so they are
--      absent from block 26; the RPC-written INSERT guard is re-asserted here.
--      Seeds tenant-A/B resources + offering templates + published sessions +
--      people + credit grants; reuses block-20/25/27 tenants/owners.
--      (invariant #5/#6/#7: every new RPC gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid;
  v_res_a uuid; v_res_b uuid; v_ot_a uuid; v_ot_b uuid;
  v_s_future uuid; v_s_cap uuid; v_s_soon uuid; v_s_a uuid;
  v_p1 uuid; v_pc1 uuid; v_pc2 uuid; v_pref uuid; v_pfor uuid; v_phold uuid; v_pwaiver uuid;
  v_pzero uuid;
  v_res jsonb; v_book1 uuid; v_booking uuid; v_hold uuid;
  v_needs boolean; v_msg text; v_state text; n int; n_before int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  -- Authoring spine: a resource + offering template per tenant, then PUBLISHED
  -- sessions. Absence of a resource_readiness row means "ready" (no maintenance/
  -- closed window), so no readiness seed is needed for a bookable session.
  insert into public.resources (tenant_id, name) values (v_a, 'Room A') returning id into v_res_a;
  insert into public.resources (tenant_id, name) values (v_b, 'Room B') returning id into v_res_b;
  insert into public.offering_templates (tenant_id, name, duration_minutes)
    values (v_a, 'Class A', 60) returning id into v_ot_a;
  insert into public.offering_templates (tenant_id, name, duration_minutes)
    values (v_b, 'Class B', 60) returning id into v_ot_b;

  -- B sessions: a roomy FUTURE session (>12h out), a capacity-1 session (the
  -- over-sell target), and a SOON session (<12h out, for the forfeit branch).
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
    values (v_b, v_ot_b, v_res_b, now() + interval '24 hours', now() + interval '25 hours', 5, 'published', now())
    returning id into v_s_future;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
    values (v_b, v_ot_b, v_res_b, now() + interval '24 hours', now() + interval '25 hours', 1, 'published', now())
    returning id into v_s_cap;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
    values (v_b, v_ot_b, v_res_b, now() + interval '2 hours', now() + interval '3 hours', 5, 'published', now())
    returning id into v_s_soon;
  -- One published session in tenant A (the cross-tenant + availability target).
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
    values (v_a, v_ot_a, v_res_a, now() + interval '24 hours', now() + interval '25 hours', 5, 'published', now())
    returning id into v_s_a;

  -- B people (native), each with a positive credit grant (a booking debits ONE).
  insert into public.people (tenant_id, first_name, source) values (v_b, 'P1',  'native') returning id into v_p1;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PC1', 'native') returning id into v_pc1;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PC2', 'native') returning id into v_pc2;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PRef','native') returning id into v_pref;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PFor','native') returning id into v_pfor;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PHold','native') returning id into v_phold;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PWaiver','native') returning id into v_pwaiver;
  -- PZero gets NO credit grant below — the zero-credit refusal target (c2).
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PZero','native') returning id into v_pzero;

  insert into public.credit_ledger (tenant_id, person_id, entry_type, delta, source, external_ref)
    values
      (v_b, v_p1,      'grant', 5, 'native', 'g-p1'),
      (v_b, v_pc1,     'grant', 5, 'native', 'g-pc1'),
      (v_b, v_pc2,     'grant', 5, 'native', 'g-pc2'),
      (v_b, v_pref,    'grant', 5, 'native', 'g-pref'),
      (v_b, v_pfor,    'grant', 5, 'native', 'g-pfor'),
      (v_b, v_phold,   'grant', 5, 'native', 'g-phold'),
      (v_b, v_pwaiver, 'grant', 5, 'native', 'g-pwaiver');

  -- PWaiver has a live relationship, so once an active waiver version exists she
  -- OWES a signature (needs_signature). Seeded now; the version is activated LAST.
  insert into public.person_relationships (tenant_id, person_id, relationship_type, rule_version)
    values (v_b, v_pwaiver, 'recurring_member', 1);

  perform app_test.become(v_ub);

  -- (a) HAPPY PATH + the append-only debit: booking P1 appends exactly one
  --     negative 'debit' entry (the ledger COUNT grows; nothing is updated).
  select count(*) into n_before from public.credit_ledger where tenant_id = v_b and person_id = v_p1;
  v_res := app.book_session(v_b, v_p1, v_s_future, v_ub, 'bk-p1', 'desk', null, true);
  v_book1 := (v_res ->> 'booking_id')::uuid;
  perform app_test.assert(v_book1 is not null, '(32) book_session returned no booking');
  select count(*) into n from public.credit_ledger where tenant_id = v_b and person_id = v_p1;
  perform app_test.assert(n = n_before + 1, '(32) booking did not APPEND a credit entry');
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_p1 and entry_type = 'debit' and delta = -1;
  perform app_test.assert(n = 1, '(32) booking debit missing or not a negative append');

  -- (b) IDEMPOTENCY REPLAY: same key ⇒ same booking, no second row, no 2nd debit.
  v_res := app.book_session(v_b, v_p1, v_s_future, v_ub, 'bk-p1', 'desk', null, true);
  perform app_test.assert((v_res ->> 'booking_id')::uuid = v_book1,
    '(32) a replayed booking key returned a different booking');
  perform app_test.assert((v_res ->> 'replayed')::boolean, '(32) replay flag not set');
  select count(*) into n from public.bookings where tenant_id = v_b and idempotency_key = 'bk-p1';
  perform app_test.assert(n = 1, '(32) a replayed booking key wrote a second booking');
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_p1 and entry_type = 'debit';
  perform app_test.assert(n = 1, '(32) a replayed booking appended a second debit');

  -- (c) NO-OVERSELL: a capacity-1 session takes ONE booking; the next is refused.
  v_res := app.book_session(v_b, v_pc1, v_s_cap, v_ub, 'bk-pc1', 'desk', null, true);
  perform app_test.assert((v_res ->> 'booking_id') is not null, '(32) first seat could not book');
  raised := false;
  begin perform app.book_session(v_b, v_pc2, v_s_cap, v_ub, 'bk-pc2', 'desk', null, true);
  exception when check_violation then raised := true; end;  -- 23514, the exact no-oversell code
  perform app_test.assert(raised, '(32) an over-capacity booking was NOT refused with check_violation (23514)');
  select count(*) into n from public.bookings
    where tenant_id = v_b and session_id = v_s_cap and status in ('booked', 'checked_in');
  perform app_test.assert(n = 1, '(32) capacity-1 session holds more than one active booking');

  -- (c2) ZERO-CREDIT REFUSAL — the reason must be insufficient_credits (22023),
  --      not merely "some error". A `when others` catch passes for the WRONG
  --      reason too (a NOT NULL, a capacity refusal, a permission error), so it
  --      cannot tell "refused because broke" from "refused for an unrelated
  --      bug". PZero holds no credit lot; the booking is refused on that exact
  --      ground and NOTHING is appended to the append-only ledger.
  raised := false; v_state := ''; v_msg := '';
  begin perform app.book_session(v_b, v_pzero, v_s_future, v_ub, 'bk-zero', 'desk', null, true);
  exception when invalid_parameter_value then raised := true; v_state := sqlstate; v_msg := sqlerrm; end;
  perform app_test.assert(raised and v_msg like '%insufficient_credits%',
    '(32) a zero-credit booking was not refused with insufficient_credits');
  perform app_test.assert(v_state = '22023', '(32) insufficient_credits raised a non-22023 SQLSTATE');
  select count(*) into n from public.credit_ledger where tenant_id = v_b and person_id = v_pzero;
  perform app_test.assert(n = 0, '(32) a credit-refused booking still appended a ledger row');

  -- (d) HOLD choreography + the person/session BIND: a hold cannot book a foreign
  --     person; the rightful owner books via the hold, which is then consumed.
  v_hold := app.hold_session(v_b, v_s_future, v_phold, v_ub, 300);
  perform app_test.assert(v_hold is not null, '(32) hold_session returned no hold');
  raised := false;
  begin perform app.book_session(v_b, v_p1, v_s_future, v_ub, 'bk-mismatch', 'desk', v_hold, true);
  exception when insufficient_privilege then raised := true; end;  -- 42501, the hold/person bind
  perform app_test.assert(raised, '(32) a hold booked a person it does not belong to');
  v_res := app.book_session(v_b, v_phold, v_s_future, v_ub, 'bk-phold', 'desk', v_hold, true);
  perform app_test.assert((v_res ->> 'booking_id') is not null, '(32) hold owner could not book via the hold');
  select count(*) into n from public.booking_holds where tenant_id = v_b and id = v_hold;
  perform app_test.assert(n = 0, '(32) booking did not CONSUME the hold');

  -- (e) CANCEL ≥12h ⇒ REFUND: a positive refund_credit is appended, balance
  --     restored to the granted 5 (grant 5, debit -1, refund +1).
  v_res := app.book_session(v_b, v_pref, v_s_future, v_ub, 'bk-pref', 'desk', null, true);
  v_booking := (v_res ->> 'booking_id')::uuid;
  v_res := app.cancel_booking(v_b, v_booking, v_ub, 'cx-pref', now());
  perform app_test.assert((v_res ->> 'branch') = 'refund', '(32) a ≥12h cancel did not choose refund');
  perform app_test.assert((v_res ->> 'refunded')::boolean, '(32) refund branch reported refunded=false');
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_pref and entry_type = 'refund_credit' and delta = 1;
  perform app_test.assert(n = 1, '(32) refund did not APPEND a positive refund_credit entry');
  select coalesce(sum(delta), 0) into n from public.credit_ledger where tenant_id = v_b and person_id = v_pref;
  perform app_test.assert(n = 5, '(32) refund did not restore the credit balance');

  -- (f) CANCEL <12h ⇒ FORFEIT: no refund entry; the debit stands (balance 5-1=4).
  v_res := app.book_session(v_b, v_pfor, v_s_soon, v_ub, 'bk-pfor', 'desk', null, true);
  v_booking := (v_res ->> 'booking_id')::uuid;
  v_res := app.cancel_booking(v_b, v_booking, v_ub, 'cx-pfor', now());
  perform app_test.assert((v_res ->> 'branch') = 'forfeit', '(32) a <12h cancel did not forfeit');
  perform app_test.assert(not (v_res ->> 'refunded')::boolean, '(32) a forfeit reported a refund');
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_pfor and entry_type = 'refund_credit';
  perform app_test.assert(n = 0, '(32) a forfeit APPENDED a refund entry');
  select coalesce(sum(delta), 0) into n from public.credit_ledger where tenant_id = v_b and person_id = v_pfor;
  perform app_test.assert(n = 4, '(32) a forfeit did not keep the debit');

  -- (g) CROSS-TENANT refusal: uB (owner of B) cannot hold/book/cancel in tenant A
  --     (the definer RPCs re-check role in-body → raise, never touch A's rows).
  -- The definer RPCs re-check role in-body; uB has no membership in tenant A, so
  -- each hits the "role required" guard → 42501 (never "some error").
  raised := false;
  begin perform app.hold_session(v_a, v_s_a, v_p1, v_ub, 300);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(32) uB could hold a seat in tenant A');
  raised := false;
  begin perform app.book_session(v_a, v_p1, v_s_a, v_ub, 'bk-x', 'desk', null, true);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(32) uB could book in tenant A');
  raised := false;
  begin perform app.cancel_booking(v_a, gen_random_uuid(), v_ub, 'cx-x', now());
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(32) uB could cancel a booking in tenant A');

  -- Availability read is RLS-scoped: uB sees zero of A's sessions, but her own.
  select count(*) into n from public.session_availability(v_a, now(), now() + interval '48 hours');
  perform app_test.assert(n = 0, '(32) uB sees tenant A availability');
  select count(*) into n from public.session_availability(v_b, now(), now() + interval '48 hours');
  perform app_test.assert(n >= 1, '(32) uB cannot read her OWN availability');

  -- Member-read isolation on the new tables: uB sees zero of A's bookings/holds.
  select count(*) into n from public.bookings where tenant_id = v_a;
  perform app_test.assert(n = 0, '(32) uB can SELECT tenant A bookings');
  select count(*) into n from public.booking_holds where tenant_id = v_a;
  perform app_test.assert(n = 0, '(32) uB can SELECT tenant A booking_holds');

  -- (h) THE WAIVER ENFORCER (activated LAST — it is tenant-wide). PWaiver owes
  --     the active-version signature, so booking is impossible (waiver_required).
  reset role;  -- become() is superuser-only; drop the uB impersonation to seed
  insert into public.waiver_versions (tenant_id, version, body, active)
    values (v_b, 1, 'Assumption of risk — sign to proceed.', true);
  perform app_test.become(v_ub);
  select needs_signature into v_needs from public.current_waiver_status(v_b, v_pwaiver);
  perform app_test.assert(v_needs, '(32) PWaiver should owe a signature after activation');
  raised := false; v_msg := '';
  begin perform app.book_session(v_b, v_pwaiver, v_s_future, v_ub, 'bk-pw', 'desk', null, true);
  exception when insufficient_privilege then raised := true; v_msg := sqlerrm; end;  -- 42501 + message
  perform app_test.assert(raised and v_msg like '%waiver_required%',
    '(32) a person owing a waiver signature could book (enforcer bypassed)');
  -- The waiver refusal fired BEFORE any credit debit — PWaiver keeps her grant.
  select coalesce(sum(delta), 0) into n from public.credit_ledger where tenant_id = v_b and person_id = v_pwaiver;
  perform app_test.assert(n = 5, '(32) a waiver-refused booking still debited a credit');

  -- RPC-written: neither table has a client INSERT path (definer RPCs write).
  reset role;
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.bookings', 'insert'),
    '(32) authenticated holds INSERT on bookings — bookings are RPC-written');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.booking_holds', 'insert'),
    '(32) authenticated holds INSERT on booking_holds — holds are RPC-written');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.bookings', 'insert'),
    '(32) service_role holds INSERT on bookings — only the definer RPCs write');
end
$$;

-- ---------------------------------------------------------------------------
-- (33) WAITLIST + CHECK-IN + NO-SHOW (migration 0041, built on 0040's native
--      booking engine). Proves: joining requires a FULL session (an OPEN one is
--      refused); the FIFO promotion cascade off a cancel; accept books through
--      app.book_session so the WAIVER is enforced there; double-accept is
--      idempotent (no second debit); the check-in arrival window; cross-tenant
--      join/accept/check-in refusal; and the no-show sweep leaving checked_in /
--      cancelled bookings untouched. Seeds its own tenant-B scheduling scaffold;
--      reuses the seed tenants + user_b (owner of B) / user_a (owner of A).
--      (invariant #5/#6/#7: every new RPC gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid; v_ua uuid;
  v_ot uuid; v_rs uuid; v_wv uuid;
  v_sfull uuid; v_sopen uuid; v_swaiver uuid; v_snow uuid; v_spast uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_pf uuid; v_pw uuid; v_pci uuid; v_pwin uuid;
  v_pa uuid;
  v_pns uuid; v_pcin uuid; v_pcx uuid;
  v_book1 uuid; v_bookpf uuid; v_bookci uuid; v_bwin uuid;
  v_e2 uuid; v_ew uuid;
  v_bk_forfeit uuid; v_bk_ci uuid; v_bk_cx uuid;
  v_res jsonb; v_bid uuid; v_bid2 uuid;
  v_status text; v_msg text; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a';

  -- --- Phase A: superuser seeds (auth.uid() is null → book_session's actor/role
  --     checks are bypassed for setup; the RPC's own capacity/waiver still run). --
  insert into public.offering_templates (tenant_id, name, duration_minutes)
    values (v_b, 'Flow', 60) returning id into v_ot;
  insert into public.resources (tenant_id, name) values (v_b, 'Studio 1') returning id into v_rs;

  insert into public.people (tenant_id, first_name, source) values (v_b, 'P1',  'native') returning id into v_p1;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'P2',  'native') returning id into v_p2;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'P3',  'native') returning id into v_p3;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PF',  'native') returning id into v_pf;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PW',  'native') returning id into v_pw;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PCI', 'native') returning id into v_pci;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PWN', 'native') returning id into v_pwin;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PNS', 'native') returning id into v_pns;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PCN', 'native') returning id into v_pcin;
  insert into public.people (tenant_id, first_name, source) values (v_b, 'PCX', 'native') returning id into v_pcx;
  insert into public.people (tenant_id, first_name, source) values (v_a, 'PA',  'native') returning id into v_pa;

  -- P2 gets a credit so its promotion-accept can debit; the waiver-blocked PW
  -- needs none (the waiver raises before the credit block in book_session).
  insert into public.credit_ledger (tenant_id, person_id, entry_type, delta, source, reason)
    values (v_b, v_p2, 'grant', 1, 'native', 'seed');

  -- An ACTIVE waiver version for B + a relationship for PW ONLY, so exactly PW
  -- owes the active signature (needs_signature = active ∧ relationship ∧ unsigned).
  -- Block (32) already seeded (v_b, 1) in this same transaction; upsert keeps
  -- this block portable whether it runs after (32) or standalone.
  insert into public.waiver_versions (tenant_id, version, body, active)
    values (v_b, 1, 'Assumption of risk.', true)
    on conflict (tenant_id, version) do update set active = true
    returning id into v_wv;
  insert into public.person_relationships (tenant_id, person_id, relationship_type, rule_version)
    values (v_b, v_pw, 'recurring_member', 1);

  -- Sessions. Full (cap 1), open (cap 2), waiver (cap 1), soon (cap 1 for the
  -- positive check-in), and a PAST session (cap 3) for the no-show sweep.
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
  values (v_b, v_ot, v_rs, now() + interval '2 hours', now() + interval '3 hours', 1, 'published', now())
  returning id into v_sfull;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
  values (v_b, v_ot, v_rs, now() + interval '4 hours', now() + interval '5 hours', 2, 'published', now())
  returning id into v_sopen;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
  values (v_b, v_ot, v_rs, now() + interval '6 hours', now() + interval '7 hours', 1, 'published', now())
  returning id into v_swaiver;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
  values (v_b, v_ot, v_rs, now() + interval '30 minutes', now() + interval '90 minutes', 1, 'published', now())
  returning id into v_snow;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
  values (v_b, v_ot, v_rs, now() - interval '2 hours', now() - interval '1 hours', 3, 'published', now())
  returning id into v_spast;

  -- Fills (use_credit=false → no credit needed). FULL, WAIVER, SOON, and one seat
  -- of OPEN so it stays open (1 of 2) yet gives a >60min-away booking to reject.
  v_res := app.book_session(v_b, v_p1,   v_sfull,   v_ub, 'seed-full',  'desk', null, false);
  v_book1  := (v_res ->> 'booking_id')::uuid;
  v_res := app.book_session(v_b, v_pf,   v_swaiver, v_ub, 'seed-waiv',  'desk', null, false);
  v_bookpf := (v_res ->> 'booking_id')::uuid;
  v_res := app.book_session(v_b, v_pci,  v_snow,    v_ub, 'seed-soon',  'desk', null, false);
  v_bookci := (v_res ->> 'booking_id')::uuid;
  v_res := app.book_session(v_b, v_pwin, v_sopen,   v_ub, 'seed-open',  'desk', null, false);
  v_bwin   := (v_res ->> 'booking_id')::uuid;

  -- PAST-session bookings inserted DIRECTLY (book_session refuses a started
  -- session): a booked (→ no_show), a checked_in, and a cancelled (both untouched).
  insert into public.bookings (tenant_id, session_id, person_id, status, booked_via, idempotency_key)
    values (v_b, v_spast, v_pns, 'booked', 'desk', 'past-booked') returning id into v_bk_forfeit;
  insert into public.bookings (tenant_id, session_id, person_id, status, booked_via, idempotency_key, checked_in_at)
    values (v_b, v_spast, v_pcin, 'checked_in', 'desk', 'past-ci', now() - interval '90 minutes')
    returning id into v_bk_ci;
  insert into public.bookings (tenant_id, session_id, person_id, status, booked_via, idempotency_key, cancelled_at)
    values (v_b, v_spast, v_pcx, 'cancelled', 'desk', 'past-cx', now() - interval '90 minutes')
    returning id into v_bk_cx;

  -- --- Phase B: the desk surface, as user_b (owner of B). -------------------
  perform app_test.become(v_ub);

  -- FIFO: P2 then P3 join the FULL session; positions are 1, 2.
  perform app_test.assert(app.join_waitlist(v_b, v_sfull, v_p2, v_ub, 'wl-p2') = 1,
    '(33) first waitlist joiner did not get position 1');
  perform app_test.assert(app.join_waitlist(v_b, v_sfull, v_p3, v_ub, 'wl-p3') = 2,
    '(33) second waitlist joiner did not get position 2');

  -- Idempotent join: same key returns the same position, no second entry.
  perform app_test.assert(app.join_waitlist(v_b, v_sfull, v_p2, v_ub, 'wl-p2') = 1,
    '(33) duplicate join key changed the position');
  select count(*) into n from public.waitlist_entries
    where tenant_id = v_b and session_id = v_sfull and status = 'waiting';
  perform app_test.assert(n = 2, '(33) duplicate join wrote a third waiting entry');

  -- Joining an OPEN session (1 of 2 taken) is refused on THAT ground — the seat
  -- should be booked (22023 + message), not merely "some error".
  raised := false; v_msg := '';
  begin perform app.join_waitlist(v_b, v_sopen, v_p3, v_ub, 'wl-open');
  exception when invalid_parameter_value then raised := true; v_msg := sqlerrm; end;
  perform app_test.assert(raised and v_msg like '%session is not full%',
    '(33) join succeeded on an OPEN (not full) session');

  -- Cancel P1 → the AFTER UPDATE trigger promotes P2 (FIFO) to an OFFER.
  perform app.cancel_booking(v_b, v_book1, v_ub, 'cx-p1', now());
  select id, status into v_e2, v_status from public.waitlist_entries
    where tenant_id = v_b and session_id = v_sfull and person_id = v_p2;
  perform app_test.assert(v_status = 'offered', '(33) cancel did not promote the first waiter to offered');
  -- The offer reserved the seat with a live hold (0040 availability = 0 again).
  select count(*) into n from public.booking_holds
    where tenant_id = v_b and session_id = v_sfull and person_id = v_p2;
  perform app_test.assert(n = 1, '(33) promotion did not create the offer hold');

  -- Accept: books through book_session (debits P2's credit; waiver n/a — no
  -- relationship). Entry → promoted; exactly one booking for P2.
  v_bid := app.accept_waitlist_offer(v_b, v_e2, v_ub, 'ac-p2', 'desk');
  perform app_test.assert(v_bid is not null, '(33) accept returned no booking');
  select status into v_status from public.waitlist_entries where id = v_e2;
  perform app_test.assert(v_status = 'promoted', '(33) accepted entry is not promoted');
  select count(*) into n from public.bookings
    where tenant_id = v_b and session_id = v_sfull and person_id = v_p2 and status = 'booked';
  perform app_test.assert(n = 1, '(33) accept did not create exactly one booking');
  -- The credit was debited exactly once (append-only ledger).
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_p2 and entry_type = 'debit';
  perform app_test.assert(n = 1, '(33) accept did not debit exactly one credit');

  -- Double-accept is idempotent: same key → same booking, no second debit.
  v_bid2 := app.accept_waitlist_offer(v_b, v_e2, v_ub, 'ac-p2', 'desk');
  perform app_test.assert(v_bid2 = v_bid, '(33) double-accept returned a different booking');
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_p2 and entry_type = 'debit';
  perform app_test.assert(n = 1, '(33) double-accept debited a second credit');

  -- WAIVER enforced at accept: PW (owes the active signature) is offered then
  -- refused by book_session (waiver_required). Fill session was PF; cancel frees it.
  perform app_test.assert(app.join_waitlist(v_b, v_swaiver, v_pw, v_ub, 'wl-pw') = 1,
    '(33) waiver waitlister did not get position 1');
  perform app.cancel_booking(v_b, v_bookpf, v_ub, 'cx-pf', now());
  select id, status into v_ew, v_status from public.waitlist_entries
    where tenant_id = v_b and session_id = v_swaiver and person_id = v_pw;
  perform app_test.assert(v_status = 'offered', '(33) PW was not promoted to offered');
  raised := false; v_msg := '';
  begin perform app.accept_waitlist_offer(v_b, v_ew, v_ub, 'ac-pw', 'desk');
  exception when insufficient_privilege then raised := true; v_msg := sqlerrm; end;  -- book_session waiver_required (42501)
  perform app_test.assert(raised and v_msg like '%waiver_required%',
    '(33) accept booked despite an unsigned active waiver');

  -- CHECK-IN: positive inside the window (v_snow starts in 30min); refused when
  -- the session is >60min away (v_sopen starts in 4h).
  perform app_test.assert(app.check_in(v_b, v_bookci, v_ub, now()) = 'checked_in',
    '(33) check-in inside the arrival window failed');
  -- Idempotent re-check-in no-ops.
  perform app_test.assert(app.check_in(v_b, v_bookci, v_ub, now()) = 'checked_in',
    '(33) idempotent re-check-in did not no-op');
  raised := false; v_msg := '';
  begin perform app.check_in(v_b, v_bwin, v_ub, now());
  exception when invalid_parameter_value then raised := true; v_msg := sqlerrm; end;
  perform app_test.assert(raised and v_msg like '%outside the arrival window%',
    '(33) check-in succeeded outside the arrival window');

  -- --- Phase C: cross-tenant, as user_a (owner of A). ----------------------
  reset role;
  perform app_test.become(v_ua);

  -- Each cross-tenant call hits the definer's in-body "role required" guard for
  -- tenant B (uA holds no membership there) → 42501, never "some error".
  raised := false;
  begin perform app.join_waitlist(v_b, v_sfull, v_pa, v_ua, 'x-join');
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(33) uA could join a tenant-B waitlist');

  raised := false;
  begin perform app.accept_waitlist_offer(v_b, v_ew, v_ua, 'x-acc', 'desk');
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(33) uA could accept a tenant-B offer');

  raised := false;
  begin perform app.check_in(v_b, v_bookci, v_ua, now());
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(33) uA could check in a tenant-B booking');

  -- Cross-tenant SELECT: uA sees none of tenant B's waitlist entries.
  select count(*) into n from public.waitlist_entries where tenant_id = v_b;
  perform app_test.assert(n = 0, '(33) uA can SELECT tenant-B waitlist entries');

  -- --- Phase D: the no-show sweep (service context) + privilege guards. -----
  reset role;
  perform app.mark_no_shows(v_b, now());
  select status into v_status from public.bookings where id = v_bk_forfeit;
  perform app_test.assert(v_status = 'no_show', '(33) mark_no_shows did not forfeit the booked attendee');
  select status into v_status from public.bookings where id = v_bk_ci;
  perform app_test.assert(v_status = 'checked_in', '(33) mark_no_shows touched a checked_in booking');
  select status into v_status from public.bookings where id = v_bk_cx;
  perform app_test.assert(v_status = 'cancelled', '(33) mark_no_shows touched a cancelled booking');
  -- No credit refund on forfeit (the debit stands) — none was even debited here,
  -- but assert the sweep appended NO refund_credit for the no-show person.
  select count(*) into n from public.credit_ledger
    where tenant_id = v_b and person_id = v_pns and entry_type = 'refund_credit';
  perform app_test.assert(n = 0, '(33) no-show forfeit appended a credit refund');

  -- waitlist_entries is RPC-written: no client/service INSERT/UPDATE/DELETE grant.
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.waitlist_entries', 'insert'),
    '(33) authenticated holds INSERT on waitlist_entries — it is RPC-written');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.waitlist_entries', 'update'),
    '(33) authenticated holds UPDATE on waitlist_entries — it is RPC-written');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.waitlist_entries', 'delete'),
    '(33) service_role holds DELETE on waitlist_entries — it is RPC-written');
end
$$;

-- ---------------------------------------------------------------------------
-- (34) AUTHORITY MATRIX (migration 0042): the per-capability cutover ledger.
--      Proves:
--        * cross-tenant read refusal — uB sees zero of tenant A's authority_flips
--          AND zero of A's current_authority rows (the invoker view is
--          RLS-scoped; app.current_tenant_ids() enumerates only the caller's);
--        * OWNER-ONLY flip — a manager AND a front_desk of B are BOTH refused
--          (the cutover lever is owner-only, re-checked in-body);
--        * cross-tenant flip refusal — uA (owner of A) cannot flip tenant B;
--        * APPEND-ONLY — UPDATE/DELETE on authority_flips is refused for the
--          owning tenant's owner AND at the privilege level for service_role;
--        * unknown-domain refusal + empty-reason refusal (the closed sets + the
--          non-empty reason guard, both enforced in the RPC body);
--        * idempotent replay — the SAME key returns the same flip id and appends
--          EXACTLY ONE row (never a second ledger row, never a second audit row);
--        * the derived view — an un-flipped domain defaults to 'glofox' (absence
--          = Glofox; no seeding) and a committed flip reads back as 'kelo'.
--      authority_flips is RPC-written (NO client INSERT path) and append-only
--      (block 26 lists it). Reuses tenant-A/B + owners uA/uB; seeds a manager +
--      front_desk of B. (invariant #6/#7: every new table/RPC gets an attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ua uuid; v_ub uuid; v_bm uuid; v_bf uuid;
  v_id1 uuid; v_id2 uuid; v_auth text; n int; raised boolean;
begin
  reset role;
  select val::uuid into v_a  from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b  from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  -- A manager + a front_desk of tenant B (the seed only creates owners).
  insert into auth.users (id, email) values (gen_random_uuid(), 'bm34@example.test')
    returning id into v_bm;
  insert into auth.users (id, email) values (gen_random_uuid(), 'bf34@example.test')
    returning id into v_bf;
  insert into public.tenant_users (tenant_id, user_id, role) values (v_b, v_bm, 'manager');
  insert into public.tenant_users (tenant_id, user_id, role) values (v_b, v_bf, 'front_desk');

  -- Seed one flip per tenant DIRECTLY (superuser bypasses grants/RLS) so the
  -- cross-tenant READ has something to (not) see.
  insert into public.authority_flips (tenant_id, domain, authority, reason, actor, idempotency_key)
    values (v_a, 'bookings', 'kelo', 'A seed', v_ua, 'a-seed-1');
  insert into public.authority_flips (tenant_id, domain, authority, reason, actor, idempotency_key)
    values (v_b, 'bookings', 'kelo', 'B seed', v_ub, 'b-seed-1');

  -- --- cross-tenant read refusal (as uB, owner of B) -----------------------
  perform app_test.become(v_ub);
  select count(*) into n from public.authority_flips where tenant_id = v_a;
  perform app_test.assert(n = 0, '(34) uB can SELECT tenant A authority_flips');
  select count(*) into n from public.current_authority where tenant_id = v_a;
  perform app_test.assert(n = 0, '(34) uB can SELECT tenant A current_authority');
  -- uB sees exactly her own eight domains (all of the closed set).
  select count(*) into n from public.current_authority where tenant_id = v_b;
  perform app_test.assert(n = 8, '(34) current_authority did not yield all 8 domains for the owner');

  -- The derived view: an UN-FLIPPED domain defaults to 'glofox'; the seeded flip
  -- reads back as 'kelo'.
  select authority into v_auth from public.current_authority
    where tenant_id = v_b and domain = 'retail';
  perform app_test.assert(v_auth = 'glofox', '(34) an un-flipped domain did not default to glofox');
  select authority into v_auth from public.current_authority
    where tenant_id = v_b and domain = 'bookings';
  perform app_test.assert(v_auth = 'kelo', '(34) a flipped domain did not read back as kelo');

  -- APPEND-ONLY at runtime: even the owning tenant's owner cannot UPDATE/DELETE.
  raised := false;
  begin update public.authority_flips set authority = 'glofox' where tenant_id = v_b;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) uB could UPDATE authority_flips — append-only violated');
  raised := false;
  begin delete from public.authority_flips where tenant_id = v_b;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) uB could DELETE authority_flips — append-only violated');

  -- --- OWNER-ONLY flip: manager AND front_desk of B are BOTH refused --------
  reset role;
  perform app_test.become(v_bm);
  raised := false;
  begin perform app.flip_authority(v_b, 'payments', 'kelo', 'mgr try', v_bm, 'mgr-1');
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) a manager could flip authority (owner-only breached)');

  reset role;
  perform app_test.become(v_bf);
  raised := false;
  begin perform app.flip_authority(v_b, 'payments', 'kelo', 'fd try', v_bf, 'fd-1');
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) a front_desk could flip authority (owner-only breached)');

  -- No non-owner attempt appended a row.
  reset role;
  select count(*) into n from public.authority_flips
    where tenant_id = v_b and domain = 'payments';
  perform app_test.assert(n = 0, '(34) a non-owner flip attempt appended a row');

  -- --- cross-tenant flip refusal: uA (owner of A) cannot flip tenant B ------
  perform app_test.become(v_ua);
  raised := false;
  begin perform app.flip_authority(v_b, 'payments', 'kelo', 'x-tenant', v_ua, 'x-1');
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) uA (owner of A) could flip tenant B authority');

  -- --- unknown-domain + empty-reason refusal (as uB, owner) ----------------
  reset role;
  perform app_test.become(v_ub);
  raised := false;
  begin perform app.flip_authority(v_b, 'nonsense', 'kelo', 'bad domain', v_ub, 'bad-dom');
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) an unknown domain was accepted');
  raised := false;
  begin perform app.flip_authority(v_b, 'payments', 'kelo', '   ', v_ub, 'empty-reason');
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(34) an empty reason was accepted');

  -- --- idempotent replay: same key → same id, EXACTLY one row appended ------
  v_id1 := app.flip_authority(v_b, 'payments', 'kelo', 'go-live payments', v_ub, 'idem-1');
  v_id2 := app.flip_authority(v_b, 'payments', 'kelo', 'go-live payments', v_ub, 'idem-1');
  perform app_test.assert(v_id1 = v_id2, '(34) an idempotent replay returned a different flip id');
  select count(*) into n from public.authority_flips
    where tenant_id = v_b and idempotency_key = 'idem-1';
  perform app_test.assert(n = 1, '(34) an idempotent replay appended a second flip row');
  -- The flip wrote its audit trail exactly once (append-once, not per replay).
  reset role;
  select count(*) into n from public.audit_events
    where tenant_id = v_b and action = 'authority.flipped'
      and target_id = 'payments' and (metadata ->> 'flip_id') = v_id1::text;
  perform app_test.assert(n = 1, '(34) an idempotent replay wrote a second audit row');

  -- The flip is now live in the derived matrix.
  perform app_test.become(v_ub);
  select authority into v_auth from public.current_authority
    where tenant_id = v_b and domain = 'payments';
  perform app_test.assert(v_auth = 'kelo', '(34) a committed flip did not surface in current_authority');

  -- authority_flips is RPC-written: no client/service INSERT grant; append-only
  -- UPDATE/DELETE for service_role (block 26 lists it; re-asserted here).
  reset role;
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.authority_flips', 'insert'),
    '(34) authenticated holds INSERT on authority_flips — it is RPC-written');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.authority_flips', 'update'),
    '(34) service_role holds UPDATE on authority_flips — the cutover ledger is append-only');
  perform app_test.assert(
    not has_table_privilege('service_role', 'public.authority_flips', 'delete'),
    '(34) service_role holds DELETE on authority_flips — the cutover ledger is append-only');
end
$$;

-- ---------------------------------------------------------------------------
-- (35) ANONYMOUS MEMBER SCHEDULE (migration 0043): the public surface the
--      member web app renders. Proves:
--        * the RETURN SHAPE is exactly the 8-column allowlist (pg_proc catalog
--          assertion — attendee/person data is structurally impossible to leak
--          because no such column exists in the composite return type);
--        * as the ANON role, public.member_schedule(A, window) returns A's
--          PUBLISHED session while the DRAFT seeded inside the same window
--          never appears (assertions are membership-based: blocks 32/33 seed
--          their own published sessions in this shared transaction);
--        * TENANT SCOPING — the same call with B returns only B's published
--          session (A's never bleeds across);
--        * availability is 0040's math — an attendee booking on A's published
--          session shows up as a bare COUNT (capacity 2, one booking →
--          available 1), never as an identity; credit_cost is the fixed 1;
--        * privileges — anon holds EXECUTE on the function but NO direct table
--          privilege that would bypass it (scheduled_sessions, bookings,
--          booking_holds, people).
--      Seeds its own A/B scheduling scaffold; reuses the seed tenants.
--      (invariant #7: every new RPC gets a cross-tenant attack test.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid;
  v_ot_a uuid; v_rs_a uuid; v_ot_b uuid; v_rs_b uuid;
  v_sa_pub uuid; v_sa_draft uuid; v_sb_pub uuid; v_sb_draft uuid;
  v_pa uuid;
  v_cols text[];
  n int;
begin
  reset role;
  select val::uuid into v_a from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b from app_test.ctx where key = 'tenant_b';

  -- --- Superuser seeds: one published + one draft session per tenant, and an
  --     attendee booking on A's published session. ---------------------------
  insert into public.offering_templates (tenant_id, name, duration_minutes)
    values (v_a, 'Flow', 60) returning id into v_ot_a;
  insert into public.resources (tenant_id, name) values (v_a, 'Studio A') returning id into v_rs_a;
  insert into public.offering_templates (tenant_id, name, duration_minutes)
    values (v_b, 'Heat', 45) returning id into v_ot_b;
  insert into public.resources (tenant_id, name) values (v_b, 'Studio B') returning id into v_rs_b;

  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
    values (v_a, v_ot_a, v_rs_a, now() + interval '2 hours', now() + interval '3 hours', 2, 'published', now())
    returning id into v_sa_pub;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status)
    values (v_a, v_ot_a, v_rs_a, now() + interval '4 hours', now() + interval '5 hours', 2, 'draft')
    returning id into v_sa_draft;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
    values (v_b, v_ot_b, v_rs_b, now() + interval '2 hours', now() + interval '3 hours', 4, 'published', now())
    returning id into v_sb_pub;
  insert into public.scheduled_sessions
    (tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status)
    values (v_b, v_ot_b, v_rs_b, now() + interval '4 hours', now() + interval '5 hours', 4, 'draft')
    returning id into v_sb_draft;

  insert into public.people (tenant_id, first_name, source)
    values (v_a, 'MA', 'native') returning id into v_pa;
  insert into public.bookings (tenant_id, session_id, person_id, status, booked_via, idempotency_key)
    values (v_a, v_sa_pub, v_pa, 'booked', 'desk', 'seed-35-a');

  -- --- THE ALLOWLIST: the RETURNS TABLE output carries EXACTLY the 8 public
  --     columns, in contract order — no person/attendee column can exist. ----
  -- A RETURNS TABLE function's prorettype is the `record` pseudo-type (no
  -- typrelid), so it has NO pg_attribute rows — the table columns live in
  -- pg_proc.proargnames where proargmodes = 't' (table-output mode). Read them
  -- there; joining prorettype→pg_attribute would yield NULL and fail falsely.
  select array_agg(u.name order by u.ord) into v_cols
  from pg_proc p,
    lateral unnest(p.proargnames, p.proargmodes) with ordinality as u(name, mode, ord)
  where p.pronamespace = 'public'::regnamespace and p.proname = 'member_schedule'
    and u.mode = 't';
  perform app_test.assert(
    v_cols = array['session_id', 'offering_name', 'starts_at', 'ends_at',
                   'capacity', 'available', 'readiness_ok', 'credit_cost']::text[],
    '(35) member_schedule return type drifted off the 8-column public allowlist');

  -- --- As the ANON role: the intended public caller. ------------------------
  -- NOTE: earlier blocks (32/33) seeded their own published sessions in both
  -- tenants inside this same transaction, so assertions are MEMBERSHIP-based
  -- (this block's sessions present, its drafts absent), never exact counts.
  set local role anon;

  -- Tenant A: this block's published session appears; its DRAFT (inside the
  -- same window) never does — only the status filter excludes it.
  perform app_test.assert(
    exists (select 1 from public.member_schedule(v_a, now() - interval '1 day', now() + interval '30 days')
            where session_id = v_sa_pub),
    '(35) anon cannot see tenant A''s published session');
  perform app_test.assert(
    not exists (select 1 from public.member_schedule(v_a, now() - interval '1 day', now() + interval '30 days')
                where session_id = v_sa_draft),
    '(35) anon can see a DRAFT session — the published filter is broken');

  -- Tenant scoping: B's call yields B's published session but never A's (nor
  -- B's own draft); A's call never yields B's.
  perform app_test.assert(
    exists (select 1 from public.member_schedule(v_b, now() - interval '1 day', now() + interval '30 days')
            where session_id = v_sb_pub),
    '(35) anon cannot see tenant B''s published session');
  perform app_test.assert(
    not exists (select 1 from public.member_schedule(v_b, now() - interval '1 day', now() + interval '30 days')
                where session_id = v_sb_draft),
    '(35) anon can see tenant B''s DRAFT session');
  perform app_test.assert(
    not exists (select 1 from public.member_schedule(v_b, now() - interval '1 day', now() + interval '30 days')
                where session_id = v_sa_pub),
    '(35) tenant A''s session leaked into tenant B''s schedule');
  perform app_test.assert(
    not exists (select 1 from public.member_schedule(v_a, now() - interval '1 day', now() + interval '30 days')
                where session_id = v_sb_pub),
    '(35) tenant B''s session leaked into tenant A''s schedule');

  -- The attendee booking surfaces ONLY as availability math: capacity 2 with
  -- one active booking → available 1. credit_cost is the fixed v1 one.
  select available into n
  from public.member_schedule(v_a, now() - interval '1 day', now() + interval '30 days')
  where session_id = v_sa_pub;
  perform app_test.assert(n = 1, '(35) availability math drifted from 0040 (expected 1 free seat)');
  perform app_test.assert(
    (select credit_cost
     from public.member_schedule(v_a, now() - interval '1 day', now() + interval '30 days')
     where session_id = v_sa_pub) = 1,
    '(35) credit_cost is not the fixed v1 one-credit cost');

  reset role;

  -- --- Privileges: anon holds EXECUTE on the function but NO direct table
  --     privilege that would bypass the locked return shape. -----------------
  perform app_test.assert(
    has_function_privilege('anon', 'public.member_schedule(uuid, timestamptz, timestamptz)', 'execute'),
    '(35) anon lacks EXECUTE on member_schedule — the public surface is closed');
  perform app_test.assert(
    not has_table_privilege('anon', 'public.scheduled_sessions', 'select'),
    '(35) anon can SELECT scheduled_sessions directly, bypassing member_schedule');
  perform app_test.assert(
    not has_table_privilege('anon', 'public.bookings', 'select'),
    '(35) anon can SELECT bookings directly, bypassing member_schedule');
  perform app_test.assert(
    not has_table_privilege('anon', 'public.booking_holds', 'select'),
    '(35) anon can SELECT booking_holds directly, bypassing member_schedule');
  perform app_test.assert(
    not has_table_privilege('anon', 'public.people', 'select'),
    '(35) anon can SELECT people directly, bypassing member_schedule');
end
$$;

-- ---------------------------------------------------------------------------
-- (36) MEMBER IDENTITY SPINE (migration 0044): person_claims,
--      member_otp_challenges + app.consume_member_otp, member_sessions,
--      claim_codes, member_verification_events. Covers: (a) append-only
--      evidence, (b) hash tables never member-readable + cross-tenant claim
--      isolation, (c) the service-role guard on consume_member_otp,
--      (d) the 5-attempt cap / single-consume / replay / neutral-expiry,
--      (e) the partial-active uniques.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid;
  v_pa uuid; v_pa2 uuid; v_pb uuid;
  v_ok boolean; v_remaining int; v_locked boolean;
  v_attempts int;
  v_cols text[];
  raised boolean;
  i int;
begin
  reset role;
  select val::uuid into v_a from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  -- --- Superuser seeds: two people in A (one for the contact-collision
  --     probe), one person + one ACTIVE claim per tenant. -------------------
  insert into public.people (tenant_id, first_name, source)
    values (v_a, 'Claim A1', 'native') returning id into v_pa;
  insert into public.people (tenant_id, first_name, source)
    values (v_a, 'Claim A2', 'native') returning id into v_pa2;
  insert into public.people (tenant_id, first_name, source)
    values (v_b, 'Claim B1', 'native') returning id into v_pb;

  perform app_test.assert(
    (select claim_frozen from public.people where id = v_pa) = false,
    '(36) people.claim_frozen does not default to false');

  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, claimed_via)
    values (v_a, v_pa, 'a1@example.test', 'email', 'self_email');
  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, claimed_via)
    values (v_b, v_pb, 'b1@example.test', 'email', 'self_email');

  -- --- (b) Grant level: no client role holds ANY privilege that exposes
  --     token or code hashes. ----------------------------------------------
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.member_sessions', 'select')
    and not has_table_privilege('anon', 'public.member_sessions', 'select'),
    '(36) a client role holds SELECT on member_sessions (token hashes exposed)');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.member_otp_challenges', 'select')
    and not has_table_privilege('anon', 'public.member_otp_challenges', 'select'),
    '(36) a client role holds SELECT on member_otp_challenges (code hashes exposed)');
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.person_claims', 'insert')
    and not has_table_privilege('authenticated', 'public.person_claims', 'update'),
    '(36) authenticated can WRITE person_claims directly (status forgery)');
  perform app_test.assert(
    not has_function_privilege('authenticated', 'public.consume_member_otp(uuid, text, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.consume_member_otp(uuid, text, text, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.consume_member_otp(uuid, text, text, text, text)', 'execute'),
    '(36) consume_member_otp EXECUTE is not service-role-only');

  -- --- As tenant B staff (authenticated): own claims visible (resolution
  --     workspace), tenant A claims isolated; hash tables + append-only
  --     evidence + the OTP RPC all refused at the grant level. --------------
  perform app_test.become(v_ub, 'authenticated');

  perform app_test.assert(
    exists (select 1 from public.person_claims where tenant_id = v_b),
    '(36) tenant B staff cannot read their own person_claims (resolution workspace broken)');
  perform app_test.assert(
    not exists (select 1 from public.person_claims where tenant_id = v_a),
    '(36) tenant A person_claims are visible to tenant B staff');

  raised := false;
  begin perform 1 from public.member_sessions limit 1;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(36) authenticated can SELECT member_sessions (token hashes exposed)');

  raised := false;
  begin perform 1 from public.member_otp_challenges limit 1;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(36) authenticated can SELECT member_otp_challenges (code hashes exposed)');

  -- (a) append-only evidence is unwritable at runtime, not just on paper.
  raised := false;
  begin update public.member_verification_events set kind = 'otp_failed';
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(36) authenticated UPDATE on member_verification_events was allowed');
  raised := false;
  begin delete from public.member_verification_events;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(36) authenticated DELETE on member_verification_events was allowed');
  raised := false;
  begin update public.claim_codes set used_at = now();
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(36) authenticated UPDATE on claim_codes was allowed (single-use broken)');

  -- (c) the OTP verdict RPC refuses a non-service-role caller.
  raised := false;
  begin perform public.consume_member_otp(v_a, 'h', 'email', 'h', null);
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(36) authenticated EXECUTE on consume_member_otp was not refused');

  -- --- As anon: nothing member-identity is readable at all. -----------------
  -- become() is SUPERUSER-only; we are still 'authenticated' from the block
  -- above, so drop back to superuser before re-impersonating (the same reset
  -- every other block does between become() calls).
  reset role;
  perform app_test.become(null, 'anon');
  -- anon holds NO table privilege on the identity tables at all — a bare
  -- SELECT raises `permission denied` before RLS is even consulted, so assert
  -- the grant is absent (stronger than an RLS-filtered empty result).
  perform app_test.assert(
    not has_table_privilege('anon', 'public.person_claims', 'select'),
    '(36) anon holds SELECT on person_claims');
  perform app_test.assert(
    not has_table_privilege('anon', 'public.claim_codes', 'select'),
    '(36) anon holds SELECT on claim_codes');

  reset role;

  -- --- (c) The IN-BODY guard itself: bypass the grant check with the
  --     superuser session but present a non-service-role JWT → 42501. --------
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated')::text, true);
  raised := false;
  begin perform app.consume_member_otp(v_a, 'h', 'email', 'h', null);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised,
    '(36) consume_member_otp in-body guard accepted a non-service-role JWT');

  -- --- (d) OTP semantics as the service role. -------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('role', 'service_role')::text, true);

  -- The verdict shape is EXACTLY (success, remaining_attempts, locked) — no
  -- code_hash, contact, or expiry oracle can ever join the return type.
  select array_agg(u.name order by u.ord) into v_cols
  from pg_proc p,
    lateral unnest(p.proargnames, p.proargmodes) with ordinality as u(name, mode, ord)
  where p.pronamespace = 'app'::regnamespace and p.proname = 'consume_member_otp'
    and u.mode = 't';
  perform app_test.assert(
    v_cols = array['success', 'remaining_attempts', 'locked']::text[],
    '(36) consume_member_otp returns more than the neutral verdict (hash/oracle leak)');

  -- Five wrong tries lock; the 6th — even with the CORRECT code — is refused
  -- without a comparison and without burning an attempt.
  insert into public.member_otp_challenges (tenant_id, contact_hash, channel, code_hash, expires_at)
    values (v_a, 'contact-hash-1', 'email', 'correct-hash-1', now() + interval '10 minutes');
  for i in 1..5 loop
    select success, remaining_attempts, locked into v_ok, v_remaining, v_locked
      from app.consume_member_otp(v_a, 'contact-hash-1', 'email', 'wrong-hash', 'ip-1');
    perform app_test.assert(not v_ok, '(36) a wrong OTP reported success on try ' || i);
  end loop;
  perform app_test.assert(v_locked and v_remaining = 0,
    '(36) the 5th wrong OTP try did not lock the challenge');
  select success, remaining_attempts, locked into v_ok, v_remaining, v_locked
    from app.consume_member_otp(v_a, 'contact-hash-1', 'email', 'correct-hash-1', 'ip-1');
  perform app_test.assert(not v_ok and v_locked,
    '(36) a 6th try bypassed the 5-attempt cap with the CORRECT code');
  select attempts into v_attempts from public.member_otp_challenges
    where tenant_id = v_a and contact_hash = 'contact-hash-1';
  perform app_test.assert(v_attempts = 5,
    '(36) the locked 6th try burned an attempt (cap bypass)');

  -- The correct code consumes EXACTLY once; a replay of the same code fails.
  insert into public.member_otp_challenges (tenant_id, contact_hash, channel, code_hash, expires_at)
    values (v_a, 'contact-hash-2', 'sms', 'correct-hash-2', now() + interval '10 minutes');
  select success, remaining_attempts, locked into v_ok, v_remaining, v_locked
    from app.consume_member_otp(v_a, 'contact-hash-2', 'sms', 'correct-hash-2', 'ip-2');
  perform app_test.assert(v_ok, '(36) the correct OTP was refused on a live challenge');
  select success, remaining_attempts, locked into v_ok, v_remaining, v_locked
    from app.consume_member_otp(v_a, 'contact-hash-2', 'sms', 'correct-hash-2', 'ip-2');
  perform app_test.assert(not v_ok, '(36) a replayed OTP consumed a second time');

  -- Expired and unknown contacts return the SAME neutral failure and burn
  -- no attempt (anti-enumeration).
  insert into public.member_otp_challenges (tenant_id, contact_hash, channel, code_hash, expires_at)
    values (v_a, 'contact-hash-3', 'email', 'correct-hash-3', now() - interval '1 minute');
  select success, remaining_attempts, locked into v_ok, v_remaining, v_locked
    from app.consume_member_otp(v_a, 'contact-hash-3', 'email', 'correct-hash-3', 'ip-3');
  perform app_test.assert(not v_ok and v_remaining = 0 and not v_locked,
    '(36) an expired challenge did not fail with the neutral shape');
  select attempts into v_attempts from public.member_otp_challenges
    where tenant_id = v_a and contact_hash = 'contact-hash-3';
  perform app_test.assert(v_attempts = 0, '(36) an expired challenge burned an attempt');
  select success, remaining_attempts, locked into v_ok, v_remaining, v_locked
    from app.consume_member_otp(v_a, 'no-such-contact', 'email', 'any-hash', null);
  perform app_test.assert(not v_ok and v_remaining = 0 and not v_locked,
    '(36) an unknown contact leaked a distinguishable failure shape');

  -- Every outcome appended to the append-only audit (hashes only).
  perform app_test.assert(
    (select count(*) from public.member_verification_events
      where tenant_id = v_a and kind = 'otp_failed' and contact_hash = 'contact-hash-1') = 5,
    '(36) failed OTP attempts were not audited');
  perform app_test.assert(
    exists (select 1 from public.member_verification_events
      where tenant_id = v_a and kind = 'otp_verified' and contact_hash = 'contact-hash-2'),
    '(36) the verified OTP was not audited');

  -- --- (e) The partial-active uniques. ---------------------------------------
  raised := false;
  begin
    insert into public.person_claims (tenant_id, person_id, verified_contact, channel, claimed_via)
      values (v_a, v_pa, 'a1-alt@example.test', 'email', 'self_email');
  exception when unique_violation then raised := true; end;
  perform app_test.assert(raised, '(36) a second ACTIVE claim per person was allowed');

  raised := false;
  begin
    insert into public.person_claims (tenant_id, person_id, verified_contact, channel, claimed_via)
      values (v_a, v_pa2, 'a1@example.test', 'sms', 'self_sms');
  exception when unique_violation then raised := true; end;
  perform app_test.assert(raised, '(36) a second ACTIVE claim per (tenant, contact) was allowed');

  -- Non-active rows never collide: needs_resolution and revoked coexist with
  -- the active claim on the same person/contact (the resolution path).
  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, status, claimed_via)
    values (v_a, v_pa2, 'a1@example.test', 'email', 'needs_resolution', 'self_email');
  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, status, claimed_via)
    values (v_a, v_pa, 'a1@example.test', 'email', 'revoked', 'self_email');
end
$$;

-- (37) MEMBER AUTH RESOLUTION CORE (unit 8.2b — the API session path over
--      migration 0044; this unit adds NO new table, so there is no new
--      member-readable grant surface to probe — the generic guard (1) already
--      covers the 0044 tables). Covers: (a) a session for person A can never
--      resolve to person B (composite FK + the session→claim join shape);
--      (b) the token_hash lookup path is service-role-only, including
--      slide/un-revoke forgery; (c) a needs_resolution claim exposes NO
--      balances; (d) the partial-active uniqueness holds under a double
--      self-claim while duplicate needs_resolution holds stay retry-safe.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_ub uuid;
  v_pa uuid; v_pa2 uuid; v_pb uuid;
  v_session uuid;
  v_claim uuid;
  raised boolean;
begin
  reset role;
  select val::uuid into v_a from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ub from app_test.ctx where key = 'user_b';

  -- Reuse the 0044 seeds from block (36) (same transaction): v_pa carries an
  -- ACTIVE claim on 'a1@example.test'; v_pa2 carries a needs_resolution row.
  select id into v_pa from public.people where tenant_id = v_a and first_name = 'Claim A1';
  select id into v_pa2 from public.people where tenant_id = v_a and first_name = 'Claim A2';
  select id into v_pb from public.people where tenant_id = v_b and first_name = 'Claim B1';

  -- --- (a1) The composite FK: a session cannot pair tenant A with a person
  --     belonging to tenant B (the 0026 tenant_users pattern). --------------
  raised := false;
  begin
    insert into public.member_sessions
      (tenant_id, person_id, token_hash, expires_at, absolute_expires_at)
    values (v_a, v_pb, 'cross-tenant-session', now() + interval '90 days', now() + interval '12 months');
  exception when foreign_key_violation then raised := true; end;
  perform app_test.assert(raised,
    '(37) a member session paired tenant A with tenant B''s person');

  -- --- (a2) The resolve join shape (what resolveMember runs): a session for
  --     person A resolves ONLY person A''s ACTIVE claim — tenant B''s active
  --     claim and person A''s non-active history stay invisible to it. ------
  insert into public.member_sessions
    (tenant_id, person_id, token_hash, expires_at, absolute_expires_at)
  values (v_a, v_pa, 'session-hash-a', now() + interval '90 days', now() + interval '12 months')
  returning id into v_session;

  select pc.id into v_claim
  from public.member_sessions s
  join public.person_claims pc
    on pc.tenant_id = s.tenant_id
   and pc.person_id = s.person_id
   and pc.status = 'active'
  where s.id = v_session;
  perform app_test.assert(
    v_claim = (select id from public.person_claims
               where tenant_id = v_a and person_id = v_pa and status = 'active'),
    '(37) the session→claim join did not resolve person A''s own ACTIVE claim');
  perform app_test.assert(
    not exists (
      select 1
      from public.member_sessions s
      join public.person_claims pc
        on pc.tenant_id = s.tenant_id
       and pc.person_id = s.person_id
       and pc.status = 'active'
      where s.id = v_session and pc.person_id <> v_pa),
    '(37) a session for person A resolved a claim belonging to another person');

  -- --- (b) The token_hash path is service-role-only: no client role can
  --     read sessions, forge a slide, or un-revoke. --------------------------
  perform app_test.assert(
    not has_table_privilege('authenticated', 'public.member_sessions', 'update')
    and not has_table_privilege('anon', 'public.member_sessions', 'update')
    and not has_table_privilege('authenticated', 'public.member_sessions', 'delete')
    and not has_table_privilege('anon', 'public.member_sessions', 'delete'),
    '(37) a client role holds UPDATE/DELETE on member_sessions (slide/revoke forgery)');

  perform app_test.become(v_ub, 'authenticated');
  raised := false;
  begin
    perform 1 from public.member_sessions where token_hash = 'session-hash-a';
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(37) authenticated read member_sessions by token_hash');
  raised := false;
  begin
    update public.member_sessions set revoked_at = null where id = v_session;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(37) authenticated forged a session slide/un-revoke');
  reset role;

  -- --- (c) A needs_resolution claim exposes NO balances. --------------------
  -- Seed a balance fact for v_pa2 (whose claim is needs_resolution — exactly
  -- the state a pre-resolution member session sits in).
  insert into public.credit_ledger (tenant_id, person_id, entry_type, delta, source)
    values (v_a, v_pa2, 'grant', 5, 'native');

  -- Claim state can never become a balance grant: no credit_ledger policy
  -- consults person_claims at all.
  perform app_test.assert(
    not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = 'credit_ledger'
        and (p.qual ilike '%person_claims%' or p.with_check ilike '%person_claims%')),
    '(37) a credit_ledger policy consults person_claims (claim state could leak balances)');

  -- Cross-tenant staff see neither the balance nor the claim behind it.
  perform app_test.become(v_ub, 'authenticated');
  perform app_test.assert(
    not exists (select 1 from public.credit_ledger where tenant_id = v_a and person_id = v_pa2),
    '(37) tenant B staff read tenant A balances behind a needs_resolution claim');
  reset role;
  perform app_test.become(null, 'anon');
  raised := false;
  begin
    perform 1 from public.credit_ledger limit 1;
  exception when others then raised := true; end;
  perform app_test.assert(raised, '(37) anon read credit_ledger balances');
  reset role;

  -- --- (d) The partial-active uniqueness under a DOUBLE self-claim: the
  --     second ACTIVE claim for the same person+contact loses; duplicate
  --     needs_resolution holds stay retry-safe (they never collide). --------
  raised := false;
  begin
    insert into public.person_claims (tenant_id, person_id, verified_contact, channel, claimed_via)
      values (v_a, v_pa, 'a1@example.test', 'email', 'self_email');
  exception when unique_violation then raised := true; end;
  perform app_test.assert(raised, '(37) a double self-claim inserted a second ACTIVE claim');

  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, status, claimed_via)
    values (v_a, v_pa2, 'a1@example.test', 'email', 'needs_resolution', 'self_email');
  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, status, claimed_via)
    values (v_a, v_pa2, 'a1@example.test', 'email', 'needs_resolution', 'self_email');
  perform app_test.assert(
    (select count(*) from public.person_claims
      where tenant_id = v_a and person_id = v_pa2 and status = 'needs_resolution') >= 2,
    '(37) needs_resolution holds collided (a held claim must stay re-insertable)');
end
$$;

-- ===========================================================================
-- (38) MEMBER SESSION ROTATION (migration 0045): app.refresh_member_session —
--      service-role-only, single-use rotation that INHERITS the absolute cap,
--      and reuse-detection that burns the entire rotation family.
-- ===========================================================================
do $$
declare
  v_a uuid; v_person uuid;
  v_abs timestamptz := now() + interval '300 days';
  v_s1 uuid; v_child uuid;
  v_outcome text; v_new_abs timestamptz;
  raised boolean;
begin
  reset role;
  select val::uuid into v_a from app_test.ctx where key = 'tenant_a';
  insert into public.people (tenant_id, first_name, source)
    values (v_a, 'Rot A', 'native') returning id into v_person;
  insert into public.person_claims (tenant_id, person_id, verified_contact, channel, claimed_via)
    values (v_a, v_person, 'rot@example.test', 'email', 'self_email');

  -- Grant posture (the 8.2a Supabase-default-grant lesson): NO client role may
  -- EXECUTE the wrapper; only service_role.
  perform app_test.assert(
    not has_function_privilege('authenticated', 'public.refresh_member_session(text, text)', 'execute')
    and not has_function_privilege('anon', 'public.refresh_member_session(text, text)', 'execute')
    and has_function_privilege('service_role', 'public.refresh_member_session(text, text)', 'execute'),
    '(38) refresh_member_session EXECUTE is not service-role-only');

  -- In-body service-role guard: an authenticated JWT is refused (42501).
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  raised := false;
  begin perform app.refresh_member_session('hash-x', 'hash-y');
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(38) refresh_member_session accepted a non-service-role JWT');

  -- As the service role: seed a LIVE session and rotate it.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  insert into public.member_sessions
    (tenant_id, person_id, token_hash, expires_at, absolute_expires_at, platform)
    values (v_a, v_person, 'hash-1', now() + interval '90 days', v_abs, 'web')
    returning id into v_s1;

  select r.outcome, r.absolute_expires_at into v_outcome, v_new_abs
    from app.refresh_member_session('hash-1', 'hash-2') r;
  perform app_test.assert(v_outcome = 'rotated', '(38) a live session did not rotate');

  -- Old revoked; child exists linking rotated_from; absolute cap INHERITED
  -- (rotation must never reset the 12-month hard cap).
  perform app_test.assert(
    (select revoked_at is not null from public.member_sessions where id = v_s1),
    '(38) the rotated (old) session was not revoked');
  select id into v_child from public.member_sessions where token_hash = 'hash-2';
  perform app_test.assert(v_child is not null, '(38) rotation minted no child session');
  perform app_test.assert(
    (select rotated_from from public.member_sessions where id = v_child) = v_s1,
    '(38) the child session does not link rotated_from to the old one');
  perform app_test.assert(v_new_abs = v_abs,
    '(38) rotation EXTENDED the absolute cap (must inherit, never reset)');

  -- REUSE: replay the now-revoked-and-rotated 'hash-1' → the whole family burns
  -- (both the old node AND the live child), and no new session is minted.
  select r.outcome into v_outcome from app.refresh_member_session('hash-1', 'hash-3') r;
  perform app_test.assert(v_outcome = 'reuse', '(38) a replayed rotated token was not flagged reuse');
  perform app_test.assert(
    (select revoked_at is not null from public.member_sessions where id = v_child),
    '(38) reuse-detection did not revoke the live family member (token theft persists)');
  perform app_test.assert(
    not exists (select 1 from public.member_sessions where token_hash = 'hash-3'),
    '(38) reuse-detection still minted a new session');

  -- A plain LOGGED-OUT token (revoked, NO child) must return 'revoked' — the
  -- has_child gate must NOT false-burn an ordinary logout as a reuse attack.
  insert into public.member_sessions
    (tenant_id, person_id, token_hash, expires_at, absolute_expires_at, platform, revoked_at)
    values (v_a, v_person, 'hash-loggedout', now() + interval '90 days', v_abs, 'web', now());
  select r.outcome into v_outcome from app.refresh_member_session('hash-loggedout', 'hash-4') r;
  perform app_test.assert(v_outcome = 'revoked',
    '(38) a plain logged-out token was mis-flagged (false family burn on logout)');
  perform app_test.assert(
    not exists (select 1 from public.member_sessions where token_hash = 'hash-4'),
    '(38) a logged-out refresh still minted a new session');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ===========================================================================
-- (39) MEMBER WAIVER SIGNING (migration 0046): app.record_waiver_signature
--      member_portal branch — service-role-only self-serve capture, active
--      version only, idempotent. Proves an authenticated STAFF client (even a
--      tenant OWNER, who passes the desk branch) can NOT forge a member's legal
--      signature, and a double-submit yields exactly one evidence row.
-- ===========================================================================
do $$
declare
  v_a uuid; v_person uuid; v_active uuid; v_draft uuid;
  v_sig1 uuid; v_sig2 uuid;
  raised boolean;
begin
  reset role;
  select val::uuid into v_a from app_test.ctx where key = 'tenant_a';
  insert into public.people (tenant_id, first_name, source)
    values (v_a, 'Waiver A', 'native') returning id into v_person;
  -- A live relationship makes current_waiver_status.needs_signature genuinely
  -- TRUE pre-sign (it gates on has-relationship), so the flip-to-false below is
  -- a real signal of the signature, not a vacuous no-op.
  insert into public.person_relationships (tenant_id, person_id, relationship_type, rule_version)
    values (v_a, v_person, 'recurring_member', 1);
  insert into public.waiver_versions (tenant_id, version, title, body, active)
    values (v_a, 1, 'Liability', 'You assume all risk of sauna and cold plunge.', true)
    returning id into v_active;
  insert into public.waiver_versions (tenant_id, version, title, body, active)
    values (v_a, 2, 'Draft', 'A newer draft, not yet activated.', false)
    returning id into v_draft;

  -- The partial-unique idempotency backstop exists independent of the in-body
  -- pre-check (the race safety net).
  perform app_test.assert(
    exists (select 1 from pg_indexes
            where schemaname = 'public' and indexname = 'waiver_signatures_member_portal_once'),
    '(39) waiver_signatures_member_portal_once index is missing');

  -- (a) An authenticated tenant OWNER — a role that WOULD pass the desk branch
  --     — is refused on member_portal. The gate is service-role, not role-based.
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  raised := false;
  begin
    perform app.record_waiver_signature(
      v_a, v_person, v_active, 'Imposter', true, 'member_portal', null, null, null, null);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised,
    '(39) an authenticated client forged a member_portal waiver signature');

  -- (b) anon → refused too.
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  raised := false;
  begin
    perform app.record_waiver_signature(
      v_a, v_person, v_active, 'Anon', true, 'member_portal', null, null, null, null);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(39) an anon client signed a member_portal waiver');

  -- Everything below is the legitimate service-role (member API) path.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- (c) A NON-active version is refused (22023) — member capture must use the
  --     active version (which the API resolves server-side, never the request).
  raised := false;
  begin
    perform app.record_waiver_signature(
      v_a, v_person, v_draft, 'Member', true, 'member_portal', null, null, null, null);
  exception when invalid_parameter_value then raised := true; end;
  perform app_test.assert(raised, '(39) member_portal signed a NON-active waiver version');

  -- (d) A foreign / nonexistent person → P0002.
  raised := false;
  begin
    perform app.record_waiver_signature(
      v_a, gen_random_uuid(), v_active, 'Ghost', true, 'member_portal', null, null, null, null);
  exception when no_data_found then raised := true; end;
  perform app_test.assert(raised, '(39) member_portal signed for a nonexistent person');

  -- Pre-sign: the member genuinely NEEDS to sign (has a relationship + an
  -- active version + no signature). This makes the post-sign flip meaningful.
  perform app_test.assert(
    (select needs_signature from public.current_waiver_status(v_a, v_person)) = true,
    '(39) needs_signature was not TRUE before the member signed (vacuous test guard)');

  -- (e) Legitimate sign of the ACTIVE version → succeeds; exactly one row.
  v_sig1 := app.record_waiver_signature(
    v_a, v_person, v_active, 'Member Name', true, 'member_portal', 'iphash', 'UA/1.0', null, null);
  perform app_test.assert(v_sig1 is not null, '(39) a legitimate member sign returned no id');
  perform app_test.assert(
    (select count(*) from public.waiver_signatures
      where tenant_id = v_a and person_id = v_person and source = 'member_portal') = 1,
    '(39) a legitimate member sign did not write exactly one row');
  -- Post-sign: current_waiver_status now agrees the member is covered (the
  -- signature FLIPPED needs_signature true → false).
  perform app_test.assert(
    (select needs_signature from public.current_waiver_status(v_a, v_person)) = false,
    '(39) needs_signature stayed true after a member sign');

  -- (f) Idempotent double-submit (retry with different attribution) → SAME row.
  v_sig2 := app.record_waiver_signature(
    v_a, v_person, v_active, 'Member Name', true, 'member_portal', 'iphash2', 'UA/2.0', null, null);
  perform app_test.assert(v_sig2 = v_sig1, '(39) a member double-submit minted a new signature id');
  perform app_test.assert(
    (select count(*) from public.waiver_signatures
      where tenant_id = v_a and person_id = v_person and source = 'member_portal') = 1,
    '(39) a member double-submit wrote a duplicate evidence row');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ===========================================================================
-- (40) STEP-UP AUTH (migration 0026): app.set_step_up_pin — the re-auth gate in
--      front of money + data-rights operations. Restores invariant #7 coverage
--      for this RPC: the role-escalation guard, cross-tenant refusal,
--      actor<>caller, and the owner/manager aal2 (MFA) requirement; a legit
--      owner→strictly-lower-role set still works.
-- ===========================================================================
do $$
declare
  v_a uuid; v_b uuid; v_ua uuid; v_ub uuid; v_uf uuid;
  h text := 'scrypt$32768$8$1$' || repeat('A', 22) || '$' || repeat('A', 43);
  raised boolean;
begin
  reset role;
  select val::uuid into v_a from app_test.ctx where key = 'tenant_a';
  select val::uuid into v_b from app_test.ctx where key = 'tenant_b';
  select val::uuid into v_ua from app_test.ctx where key = 'user_a'; -- owner in tenant A
  select val::uuid into v_ub from app_test.ctx where key = 'user_b'; -- owner in tenant B
  -- A front_desk user in tenant A (a role that must NOT set a higher-role PIN).
  insert into auth.users (id, email) values (gen_random_uuid(), 'stepup-fd@example.test')
    returning id into v_uf;
  insert into public.tenant_users (tenant_id, user_id, role) values (v_a, v_uf, 'front_desk');

  -- (a) a front_desk actor CANNOT set the owner's PIN (role escalation).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uf, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  raised := false;
  begin perform app.set_step_up_pin(v_a, v_ua, h, v_uf);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(40) front_desk set a higher-role step-up PIN (escalation)');

  -- (b) cross-tenant: a tenant-A owner cannot set a PIN in tenant B (no membership).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ua, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  raised := false;
  begin perform app.set_step_up_pin(v_b, v_ub, h, v_ua);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(40) a foreign-tenant actor set a step-up PIN');

  -- (c) actor <> authenticated caller.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uf, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  raised := false;
  begin perform app.set_step_up_pin(v_a, v_ua, h, v_ua);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(40) set_step_up_pin accepted actor <> caller');

  -- (d) an owner/manager PIN change WITHOUT aal2 (MFA) is refused — a
  --     magic-link/password session must not become PIN-reset authority.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ua, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  raised := false;
  begin perform app.set_step_up_pin(v_a, v_ua, h, v_ua);
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(40) an owner set a PIN without aal2 MFA');

  -- (e) an aal2 owner setting a strictly-lower (front_desk) PIN SUCCEEDS.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ua, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform app.set_step_up_pin(v_a, v_uf, h, v_ua);
  perform app_test.assert(
    (select step_up_pin_hash = h from public.tenant_users where tenant_id = v_a and user_id = v_uf),
    '(40) a legitimate owner->front_desk PIN set did not persist');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ===========================================================================
-- (41) WAIVER LIFECYCLE IMMUTABILITY (migration 0028): the legal-consent
--      record must be tamper-evident. app.protect_waiver_version makes an
--      ACTIVE (or signed) version's identity/text immutable and undeletable
--      (errcode 23503), and app.activate_waiver_version enforces EXACTLY ONE
--      active version per tenant — activating v2 demotes v1 atomically. A
--      mutated/duplicated active waiver would let a member be bound to text
--      they never saw, or void a signature retroactively.
-- ===========================================================================
do $$
declare
  v_t uuid; v_u uuid; v1 uuid; v2 uuid; raised boolean; n_active int; a1 boolean; a2 boolean;
begin
  reset role;
  -- A FRESH tenant + owner: tenant_a already carries an active waiver (block 39),
  -- and the one-active partial unique index would reject a second active row.
  insert into public.tenants (name, slug)
    values ('Waiver Immut', 'waiver-immut-' || substr(gen_random_uuid()::text, 1, 8))
    returning id into v_t;
  insert into auth.users (id, email)
    values (gen_random_uuid(), 'waiver-immut-owner@example.test') returning id into v_u;
  insert into public.tenant_users (tenant_id, user_id, role) values (v_t, v_u, 'owner');

  insert into public.waiver_versions (tenant_id, version, title, body, active)
    values (v_t, 1, 'Liability v1', 'Bound text one', true) returning id into v1;
  insert into public.waiver_versions (tenant_id, version, title, body, active)
    values (v_t, 2, 'Liability v2', 'Bound text two', false) returning id into v2;

  -- (a) the ACTIVE version's bound text is immutable (23503 = foreign_key_violation).
  raised := false;
  begin update public.waiver_versions set body = 'tampered' where id = v1;
  exception when foreign_key_violation then raised := true; end;
  perform app_test.assert(raised, '(41) an active waiver version''s bound text was mutated');

  -- (b) an ACTIVE version cannot be deleted — the audit trail can''t be erased.
  raised := false;
  begin delete from public.waiver_versions where id = v1;
  exception when foreign_key_violation then raised := true; end;
  perform app_test.assert(raised, '(41) an active waiver version was deleted');

  -- (c) activating v2 (as the tenant owner) demotes v1 → EXACTLY one active.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
  perform app.activate_waiver_version(v_t, v2, v_u);
  perform set_config('request.jwt.claims', '{}', true);
  select active into a1 from public.waiver_versions where id = v1;
  select active into a2 from public.waiver_versions where id = v2;
  select count(*) into n_active from public.waiver_versions where tenant_id = v_t and active;
  perform app_test.assert(a1 = false, '(41) v1 stayed active after v2 was activated');
  perform app_test.assert(a2 = true,  '(41) v2 was not activated');
  perform app_test.assert(n_active = 1, '(41) more than one active waiver version per tenant');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ===========================================================================
-- (42) CAMPAIGN APPROVAL IMMUTABILITY (migration 0024): a comms send to real
--      members must go through the ApprovalCeremony (app.approve_campaign, a
--      SECURITY DEFINER path). app.protect_campaign_approval refuses, for a
--      direct `authenticated` write: editing an already-approved/sending/sent
--      campaign, and forging an approval by setting status/approved_by/
--      approved_at directly (both 42501). Editing a still-draft campaign
--      stays allowed. A bypass here would let un-reviewed copy reach members.
-- ===========================================================================
do $$
declare
  v_t uuid; v_u uuid; c_appr uuid; c_draft uuid; raised boolean;
begin
  reset role;
  insert into public.tenants (name, slug)
    values ('Camp Immut', 'camp-immut-' || substr(gen_random_uuid()::text, 1, 8))
    returning id into v_t;
  insert into auth.users (id, email)
    values (gen_random_uuid(), 'camp-immut-owner@example.test') returning id into v_u;
  insert into public.tenant_users (tenant_id, user_id, role) values (v_t, v_u, 'owner');

  -- Seeded as the suite role: the BEFORE-UPDATE trigger does not fire on insert.
  insert into public.campaigns (tenant_id, name, segment_key, template_key, channel, kind,
      draft_subject, draft_body, status, approved_by, approved_at)
    values (v_t, 'Approved One', 'at_risk', 'winback', 'email', 'marketing',
      'Subj', 'Body text', 'approved', v_u, now()) returning id into c_appr;
  insert into public.campaigns (tenant_id, name, segment_key, template_key, channel, kind,
      draft_subject, draft_body, status)
    values (v_t, 'Draft One', 'at_risk', 'winback', 'email', 'marketing',
      'Subj', 'Draft body', 'draft') returning id into c_draft;

  -- The trigger only guards the `authenticated` role; RLS (campaigns_update)
  -- passes because the owner belongs to the tenant.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
  set role authenticated;

  -- (a) an already-APPROVED campaign is frozen to direct edits (42501).
  raised := false;
  begin update public.campaigns set draft_body = 'sneaky rewrite' where id = c_appr;
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(42) an approved campaign was edited outside approve_campaign()');

  -- (b) an approval cannot be FORGED by a direct status/approver write (42501).
  raised := false;
  begin update public.campaigns set status = 'approved', approved_by = v_u, approved_at = now()
    where id = c_draft;
  exception when insufficient_privilege then raised := true; end;
  perform app_test.assert(raised, '(42) a campaign approval was forged by a direct write');

  -- (c) positive control: editing a still-DRAFT body (no approval fields) works.
  update public.campaigns set draft_body = 'legitimately refined draft' where id = c_draft;
  perform app_test.assert(
    (select draft_body from public.campaigns where id = c_draft) = 'legitimately refined draft',
    '(42) a legitimate draft-body edit was blocked');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

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
