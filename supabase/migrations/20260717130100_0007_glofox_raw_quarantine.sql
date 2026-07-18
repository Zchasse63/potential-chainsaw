-- Phase 1 · unit 1 — Glofox raw zone + import quarantine (plan-final §4 "The
-- pipeline": FETCH appends raw pages to glofox_raw hash-deduped; TRANSFORM
-- validates and routes unknowns to import_quarantine — never silently
-- classifies, CLAUDE.md invariant #8).
-- glofox_raw is the IMMUTABLE raw zone: any mapping bug is fixed by
-- re-transforming from raw, so UPDATE/DELETE are revoked from every app role
-- below (same append-only posture as audit_events / job_runs).
-- Both tables are written ONLY by the sync jobs under the service role;
-- import_quarantine is the client-visible review queue, resolvable by
-- owner/manager through a COLUMN-LIST update grant (resolution fields only —
-- payload/reason are evidence and never client-edited).

-- glofox_raw ---------------------------------------------------------------------
-- One row per fetched Glofox page/report window, kept verbatim (pre-parse).
-- No updated_at / touch trigger BY DESIGN: rows never change.
create table if not exists public.glofox_raw (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  endpoint     text not null,
  request_meta jsonb not null default '{}'::jsonb,
  payload      jsonb not null,
  payload_hash text not null,
  sync_run_id  uuid references public.sync_runs (id) on delete set null,
  fetched_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Hash-dedup: the sync layer inserts with ON CONFLICT DO NOTHING, so a
-- re-fetched identical page never duplicates (plan-final §4 step 1).
create unique index if not exists glofox_raw_tenant_endpoint_hash_key
  on public.glofox_raw (tenant_id, endpoint, payload_hash);

create index if not exists glofox_raw_tenant_endpoint_fetched_idx
  on public.glofox_raw (tenant_id, endpoint, fetched_at desc);

-- import_quarantine ---------------------------------------------------------------
-- The review queue for rows that failed validation (unknown glofox_event,
-- unparseable shapes, broken referential joins). Mutable ONLY in its
-- resolution fields; the row itself is evidence.
create table if not exists public.import_quarantine (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  entity          text not null,
  external_ref    text,
  payload         jsonb not null,
  reason          text not null,
  sync_run_id     uuid references public.sync_runs (id) on delete set null,
  status          text not null default 'open'
                  check (status in ('open', 'resolved', 'dismissed')),
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists import_quarantine_tenant_status_created_idx
  on public.import_quarantine (tenant_id, status, created_at desc);
create index if not exists import_quarantine_tenant_entity_idx
  on public.import_quarantine (tenant_id, entity);

-- triggers ----------------------------------------------------------------------
create or replace trigger import_quarantine_touch_updated_at
  before update on public.import_quarantine
  for each row execute function app.touch_updated_at();

-- RLS ---------------------------------------------------------------------------
-- glofox_raw: service-only. Deny-all policy for client roles (the jobs/job_runs
-- pattern from 0005): documents intent and satisfies the attack suite's
-- generic guard; the service role bypasses RLS regardless.
-- import_quarantine: member-READABLE (the review UI lists open rows);
-- owner/manager UPDATE for resolution. NO client insert/delete policy —
-- quarantine rows are written by the service role and never client-deleted.
alter table public.glofox_raw enable row level security;
alter table public.import_quarantine enable row level security;

drop policy if exists glofox_raw_no_client_access on public.glofox_raw;
create policy glofox_raw_no_client_access on public.glofox_raw
  for all to authenticated, anon
  using (false) with check (false);

drop policy if exists import_quarantine_select on public.import_quarantine;
create policy import_quarantine_select on public.import_quarantine
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists import_quarantine_update on public.import_quarantine;
create policy import_quarantine_update on public.import_quarantine
  for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

-- grants --------------------------------------------------------------------------
revoke all on public.glofox_raw from anon, authenticated;

-- Hard append-only at the DB level (threat model 4b, same as audit_events and
-- job_runs): raw evidence is never mutated or removed by any app role —
-- re-transform from raw, never edit it.
revoke update, delete on public.glofox_raw from anon, authenticated, service_role;

revoke all on public.import_quarantine from anon;
-- Strip TABLE-LEVEL write privileges first (hosted Supabase default privileges
-- grant them — the 0004/0005 revoke pattern exists for exactly this): the
-- column-list grant below must be the ONLY client write path, so quarantine
-- rows are never client-inserted, client-deleted, or edited in their evidence
-- columns. RLS backs this with no insert/delete policy at all.
revoke insert, update, delete on public.import_quarantine from authenticated;
grant select on public.import_quarantine to authenticated;

-- COLUMN-LIST grant: clients resolve/dismiss ONLY. payload/reason/identity are
-- evidence written by the service role and stay client-immutable; there is no
-- insert/delete grant at all (the review UI can neither forge nor delete rows).
grant update (status, resolved_by, resolved_at, resolution_note)
  on public.import_quarantine to authenticated;
