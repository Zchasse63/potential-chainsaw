-- Phase 0 · unit 3 — observability tables (plan-final §1 "Observability"):
-- in-DB operational truth. The Health page renders from these tables; every
-- screen's freshness chip reads sync_state, never a hardcoded string.
-- Writes happen ONLY from workers under the service role; clients get
-- member-scoped SELECT and nothing else.

-- sync_state -------------------------------------------------------------------
-- One row per (tenant, entity): the current watermark + health of that sync.
create table if not exists public.sync_state (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  entity               text not null,
  committed_watermark  timestamptz,
  candidate_watermark  timestamptz,
  consecutive_empty    int not null default 0,
  expected_min_records int,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  health_state         text not null default 'unknown'
                       check (health_state in
                         ('healthy', 'stale', 'error', 'paused_auth_failed', 'unknown')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, entity)
);

-- sync_runs ---------------------------------------------------------------------
-- Per-execution history (append-ish: rows are written by the service role and
-- never client-mutated). created_at only, no updated_at/trigger by design.
create table if not exists public.sync_runs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  entity           text not null,
  job_id           uuid references public.jobs (id) on delete set null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text check (status in ('running', 'success', 'error', 'empty_suspect')),
  rows_fetched     int,
  rows_upserted    int,
  rows_quarantined int,
  window_start     timestamptz,
  window_end       timestamptz,
  error            text,
  created_at       timestamptz not null default now()
);
create index if not exists sync_runs_tenant_entity_started_idx
  on public.sync_runs (tenant_id, entity, started_at desc);

-- alerts -------------------------------------------------------------------------
-- Operational incidents (import failed, staleness, anomalies, …). tenant_id is
-- NULLABLE for system alerts; those stay hidden from clients (null never
-- matches the membership policy below). The partial unique index dedupes OPEN
-- incidents so a recurring failure doesn't spam.
create table if not exists public.alerts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants (id) on delete cascade,
  kind            text not null,
  severity        text not null check (severity in ('info', 'warning', 'critical')),
  title           text not null,
  body            text,
  status          text not null default 'open'
                  check (status in ('open', 'acknowledged', 'resolved')),
  dedupe_key      text,
  context         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);
create unique index if not exists alerts_open_dedupe_key
  on public.alerts (tenant_id, kind, dedupe_key)
  where status = 'open';
create index if not exists alerts_tenant_status_created_idx
  on public.alerts (tenant_id, status, created_at desc);

-- triggers ----------------------------------------------------------------------
create or replace trigger sync_state_touch_updated_at
  before update on public.sync_state
  for each row execute function app.touch_updated_at();

create or replace trigger alerts_touch_updated_at
  before update on public.alerts
  for each row execute function app.touch_updated_at();

-- RLS ---------------------------------------------------------------------------
-- Member-READABLE: any active member can read their own tenant's health rows
-- (owner/front-desk alike — the Health page is not role-gated). Rows with a
-- NULL tenant_id (system alerts) match no membership and stay hidden.
-- NO insert/update/delete policy for clients — the service role writes.
alter table public.sync_state enable row level security;
alter table public.sync_runs enable row level security;
alter table public.alerts enable row level security;

drop policy if exists sync_state_select on public.sync_state;
create policy sync_state_select on public.sync_state
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists alerts_select on public.alerts;
create policy alerts_select on public.alerts
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- grants --------------------------------------------------------------------------
-- The operator app is auth-gated: anon gets nothing; authenticated reads only.
revoke all on public.sync_state from anon;
revoke all on public.sync_runs from anon;
revoke all on public.alerts from anon;

grant select on public.sync_state to authenticated;
grant select on public.sync_runs to authenticated;
grant select on public.alerts to authenticated;
