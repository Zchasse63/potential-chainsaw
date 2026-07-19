-- Phase 5 · unit 5.5 — VERIFY_MONEY's record table (plan-final §5/§6,
-- threat-model §6: the phase-5 gate proofs). verify_money is a NIGHTLY
-- cross-ledger invariant checker over the billing spine (payments,
-- stripe_commands, stripe_events). It is READ-ONLY over those ledgers by
-- construction — its ONLY write is one append-once row here per run plus the
-- deduped alerts it opens. This table is that run history: the Health surface
-- reads it to prove the money ledgers are internally consistent.
--
-- tenant_id is NULLABLE: verify_money runs GLOBALLY (one run scans every
-- tenant's rows), so the run itself is a global row (tenant_id null). A global
-- row matches NO membership and so stays hidden from clients — exactly like a
-- system alert (0006). Per-tenant violations are surfaced to the owning tenant
-- through the deduped alerts verify opens, not through this table.
--
-- Append-once: the engine computes the whole run in memory, then INSERTS one
-- finished row (started_at + finished_at + ok + violations together). No UPDATE
-- path is needed or granted — the row is a completed fact, never edited.

create table if not exists public.verify_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants (id) on delete cascade,
  started_at  timestamptz not null,
  finished_at timestamptz,
  ok          boolean not null,
  violations  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists verify_runs_created_idx
  on public.verify_runs (created_at desc);
-- The failing-run review path: partial index keeps it small and hot.
create index if not exists verify_runs_not_ok_idx
  on public.verify_runs (created_at desc)
  where not ok;

comment on table public.verify_runs is
  'Nightly verify_money run history (Phase 5 · unit 5.5): each row is one cross-ledger invariant sweep over payments/stripe_commands/stripe_events. tenant_id is NULL for the global run (hidden from clients, like a system alert); per-tenant violations reach owners via deduped verify_money alerts. ok=false means at least one violation; violations holds the full list. Append-once: the service role INSERTS a finished row, never updates it. verify_money NEVER mutates the ledgers it checks.';

-- RLS -----------------------------------------------------------------------
-- Member-SELECT (the 0006/0011 pattern); the service role writes. NO client
-- insert/update/delete anywhere. Global (null-tenant) runs match no membership
-- and stay hidden.
alter table public.verify_runs enable row level security;

drop policy if exists verify_runs_select on public.verify_runs;
create policy verify_runs_select on public.verify_runs
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- grants --------------------------------------------------------------------
-- Strip the hosted-Supabase default writes from authenticated FIRST (the 0011
-- revoke pattern), then grant back exactly member-SELECT; the service role
-- INSERTS run rows (append-once — no update/delete grant).
revoke all on public.verify_runs from anon;
revoke insert, update, delete on public.verify_runs from authenticated;

grant select on public.verify_runs to authenticated;
grant select, insert on public.verify_runs to service_role;
