-- Phase 0 · unit 2 — RLS helper functions (schema app).
-- SECURITY DEFINER so policies don't recurse through tenant_users RLS; they expose
-- only membership ids / booleans, never rows. STABLE so the planner can cache them
-- within a statement. `set search_path = ''` forces full schema qualification inside.

create or replace function app.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tu.tenant_id
  from public.tenant_users tu
  where tu.user_id = (select auth.uid())
    and tu.status = 'active';
$$;

create or replace function app.has_tenant_role(p_tenant uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_users tu
    where tu.user_id = (select auth.uid())
      and tu.tenant_id = p_tenant
      and tu.status = 'active'
      and tu.role = any (p_roles)
  );
$$;

-- Least privilege: functions default to EXECUTE-for-PUBLIC; strip that, then allow
-- only the two roles that carry RLS-evaluated queries. Schema USAGE is required in
-- addition to EXECUTE, so grant it explicitly (a fresh schema grants PUBLIC nothing).
revoke all on function app.current_tenant_ids() from public;
revoke all on function app.has_tenant_role(uuid, text[]) from public;
grant usage on schema app to authenticated, service_role;
grant execute on function app.current_tenant_ids() to authenticated, service_role;
grant execute on function app.has_tenant_role(uuid, text[]) to authenticated, service_role;
