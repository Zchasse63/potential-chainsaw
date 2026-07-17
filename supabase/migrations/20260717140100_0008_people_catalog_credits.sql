-- Phase 1 · unit 2 — first native-zone data slice: people, the plan catalog,
-- and the append-only credit ledger (+ its balance read model).
-- plan-final §2 "Tenancy & identity" (people fields) and "Scheduling, booking,
-- credits" (credit_ledger rules); relationship typing is explicitly NOT here
-- (phase 2 — both layers are derived, never hand-entered).
-- CLAUDE.md invariant #6 is THE load-bearing rule: credit_ledger is append-only
-- at the PRIVILEGE level (even the service role only ever INSERTs) and balance
-- is derivable ONLY as sum(delta) — no mutable balance column anywhere.
-- Imports write under the service role; clients get member-SELECT (the native
-- person-editing UI is a later phase). Mappers live in @kelo/glofox and are
-- pure + versioned; unknowns route to import_quarantine, never silent guesses.

-- people ----------------------------------------------------------------------
-- The person record (plan-final §2). email is citext and NULLABLE BY DESIGN
-- (council disagreement #4: dedup is a merge process, not a constraint). The
-- partial unique per tenant WILL block some imports (shared family emails are
-- real) — those rows go to import_quarantine for the merge-review process;
-- that is the design, so never weaken the index.
--   active            — the soft-delete mirror (README §6: deletion arrives as
--                       MEMBER_UPDATED active:false; never purge).
--   source_created_at — Glofox `created`, labeled "first seen" (§5: may be a
--                       migration date); cohorts anchor on first_activity_at.
--   date_quality      — 'unverified' ALWAYS at import; the phase-1 validation
--                       study upgrades it.
--   consent_*         — imported consent EVIDENCE (README §5: feeds owner
--                       decision D2); tri-state, NULL = unknown.
--   lead_status/next_action/pipeline_owner — the NATIVE pipeline surface
--                       (CRM fields). Glofox's own lead flag is never imported
--                       as meaning ("everyone is a lead", §5-facts table).
create table if not exists public.people (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  email               citext,
  phone               text,
  first_name          text,
  last_name           text,
  source              text not null default 'glofox' check (source in ('native', 'glofox')),
  external_ref        text,
  active              boolean not null default true,
  source_created_at   timestamptz,
  first_activity_at   timestamptz,
  cohort_anchor_basis text,
  date_quality        text not null default 'unverified'
                      check (date_quality in ('verified', 'unverified', 'suspect')),
  lead_status         text,
  next_action         text,
  pipeline_owner      uuid,
  consent_email       boolean,
  consent_sms         boolean,
  consent_push        boolean,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Idempotent re-import keyed on the Glofox _id (imports upsert on this).
create unique index if not exists people_tenant_external_ref_key
  on public.people (tenant_id, external_ref)
  where external_ref is not null;

-- Partial unique per tenant (plan-final §2). Conflicts quarantine for merge
-- review — they are not hard import failures, and the index is never weakened.
create unique index if not exists people_tenant_email_key
  on public.people (tenant_id, email)
  where email is not null;

create index if not exists people_tenant_id_idx
  on public.people (tenant_id);
create index if not exists people_tenant_active_idx
  on public.people (tenant_id, active);

-- person_external_refs --------------------------------------------------------
-- The multi-system identity registry (glofox, stripe, aggregator): merge and
-- write-back tooling re-keys people across systems. Reassignment on merge is a
-- service-role process — no client writes in this unit. No updated_at: refs
-- are insert-once facts (a wrong ref is removed by the merge tooling, not edited).
create table if not exists public.person_external_refs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  person_id    uuid not null references public.people (id) on delete cascade,
  system       text not null check (system in ('glofox', 'stripe', 'aggregator')),
  external_ref text not null,
  created_at   timestamptz not null default now()
);
create unique index if not exists person_external_refs_tenant_system_ref_key
  on public.person_external_refs (tenant_id, system, external_ref);
create index if not exists person_external_refs_person_id_idx
  on public.person_external_refs (person_id);

-- plan_catalog ------------------------------------------------------------------
-- The imported Glofox membership catalog (README §5). One row per (membership,
-- plan) pair — a Glofox membership contains multiple plans. This is the
-- glofox-zone catalog that relationship derivation + the owner's A8 mapping
-- need; the NATIVE `plans` table (immutable prices) comes with native billing
-- in phase 5. glofox_type holds only the live-verified vocabulary — unknown
-- values quarantine in the mapper, they never land here. kelo_type is NULL
-- (= unmapped) until the owner's A8 mapping fills it via the column-list
-- update grant below — that grant edits kelo_type and NOTHING else.
create table if not exists public.plan_catalog (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  external_ref    text not null,
  name            text not null,
  description     text,
  active          boolean not null default true,
  plan_code       text,
  plan_name       text,
  price           numeric(10, 2),
  glofox_type     text check (glofox_type in ('num_classes', 'time_classes', 'time')),
  credits_granted int,
  duration_days   int,
  kelo_type       text check (kelo_type in ('recurring', 'unlimited', 'pack', 'drop_in', 'intro')),
  raw             jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists plan_catalog_tenant_ref_code_key
  on public.plan_catalog (tenant_id, external_ref, plan_code);

-- credit_ledger -----------------------------------------------------------------
-- APPEND-ONLY (invariant #6) — the single truth for credit balances. Balance
-- is sum(delta); consumption is earliest-expiring-first with grant_id pointing
-- at the grant row a debit/expiry consumes (lot attribution, resolved by the
-- sync layer after insert). NO updated_at BY DESIGN: rows never change;
-- corrections are new compensating rows.
--   delta sign is CHECKed: grant/refund_credit > 0, debit/expire < 0,
--   adjust <> 0; adjust ALSO requires reason + actor (plan-final §2:
--   "adjust (reason + actor mandatory)"). Mappers never emit adjust.
--   person_id is ON DELETE RESTRICT: a person with ledger history is
--   merge-target territory, never silently cascaded.
create table if not exists public.credit_ledger (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  person_id            uuid not null references public.people (id) on delete restrict,
  entry_type           text not null
                       check (entry_type in ('grant', 'debit', 'refund_credit', 'expire', 'adjust')),
  delta                int not null,
  grant_id             uuid references public.credit_ledger (id),
  expires_at           timestamptz,
  source               text not null default 'glofox' check (source in ('native', 'glofox')),
  external_ref         text,
  booking_external_ref text,
  reason               text,
  actor_user_id        uuid,
  created_at           timestamptz not null default now(),
  check (
    (entry_type in ('grant', 'refund_credit') and delta > 0)
    or (entry_type in ('debit', 'expire') and delta < 0)
    or (entry_type = 'adjust' and delta <> 0)
  ),
  check (entry_type <> 'adjust' or (reason is not null and actor_user_id is not null))
);

-- Idempotent re-import: one grant row per Glofox credit (external_ref = credit
-- _id on grants); one paired expire row per grant. Imported debits carry
-- external_ref NULL (they key on booking_external_ref + grant linkage instead)
-- and are deduped by the sync layer against the grant's existing rows.
create unique index if not exists credit_ledger_tenant_ref_type_key
  on public.credit_ledger (tenant_id, external_ref, entry_type)
  where external_ref is not null;

create index if not exists credit_ledger_tenant_person_created_idx
  on public.credit_ledger (tenant_id, person_id, created_at);
create index if not exists credit_ledger_grant_id_idx
  on public.credit_ledger (grant_id)
  where grant_id is not null;

-- triggers ----------------------------------------------------------------------
create or replace trigger people_touch_updated_at
  before update on public.people
  for each row execute function app.touch_updated_at();

create or replace trigger plan_catalog_touch_updated_at
  before update on public.plan_catalog
  for each row execute function app.touch_updated_at();

-- balance read model ------------------------------------------------------------
-- invariant #6: balance is sum(delta) — the ledger is the only truth and this
-- matview is the READ path (never a mutable balance column anywhere).
-- Threat model §1 matview rule: matviews support neither RLS nor
-- security_invoker, so app.credit_balances lives OUTSIDE public (never
-- PostgREST-exposed), holds NO grants to client roles, and is read only
-- through app.person_credit_balance(), which re-verifies tenancy in-body.
create materialized view if not exists app.credit_balances as
select
  cl.tenant_id,
  cl.person_id,
  sum(cl.delta)::int as balance,
  min(cl.expires_at) filter (
    where cl.entry_type = 'grant' and cl.expires_at > now()
  ) as next_expiry
from public.credit_ledger cl
group by cl.tenant_id, cl.person_id;

comment on materialized view app.credit_balances is
  'Read model over the append-only public.credit_ledger (invariant #6: balance = sum(delta); no mutable balance column anywhere). '
  'next_expiry is a PHASE-1 APPROXIMATION: the earliest FUTURE expiry across the person''s grant rows, evaluated at refresh time. '
  'It ignores lot consumption (earliest-expiring-first debits may already have consumed that lot) and paired expire rows — '
  'the precise lot-attribution liability math is phase-2 dictionary work. Refresh via app.refresh_credit_balances() after credit imports.';

-- Required for refresh materialized view CONCURRENTLY.
create unique index if not exists credit_balances_tenant_person_key
  on app.credit_balances (tenant_id, person_id);

-- The ONLY read path to the matview. Tenancy is re-verified IN BODY (threat
-- model §1: every definer function re-verifies) — a cross-tenant caller gets
-- ZERO ROWS, indistinguishable from "no ledger history". The service role is
-- the trusted server principal (it bypasses RLS on every table) and filters
-- tenant explicitly via p_tenant, matching the workers' explicit-tenant rule.
create or replace function app.person_credit_balance(p_tenant uuid, p_person uuid)
returns table (balance int, next_expiry timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select cb.balance, cb.next_expiry
  from app.credit_balances cb
  where cb.tenant_id = p_tenant
    and cb.person_id = p_person
    and (
      p_tenant in (select app.current_tenant_ids())
      or (select auth.role()) = 'service_role'
    );
$$;

-- Refresh after credit imports. service_role ONLY — clients never trigger it.
create or replace function app.refresh_credit_balances()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently app.credit_balances;
end;
$$;

-- The matview itself is reachable by NO app role (threat model §1); the two
-- definer functions run as the owner and need no caller privileges on it.
revoke all on app.credit_balances from public, anon, authenticated, service_role;

-- Definer functions default to EXECUTE-for-PUBLIC; strip that first (0003/0005 pattern).
revoke all on function app.person_credit_balance(uuid, uuid) from public;
revoke all on function app.refresh_credit_balances() from public;
grant execute on function app.person_credit_balance(uuid, uuid) to authenticated, service_role;
grant execute on function app.refresh_credit_balances() to service_role;

-- RLS ---------------------------------------------------------------------------
-- Member-SELECT everywhere (invariant #7: membership-based, via the definer
-- helpers). NO client insert/delete policies anywhere in this unit: imports
-- write under the service role, which bypasses RLS. plan_catalog additionally
-- allows owner/manager UPDATE — scoped BY COLUMN GRANT to kelo_type only.
alter table public.people enable row level security;
alter table public.person_external_refs enable row level security;
alter table public.plan_catalog enable row level security;
alter table public.credit_ledger enable row level security;

drop policy if exists people_select on public.people;
create policy people_select on public.people
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists person_external_refs_select on public.person_external_refs;
create policy person_external_refs_select on public.person_external_refs
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists plan_catalog_select on public.plan_catalog;
create policy plan_catalog_select on public.plan_catalog
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists plan_catalog_update on public.plan_catalog;
create policy plan_catalog_update on public.plan_catalog
  for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

drop policy if exists credit_ledger_select on public.credit_ledger;
create policy credit_ledger_select on public.credit_ledger
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- grants --------------------------------------------------------------------------
-- The operator app is auth-gated: anon gets nothing. Supabase default-privilege
-- hardening (the 0007 pattern): strip table-level writes from authenticated,
-- then grant back exactly the read (+ the single column-list write) each
-- surface allows — RLS policies above are the second gate, not the first.
revoke all on public.people from anon;
revoke all on public.person_external_refs from anon;
revoke all on public.plan_catalog from anon;
revoke all on public.credit_ledger from anon;

revoke insert, update, delete on public.people from authenticated;
revoke insert, update, delete on public.person_external_refs from authenticated;
revoke insert, update, delete on public.plan_catalog from authenticated;
revoke insert, update, delete on public.credit_ledger from authenticated;

grant select on public.people to authenticated;
grant select on public.person_external_refs to authenticated;
grant select on public.plan_catalog to authenticated;
grant select on public.credit_ledger to authenticated;

-- The A8 mapping UI edits kelo_type and NOTHING else (column-list grant — the
-- import_quarantine pattern from 0007): the RLS update policy restricts WHO
-- (owner/manager), this grant restricts WHAT. No client insert/delete at all.
grant update (kelo_type) on public.plan_catalog to authenticated;

-- HARD append-only at the privilege level (invariant #6 — the
-- audit_events/glofox_raw/job_runs pattern): even the service role only ever
-- INSERTs into the ledger. Corrections are new compensating rows, never edits.
revoke update, delete on public.credit_ledger from anon, authenticated, service_role;
