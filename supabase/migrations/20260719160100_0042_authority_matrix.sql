-- Phase 7 · unit 7.1a — THE AUTHORITY MATRIX (the cutover ledger).
--
-- Go-live is a SEQUENCE of per-capability authority flips (plan-final §4 step 4:
-- front-desk bookings → new membership sales → cohort migration). This migration
-- ships the APPEND-ONLY record of those flips + the derived "who owns this domain
-- right now" view + the OWNER-only flip RPC. Absence of a flip means Glofox still
-- owns the domain — there is NO seeding; the default is structural (a fresh tenant
-- reads 'glofox' for every domain).
--
-- INVARIANTS enforced here (CLAUDE.md §Standing invariants):
--   * APPEND-ONLY evidence (invariant #6): a flip is a historical FACT — update
--     and delete are revoked from EVERY role (anon, authenticated, service_role);
--     a correction is a NEW flip, never a rewrite. Added to attack block 26's list.
--   * RLS on every tenant table (invariant #7); member-SELECT only, the definer
--     RPC is the sole writer (NO client/service INSERT grant). The RPC re-verifies
--     tenancy + OWNER role in-body (the cutover lever is owner-only) and is
--     idempotent on (tenant, idempotency_key) so a retried flip appends once.
--   * The current_authority VIEW is SECURITY INVOKER, so RLS scopes it to the
--     caller's memberships; a foreign tenant simply yields no rows.

-- ---------------------------------------------------------------------------
-- authority_flips — the append-only per-domain cutover ledger.
-- ---------------------------------------------------------------------------
-- domain is a CLOSED set (the eight capability domains the cutover sequences).
-- authority is 'glofox' | 'kelo'. reason is REQUIRED and non-empty (a flip is an
-- operational decision that must carry its rationale). evidence_url is an optional
-- link to the readiness proof (a dashboard, a runbook run). idempotency_key backs
-- the RPC's replay so a retried request appends exactly one row.
create table public.authority_flips (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  domain          text not null
                  check (domain in (
                    'people', 'bookings', 'schedule', 'memberships',
                    'payments', 'comms', 'waivers', 'retail'
                  )),
  authority       text not null check (authority in ('glofox', 'kelo')),
  reason          text not null check (length(trim(reason)) > 0),
  evidence_url    text,
  actor           uuid not null,
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  -- A flip's idempotency key is unique per tenant — the RPC replays on it.
  unique (tenant_id, idempotency_key)
);

-- The current_authority view reads the LATEST flip per (tenant, domain).
create index authority_flips_tenant_domain_created_idx
  on public.authority_flips (tenant_id, domain, created_at desc);

comment on table public.authority_flips is
  'The APPEND-ONLY per-capability cutover ledger (plan-final §4 step 4). Each row records a domain''s authority flip (glofox↔kelo) with a required reason + optional evidence link. History is never rewritten — a correction is a new flip. Member-read; the OWNER-only definer RPC app.flip_authority is the sole writer. Idempotent on (tenant_id, idempotency_key).';
comment on column public.authority_flips.domain is
  'The capability domain (CLOSED set): people, bookings, schedule, memberships, payments, comms, waivers, retail. An unknown value is rejected at the check constraint AND in the RPC body.';
comment on column public.authority_flips.authority is
  'Who owns the domain after this flip: ''glofox'' (the incumbent) or ''kelo'' (cut over). Absence of any flip means ''glofox'' — see public.current_authority.';

-- ---------------------------------------------------------------------------
-- public.current_authority — the derived "who owns each domain right now" matrix.
-- ---------------------------------------------------------------------------
-- For EVERY domain in the closed set, crossed with each tenant the caller belongs
-- to, this reports the LATEST flip's authority — DEFAULTING to 'glofox' when no
-- flip exists (absence = Glofox; no seeding). SECURITY INVOKER so the underlying
-- authority_flips reads run under the caller's RLS; app.current_tenant_ids()
-- supplies the caller's tenant set (a foreign tenant is simply absent).
create or replace view public.current_authority
  with (security_invoker = true) as
  select
    t.tenant_id,
    d.domain,
    coalesce(f.authority, 'glofox') as authority,
    f.created_at                    as flipped_at,
    f.reason                        as reason
  from app.current_tenant_ids() as t(tenant_id)
  cross join unnest(array[
    'people', 'bookings', 'schedule', 'memberships',
    'payments', 'comms', 'waivers', 'retail'
  ]) as d(domain)
  left join lateral (
    select af.authority, af.created_at, af.reason
    from public.authority_flips af
    where af.tenant_id = t.tenant_id and af.domain = d.domain
    order by af.created_at desc, af.id desc
    limit 1
  ) f on true;

comment on view public.current_authority is
  'The live authority matrix: one row per (caller-tenant, domain) reporting the LATEST flip''s authority, DEFAULTING to ''glofox'' for any un-flipped domain (absence = Glofox; no seeding). SECURITY INVOKER, so RLS on authority_flips scopes it to the caller''s tenants; app.current_tenant_ids() enumerates them.';

-- ---------------------------------------------------------------------------
-- app.flip_authority — the OWNER-only cutover lever (append-only writer).
-- ---------------------------------------------------------------------------
-- p_evidence_url is appended last with a default so the six-arg core signature
-- (p_tenant, p_domain, p_authority, p_reason, p_actor, p_idempotency_key) is a
-- stable prefix. SECURITY DEFINER + search_path='' + in-body OWNER re-verification
-- (invariant #7). Idempotent on (tenant, key): a replay returns the existing id
-- and appends nothing. Writes the flip + an audit_events row (evidence trail).
create or replace function app.flip_authority(
  p_tenant          uuid,
  p_domain          text,
  p_authority       text,
  p_reason          text,
  p_actor           uuid,
  p_idempotency_key text,
  p_evidence_url    text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_flip_id    uuid;
begin
  -- Actor binding + OWNER-only role re-check (invariant #7). The cutover lever is
  -- owner-only — a manager cannot flip a domain's authority. The service role
  -- (auth.uid() null) runs unattended for seeds/migrations.
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'flip actor must be the authenticated user' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner']) then
    raise exception 'owner role required to flip authority' using errcode = '42501';
  end if;

  -- Validate the domain + authority against the CLOSED sets (belt-and-suspenders
  -- behind the table checks — a friendly refusal before the constraint fires).
  if p_domain is null or p_domain not in (
    'people', 'bookings', 'schedule', 'memberships',
    'payments', 'comms', 'waivers', 'retail'
  ) then
    raise exception 'invalid authority domain' using errcode = '22023';
  end if;
  if p_authority is null or p_authority not in ('glofox', 'kelo') then
    raise exception 'invalid authority target' using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a non-empty reason is required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  -- Idempotent replay: this key already flipped → return the existing id, append
  -- nothing (a retried flip must not double-write the ledger OR the audit trail).
  select id into v_flip_id
  from public.authority_flips
  where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then
    return v_flip_id;
  end if;

  -- The actor's role for the audit row (verified owner above when auth.uid() is
  -- set; a null-uid service context still records the seeded membership's role).
  select tu.role into v_actor_role
  from public.tenant_users tu
  where tu.tenant_id = p_tenant and tu.user_id = p_actor and tu.status = 'active';

  begin
    insert into public.authority_flips
      (tenant_id, domain, authority, reason, evidence_url, actor, idempotency_key)
    values
      (p_tenant, p_domain, p_authority, trim(p_reason), p_evidence_url, p_actor, p_idempotency_key)
    returning id into v_flip_id;
  exception when unique_violation then
    -- A concurrent same-key flip committed while we ran — replay it.
    select id into v_flip_id
    from public.authority_flips
    where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
    if not found then
      raise exception 'idempotency key already used for a different operation'
        using errcode = '23505';
    end if;
    return v_flip_id;
  end;

  insert into public.audit_events
    (tenant_id, actor_user_id, actor_role, action, target_type, target_id, metadata)
  values
    (p_tenant, p_actor, v_actor_role, 'authority.flipped',
     'authority_domain', p_domain,
     jsonb_build_object(
       'domain', p_domain,
       'authority', p_authority,
       'flip_id', v_flip_id,
       'reason', trim(p_reason),
       'evidence_url', p_evidence_url
     ));

  return v_flip_id;
end;
$$;

comment on function app.flip_authority(uuid, text, text, text, uuid, text, text) is
  'The OWNER-only cutover lever (plan-final §4 step 4). Re-verifies the actor is an active OWNER of p_tenant in-body, validates domain/authority against the closed sets + a non-empty reason, and APPENDS a flip + an audit_events row. Idempotent on (tenant, idempotency_key): a replay returns the existing id and appends nothing. Returns the flip id.';

-- Public invoker wrapper (PostgREST rpc()). The six-arg core is a prefix;
-- p_evidence_url defaults to null so existing callers need not pass it.
create or replace function public.flip_authority(
  p_tenant          uuid,
  p_domain          text,
  p_authority       text,
  p_reason          text,
  p_actor           uuid,
  p_idempotency_key text,
  p_evidence_url    text default null
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select app.flip_authority(
    p_tenant, p_domain, p_authority, p_reason, p_actor, p_idempotency_key, p_evidence_url
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS — member-SELECT only; the definer RPC is the sole writer.
-- ---------------------------------------------------------------------------
alter table public.authority_flips enable row level security;

create policy authority_flips_select on public.authority_flips for select
  using (tenant_id in (select app.current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- Grants — member-read ONLY. APPEND-ONLY: no UPDATE/DELETE for ANY role
-- (service_role included); NO INSERT grant (the definer RPC writes as owner).
-- Revoking ALL first strips the default, then only SELECT is granted back.
-- ---------------------------------------------------------------------------
revoke all on public.authority_flips from anon, authenticated, service_role;
grant select on public.authority_flips to authenticated, service_role;

revoke all on public.current_authority from anon, authenticated, service_role;
grant select on public.current_authority to authenticated, service_role;

-- The flip RPC is member-callable (it re-checks OWNER role in-body); strip the
-- default EXECUTE-for-PUBLIC first (0005 pattern).
revoke all on function app.flip_authority(uuid, text, text, text, uuid, text, text) from public;
revoke all on function public.flip_authority(uuid, text, text, text, uuid, text, text) from public;
grant execute on function app.flip_authority(uuid, text, text, text, uuid, text, text)
  to authenticated, service_role;
grant execute on function public.flip_authority(uuid, text, text, text, uuid, text, text)
  to authenticated, service_role;
