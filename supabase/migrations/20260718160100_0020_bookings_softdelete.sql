-- Phase 2 · unit 3b — booking deletion-in-source fact marks.
--
-- A booking absent from two consecutive full Glofox snapshots is not purged:
-- the imported fact stays in Kelo with deleted_at recording when the source
-- deletion was confirmed. Active booking counts exclude those retained rows.
-- Existing RLS policies and grants apply to the new column unchanged.

alter table public.glofox_bookings
  add column if not exists deleted_at timestamptz;

create index if not exists glofox_bookings_tenant_active_idx
  on public.glofox_bookings (tenant_id)
  where deleted_at is null;
