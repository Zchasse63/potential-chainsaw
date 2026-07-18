-- Phase 1 · unit 5 — THE TRUST ENGINE's tables (plan-final §4 "Reconciliation
-- — the trust engine and the cutover meter"; "Deletion detection" step 6;
-- tripwire 5 of the five in-system freshness tripwires).
--
-- reconciliations is the reconciliation history + the phase-1 cutover meter:
-- every check writes ONE append-ish row per entity (match/drift/error) — the
-- import-review UI (unit 1.6) and the Health page render from it. The column
-- shape here is PINNED for unit 1.6: do not rename.
-- import_snapshots + deletion_candidates implement plan-final §4 step 6:
-- periodic full-window snapshots; a record absent from TWO consecutive full
-- snapshots (never one) becomes a tombstone CANDIDATE for review — a candidate
-- is NEVER an automatic delete (README §6: soft-delete + reactivation are real).
--
-- All three tables are written ONLY by the workers under the service role
-- (plain SQL, the 0010 pattern — deliberately no new app.* functions). Clients
-- get member-SELECT; deletion_candidates additionally allows owner/manager
-- UPDATE of the `status` COLUMN ONLY (the 0007 import_quarantine pattern).

-- reconciliations -------------------------------------------------------------------
-- THE PINNED SHAPE (unit 1.6 reads exactly these columns). Counts/sums are
-- NULLABLE BY DESIGN: single-sided checks (the phase-1 member canary) record
-- kelo_count only with glofox_count NULL, and an 'error' row may carry no
-- numbers at all. status: 'match' (drift zero / single-sided canary), 'drift'
-- (a nonzero difference — tripwire 5, an alert opens), 'error' (the check
-- itself failed — the message is in detail).
create table if not exists public.reconciliations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  entity        text not null,
  window_start  timestamptz,
  window_end    timestamptz,
  glofox_count  int,
  kelo_count    int,
  glofox_sum    numeric(14, 2),
  kelo_sum      numeric(14, 2),
  drift_count   int,
  drift_sum     numeric(14, 2),
  status        text not null check (status in ('match', 'drift', 'error')),
  detail        jsonb not null default '{}'::jsonb,
  checked_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists reconciliations_tenant_entity_checked_idx
  on public.reconciliations (tenant_id, entity, checked_at desc);
-- The drift review queue path: partial index keeps it small and hot.
create index if not exists reconciliations_tenant_drift_idx
  on public.reconciliations (tenant_id, status)
  where status = 'drift';

-- import_snapshots -------------------------------------------------------------------
-- One row per full-list snapshot per entity (deletion detection, plan-final §4
-- step 6): the COMPLETE set of Glofox external_refs seen. A ref absent from
-- two consecutive snapshots is a tombstone candidate. Storing the ref ARRAY is
-- fine at this volume (~1500 members → a ~60KB row); the scale-later shape is
-- a per-ref table (snapshot_id, external_ref) — swap when a tenant's ref set
-- outgrows a row, the comparison logic is unchanged.
-- No updated_at / touch trigger BY DESIGN: snapshots are insert-once facts.
create table if not exists public.import_snapshots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  entity        text not null,
  snapshot_at   timestamptz not null default now(),
  external_refs text[] not null,
  ref_count     int not null,
  created_at    timestamptz not null default now()
);
create index if not exists import_snapshots_tenant_entity_snapshot_idx
  on public.import_snapshots (tenant_id, entity, snapshot_at desc);

-- deletion_candidates -----------------------------------------------------------------
-- Surfaced tombstones for REVIEW. 'candidate' = missing from the latest full
-- snapshot only; 'confirmed' = missing from TWO consecutive snapshots
-- (confirmed_missing_at set); 'resolved'/'dismissed' = a human (or a
-- reappearance in a later snapshot — reactivation is real, README §6) closed
-- it. Resolution is a STATUS FLIP ONLY: nothing is ever deleted by this
-- machinery, and the partial unique keeps exactly one open row per ref.
create table if not exists public.deletion_candidates (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  entity               text not null,
  external_ref         text not null,
  first_missing_at     timestamptz not null,
  confirmed_missing_at timestamptz,
  status               text not null default 'candidate'
                       check (status in ('candidate', 'confirmed', 'resolved', 'dismissed')),
  detail               jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- One OPEN candidate per (tenant, entity, ref) — resolved/dismissed rows keep
-- their history and free the slot for a future re-detection.
create unique index if not exists deletion_candidates_open_key
  on public.deletion_candidates (tenant_id, entity, external_ref)
  where status in ('candidate', 'confirmed');
create index if not exists deletion_candidates_tenant_status_idx
  on public.deletion_candidates (tenant_id, status, created_at desc);

-- triggers ----------------------------------------------------------------------
create or replace trigger deletion_candidates_touch_updated_at
  before update on public.deletion_candidates
  for each row execute function app.touch_updated_at();

-- RLS ---------------------------------------------------------------------------
-- Member-SELECT on all three (invariant #7, the 0006/0008 pattern): the Health
-- page and the import-review UI read them. deletion_candidates additionally
-- allows owner/manager UPDATE (resolve/dismiss), WHO gated by the policy and
-- WHAT gated by the column-list grant below (the 0007 pattern). NO client
-- insert/delete policies anywhere — the service role writes.
alter table public.reconciliations enable row level security;
alter table public.import_snapshots enable row level security;
alter table public.deletion_candidates enable row level security;

drop policy if exists reconciliations_select on public.reconciliations;
create policy reconciliations_select on public.reconciliations
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists import_snapshots_select on public.import_snapshots;
create policy import_snapshots_select on public.import_snapshots
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists deletion_candidates_select on public.deletion_candidates;
create policy deletion_candidates_select on public.deletion_candidates
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists deletion_candidates_update on public.deletion_candidates;
create policy deletion_candidates_update on public.deletion_candidates
  for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));

-- grants --------------------------------------------------------------------------
-- Append-ish: no client writes to reconciliations / import_snapshots at all
-- (the 0006 sync_runs pattern). Strip table-level writes from authenticated
-- FIRST (hosted Supabase default privileges grant them — the 0007 revoke
-- pattern), then grant back exactly what each surface allows.
revoke all on public.reconciliations from anon;
revoke all on public.import_snapshots from anon;
revoke all on public.deletion_candidates from anon;

revoke insert, update, delete on public.reconciliations from authenticated;
revoke insert, update, delete on public.import_snapshots from authenticated;
revoke insert, update, delete on public.deletion_candidates from authenticated;

grant select on public.reconciliations to authenticated;
grant select on public.import_snapshots to authenticated;
grant select on public.deletion_candidates to authenticated;

-- COLUMN-LIST grant (the 0007 import_quarantine pattern): clients resolve or
-- dismiss a candidate by flipping status and NOTHING else — identity, refs,
-- and evidence are service-written and stay client-immutable; there is no
-- insert/delete grant at all (the review UI can neither forge nor delete rows).
grant update (status) on public.deletion_candidates to authenticated;
