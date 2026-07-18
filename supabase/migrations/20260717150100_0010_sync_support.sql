-- Phase 1 · unit 4 — sync support: the per-entity tripwire CONFIG lives on
-- sync_state next to the watermarks it governs (plan-final §4 "The five
-- in-system freshness tripwires": (1) the watermark law, (2) per-entity
-- plausible-zero config, (3) the consecutive_empty alarm).
--
-- Deliberately NO new functions: the sync workers hold the service role and
-- read/write sync_state, sync_runs, alerts, glofox_raw, import_quarantine, and
-- the slice tables directly over the pg pool — plain SQL from the workers is
-- not awkward, so app.* gains nothing here.
--
-- The columns are ADD COLUMNs only: RLS policies (member SELECT) and grants
-- from 0006 are untouched and keep applying. The (tenant_id, entity) unique
-- key the workers' upsert path needs already exists (0006), so no new index.

-- sync_state config columns ------------------------------------------------------
-- plausible_zero (tripwire 2): may a ZERO-ROW window advance the watermark?
--   false = an empty fetch is suspect by default (the 10-week silent-freeze
--   killer was exactly this); the run is recorded 'empty_suspect' and the
--   watermark holds. true = empty windows are normal for this entity (e.g.
--   transactions marching 7-day windows through quiet weeks).
-- empty_alarm_threshold (tripwire 3): how many CONSECUTIVE suspect-empty runs
--   open a 'sync_empty_suspect' critical alert (deduped per tenant+entity).
-- paused: operator/circuit-breaker halt — the auth-failure path sets it (with
--   health_state 'paused_auth_failed') so dead credentials stop being hammered;
--   a paused entity's sync jobs no-op until a human unpauses.
alter table public.sync_state
  add column if not exists plausible_zero boolean not null default false,
  add column if not exists empty_alarm_threshold int not null default 3,
  add column if not exists paused boolean not null default false;

-- A threshold of 0 would alert on the FIRST suspect-empty run with no noise
-- budget; negative is meaningless. Keep it positive.
alter table public.sync_state
  add constraint sync_state_empty_alarm_threshold_positive
  check (empty_alarm_threshold > 0);
