-- Phase 0 · unit 3 — jobs queue: the SINGLE scheduler's work table (CLAUDE.md
-- invariant #4: one Netlify tick + this queue; NEVER pg_cron or a second cron).
-- Concurrency safety is structural, not conventional: app.claim_jobs() uses
-- FOR UPDATE SKIP LOCKED, so two concurrent ticks can never claim the same job.
-- job_runs is the APPEND-ONLY audit of every execution attempt (invariant #6);
-- UPDATE/DELETE on it are revoked for all app roles below.

-- jobs -------------------------------------------------------------------------
-- tenant_id is NULLABLE: system jobs (e.g. heartbeat) belong to no tenant.
create table if not exists public.jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants (id) on delete cascade,
  kind            text not null,
  payload         jsonb not null default '{}'::jsonb,
  priority        int not null default 100,
  run_after       timestamptz not null default now(),
  status          text not null default 'queued'
                  check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  lease_until     timestamptz,
  locked_by       text,
  last_error      text,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Idempotent enqueue: same (kind, key) never enqueues twice.
create unique index if not exists jobs_kind_idempotency_key_key
  on public.jobs (kind, idempotency_key)
  where idempotency_key is not null;

-- The claim path: next runnable jobs by priority then age.
create index if not exists jobs_claim_idx
  on public.jobs (priority, run_after)
  where status = 'queued';

create index if not exists jobs_tenant_id_idx
  on public.jobs (tenant_id);

-- job_runs ---------------------------------------------------------------------
-- APPEND-ONLY audit of execution attempts. No updated_at by design; rows are
-- finalized (finished_at/status) only by the definer functions below, and
-- UPDATE/DELETE are revoked from anon/authenticated/service_role at the bottom.
create table if not exists public.job_runs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs (id) on delete cascade,
  tenant_id   uuid,
  attempt     int not null,
  worker      text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text check (status in ('running', 'succeeded', 'failed')),
  error       text
);
create index if not exists job_runs_job_id_idx
  on public.job_runs (job_id);

-- triggers ----------------------------------------------------------------------
create or replace trigger jobs_touch_updated_at
  before update on public.jobs
  for each row execute function app.touch_updated_at();

-- queue functions ---------------------------------------------------------------
-- SECURITY DEFINER (workers call them under the service role); search_path = ''
-- forces full qualification. EXECUTE is granted to service_role ONLY — clients
-- never touch the queue.

-- Idempotent enqueue. On (kind, idempotency_key) conflict returns the EXISTING
-- job's id, so callers can safely retry enqueue without duplicating work.
create or replace function app.enqueue_job(
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_tenant uuid default null,
  p_run_after timestamptz default now(),
  p_priority int default 100,
  p_max_attempts int default 5,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.jobs
    (kind, payload, tenant_id, run_after, priority, max_attempts, idempotency_key)
  values
    (p_kind, p_payload, p_tenant, p_run_after, p_priority, p_max_attempts, p_idempotency_key)
  on conflict (kind, idempotency_key) where idempotency_key is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    -- Conflict with an existing job: hand back its id instead of duplicating.
    select j.id into v_id
    from public.jobs j
    where j.kind = p_kind
      and j.idempotency_key = p_idempotency_key;
  end if;

  return v_id;
end;
$$;

-- Crash recovery: a worker that dies leaves status='running' with an expired
-- lease. Requeue it (attempts remain) or dead-letter it (attempts exhausted),
-- and finalize the orphaned job_runs row either way.
create or replace function app.reap_expired_leases()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dead    int;
  v_queued  int;
begin
  update public.job_runs r
  set finished_at = now(), status = 'failed', error = 'lease expired'
  from public.jobs j
  where r.job_id = j.id
    and r.status = 'running'
    and j.status = 'running'
    and j.lease_until < now();

  update public.jobs j
  set status = 'dead',
      last_error = 'lease expired (max attempts reached)'
  where j.status = 'running'
    and j.lease_until < now()
    and j.attempts >= j.max_attempts;
  get diagnostics v_dead = row_count;

  update public.jobs j
  set status = 'queued',
      run_after = now(),
      lease_until = null,
      locked_by = null
  where j.status = 'running'
    and j.lease_until < now()
    and j.attempts < j.max_attempts;
  get diagnostics v_queued = row_count;

  return v_dead + v_queued;
end;
$$;

-- THE CRITICAL FUNCTION (invariant #4). One statement: candidate rows are
-- locked FOR UPDATE SKIP LOCKED (a concurrent tick skips them instead of
-- claiming them twice), flipped to 'running' with a fresh lease and an
-- incremented attempt counter, and audited into job_runs — all atomically.
create or replace function app.claim_jobs(
  p_worker text,
  p_batch int default 10,
  p_lease interval default '5 minutes'
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with claimed as (
    select j.id
    from public.jobs j
    where j.status = 'queued'
      and j.run_after <= now()
    order by j.priority, j.run_after
    limit p_batch
    for update skip locked
  ),
  updated as (
    update public.jobs j
    set status = 'running',
        locked_by = p_worker,
        lease_until = now() + p_lease,
        attempts = j.attempts + 1,
        updated_at = now()
    from claimed c
    where j.id = c.id
    returning j.*
  ),
  runs as (
    insert into public.job_runs (job_id, tenant_id, attempt, worker, status)
    select u.id, u.tenant_id, u.attempts, p_worker, 'running'
    from updated u
  )
  select * from updated;
end;
$$;

-- Success: mark succeeded and finalize the open run row. Guarded by
-- locked_by + status='running' so a stale/late worker cannot resurrect a job
-- that was reaped and reclaimed by someone else.
create or replace function app.complete_job(p_id uuid, p_worker text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs j
  set status = 'succeeded',
      updated_at = now()
  where j.id = p_id
    and j.locked_by = p_worker
    and j.status = 'running';

  update public.job_runs r
  set finished_at = now(), status = 'succeeded'
  where r.job_id = p_id
    and r.worker = p_worker
    and r.status = 'running';
end;
$$;

-- Failure: exponential backoff (10s * 2^attempts, capped at 1h) while attempts
-- remain; dead-letter once exhausted. The error is recorded either way.
create or replace function app.fail_job(p_id uuid, p_worker text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs j
  set status = case
                 when j.attempts >= j.max_attempts then 'dead'
                 else 'queued'
               end,
      run_after = case
                    when j.attempts >= j.max_attempts then j.run_after
                    else now() + least(interval '1 hour', interval '10 seconds' * power(2, j.attempts))
                  end,
      lease_until = case
                      when j.attempts >= j.max_attempts then j.lease_until
                      else null
                    end,
      locked_by = case
                    when j.attempts >= j.max_attempts then j.locked_by
                    else null
                  end,
      last_error = p_error,
      updated_at = now()
  where j.id = p_id
    and j.locked_by = p_worker
    and j.status = 'running';

  update public.job_runs r
  set finished_at = now(), status = 'failed', error = p_error
  where r.job_id = p_id
    and r.worker = p_worker
    and r.status = 'running';
end;
$$;

-- Long-running processors extend their lease so the reaper leaves them alone.
create or replace function app.heartbeat_job(
  p_id uuid,
  p_worker text,
  p_extend interval default '5 minutes'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs j
  set lease_until = now() + p_extend,
      updated_at = now()
  where j.id = p_id
    and j.locked_by = p_worker
    and j.status = 'running';
end;
$$;

-- Grants: definer functions default to EXECUTE-for-PUBLIC; strip that and allow
-- only the service role (workers). Schema USAGE on app was granted in 0003.
revoke all on function app.enqueue_job(text, jsonb, uuid, timestamptz, int, int, text) from public;
revoke all on function app.reap_expired_leases() from public;
revoke all on function app.claim_jobs(text, int, interval) from public;
revoke all on function app.complete_job(uuid, text) from public;
revoke all on function app.fail_job(uuid, text, text) from public;
revoke all on function app.heartbeat_job(uuid, text, interval) from public;

grant execute on function app.enqueue_job(text, jsonb, uuid, timestamptz, int, int, text) to service_role;
grant execute on function app.reap_expired_leases() to service_role;
grant execute on function app.claim_jobs(text, int, interval) to service_role;
grant execute on function app.complete_job(uuid, text) to service_role;
grant execute on function app.fail_job(uuid, text, text) to service_role;
grant execute on function app.heartbeat_job(uuid, text, interval) to service_role;

-- RLS ---------------------------------------------------------------------------
-- Service-role ONLY tables. RLS is enabled with an explicit deny-all policy for
-- client roles: documents intent, and satisfies the attack suite's generic
-- guard (every tenant_id table needs RLS enabled AND at least one policy).
-- The service role bypasses RLS regardless.
alter table public.jobs enable row level security;
alter table public.job_runs enable row level security;

drop policy if exists jobs_no_client_access on public.jobs;
create policy jobs_no_client_access on public.jobs
  for all to authenticated, anon
  using (false) with check (false);

drop policy if exists job_runs_no_client_access on public.job_runs;
create policy job_runs_no_client_access on public.job_runs
  for all to authenticated, anon
  using (false) with check (false);

-- grants --------------------------------------------------------------------------
revoke all on public.jobs from anon, authenticated;
revoke all on public.job_runs from anon, authenticated;

-- Hard append-only at the DB level (threat model 4b, same as audit_events):
-- job_runs rows are never mutated or removed by any app role; finalization
-- happens only inside the definer functions above (they run as the owner).
revoke update, delete on public.job_runs from anon, authenticated, service_role;
