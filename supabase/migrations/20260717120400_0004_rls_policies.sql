-- Phase 0 · unit 2 — RLS enablement, membership-based policies, least-privilege grants.
-- Policies check MEMBERSHIP (tenant_users rows via definer helpers), not JWT claims
-- alone — claims go stale, membership rows don't (invariant #7).

alter table public.tenants enable row level security;
alter table public.locations enable row level security;
alter table public.tenant_users enable row level security;
alter table public.tenant_invitations enable row level security;
alter table public.audit_events enable row level security;

-- tenants ----------------------------------------------------------------------
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select
  using (id in (select app.current_tenant_ids()));

drop policy if exists tenants_update on public.tenants;
create policy tenants_update on public.tenants
  for update
  using (app.has_tenant_role(id, array['owner', 'manager']))
  with check (app.has_tenant_role(id, array['owner', 'manager']));
-- No insert/delete policy → denied for clients; the service role bypasses RLS.

-- locations ----------------------------------------------------------------------
drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists locations_delete on public.locations;
create policy locations_delete on public.locations
  for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

-- tenant_users -------------------------------------------------------------------
-- Membership writes are OWNER-only and NEVER self-directed. The previous
-- owner-or-manager policies let a manager UPDATE their own row to role='owner'
-- (intra-tenant privilege escalation); even an owner cannot modify their own
-- membership row — another owner (or break-glass via the service role) must.
-- Managers invite via tenant_invitations; the accept-invite flow creates rows
-- under the service role, which bypasses RLS, so owner-only client INSERT breaks
-- nothing. GRANTs stay as they are — RLS is the gate.
drop policy if exists tenant_users_select on public.tenant_users;
create policy tenant_users_select on public.tenant_users
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists tenant_users_insert on public.tenant_users;
create policy tenant_users_insert on public.tenant_users
  for insert
  with check (app.has_tenant_role(tenant_id, array['owner']));

drop policy if exists tenant_users_update on public.tenant_users;
create policy tenant_users_update on public.tenant_users
  for update
  using (app.has_tenant_role(tenant_id, array['owner']) and user_id <> (select auth.uid()))
  with check (app.has_tenant_role(tenant_id, array['owner']) and user_id <> (select auth.uid()));

drop policy if exists tenant_users_delete on public.tenant_users;
create policy tenant_users_delete on public.tenant_users
  for delete
  using (app.has_tenant_role(tenant_id, array['owner']) and user_id <> (select auth.uid()));

-- tenant_invitations -------------------------------------------------------------
drop policy if exists tenant_invitations_select on public.tenant_invitations;
create policy tenant_invitations_select on public.tenant_invitations
  for select
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists tenant_invitations_insert on public.tenant_invitations;
create policy tenant_invitations_insert on public.tenant_invitations
  for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists tenant_invitations_update on public.tenant_invitations;
create policy tenant_invitations_update on public.tenant_invitations
  for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists tenant_invitations_delete on public.tenant_invitations;
create policy tenant_invitations_delete on public.tenant_invitations
  for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

-- audit_events -------------------------------------------------------------------
drop policy if exists audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events
  for select
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists audit_events_insert on public.audit_events;
-- Actor-forgery backstop: the Hono API already stamps actor_user_id from the
-- verified session (= auth.uid()) on the user-scoped client; this WITH CHECK is
-- the DB-level backstop so a direct-PostgREST client cannot attribute an event
-- to someone else. actor NULL = system row.
create policy audit_events_insert on public.audit_events
  for insert
  with check (
    tenant_id in (select app.current_tenant_ids())
    and (actor_user_id = (select auth.uid()) or actor_user_id is null)
  );
-- No update/delete policy, ever — corrections append via later definer functions.

-- grants -------------------------------------------------------------------------
-- The operator app is auth-gated: anon gets nothing.
revoke all on public.tenants from anon;
revoke all on public.locations from anon;
revoke all on public.tenant_users from anon;
revoke all on public.tenant_invitations from anon;
revoke all on public.audit_events from anon;

-- authenticated gets a DML privilege only where a corresponding policy exists.
grant select, update on public.tenants to authenticated;
grant select, insert, update, delete on public.locations to authenticated;
grant select, insert, update, delete on public.tenant_users to authenticated;
grant select, insert, update, delete on public.tenant_invitations to authenticated;
grant select, insert on public.audit_events to authenticated;

-- Hard append-only at the DB level (threat model 4b): even the service role cannot
-- mutate evidence rows. Corrections happen only through definer-guarded append fns.
revoke update, delete on public.audit_events from anon, authenticated, service_role;
