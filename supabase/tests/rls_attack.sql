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
--      HERE, not in production. Explicit list (comment-driven enumeration missed
--      the pre-comment-convention ledgers). Add new append-only tables here.
do $$
declare
  t text;
  role_name text;
begin
  reset role;
  foreach t in array array[
    'credit_ledger', 'gift_card_ledger', 'waiver_signatures', 'audit_events',
    'communication_consents', 'step_up_events', 'person_relationship_log',
    'briefing_feedback', 'campaign_attributions', 'person_deletions',
    'ask_misses', 'schedule_publish_log', 'plan_prices', 'dunning_states',
    'verify_runs'
  ] loop
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      perform app_test.assert(
        not has_table_privilege(role_name, format('public.%I', t), 'UPDATE'),
        format('(26) append-only public.%s grants UPDATE to %s', t, role_name));
      perform app_test.assert(
        not has_table_privilege(role_name, format('public.%I', t), 'DELETE'),
        format('(26) append-only public.%s grants DELETE to %s', t, role_name));
    end loop;
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
  v_status text; n int; raised boolean;
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

  -- Cross-tenant: uB cannot record an intent for tenant A.
  raised := false;
  begin
    perform app.create_payment_intent(v_a, v_cust_b, 5000, 'usd', 'pi-x', v_ub);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(28) uB could create_payment_intent for tenant A');

  -- A customer that is not tenant B's is rejected.
  raised := false;
  begin
    perform app.create_payment_intent(v_b, gen_random_uuid(), 5000, 'usd', 'pi-y', v_ub);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(28) create_payment_intent accepted a foreign customer');

  -- Actor spoof: the actor must be the authenticated caller.
  raised := false;
  begin
    perform app.create_payment_intent(v_b, v_cust_b, 5000, 'usd', 'pi-z', v_ua);
  exception when others then raised := true;
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

  -- Over-refund: remaining is 8000 - 3000 = 5000; 6000 must be refused.
  raised := false;
  begin
    perform app.create_refund(v_b, v_succ, 6000, 'rf-b-2', v_ub, null);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(28) create_refund allowed exceeding the refundable amount');

  -- A non-succeeded (processing) payment cannot be refunded.
  raised := false;
  begin
    perform app.create_refund(v_b, v_proc, 100, 'rf-proc', v_ub, null);
  exception when others then raised := true;
  end;
  perform app_test.assert(raised, '(28) create_refund allowed refunding a non-succeeded payment');

  -- Cross-tenant refund is refused.
  raised := false;
  begin
    perform app.create_refund(v_a, v_succ, 100, 'rf-x', v_ub, null);
  exception when others then raised := true;
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
