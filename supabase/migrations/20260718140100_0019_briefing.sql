-- Phase 2 · unit 3 — daily briefing artifacts, per-insight feedback, and
-- durable focus-queue dismissal/snooze history. AI artifacts contain only
-- de-identified deterministic facts; people names/contact data never enter
-- this table or the provider payload.

-- Daily generated artifact ---------------------------------------------------
create table if not exists public.ai_artifacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  kind          text not null check (kind in ('briefing')),
  generated_for date not null,
  status        text not null check (status in ('generated', 'fallback', 'refused')),
  prompt_version int,
  model         text,
  input         jsonb not null,
  input_hash    text not null,
  output        jsonb,
  cost_usd      numeric(8, 4),
  error         text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, kind, generated_for)
);

comment on table public.ai_artifacts is
  'Daily de-identified intelligence artifacts. input is the complete deterministic, auditable provider payload; generation is idempotent per tenant/kind/studio-local day.';

create index if not exists ai_artifacts_tenant_created_idx
  on public.ai_artifacts (tenant_id, created_at desc);

-- Per-insight quality signal -------------------------------------------------
create table if not exists public.briefing_feedback (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  artifact_id   uuid not null references public.ai_artifacts (id) on delete cascade,
  item_ref      text not null,
  verdict       text not null check (verdict in ('up', 'down')),
  reason        text,
  actor_user_id uuid,
  created_at    timestamptz not null default now()
);

create index if not exists briefing_feedback_tenant_artifact_idx
  on public.briefing_feedback (tenant_id, artifact_id, created_at desc);

-- Focus-queue hygiene history -----------------------------------------------
create table if not exists public.focus_dismissals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  item_key      text not null,
  action        text not null check (action in ('dismissed', 'snoozed')),
  reason        text,
  snooze_until  timestamptz,
  actor_user_id uuid,
  created_at    timestamptz not null default now()
);

create index if not exists focus_dismissals_tenant_item_created_idx
  on public.focus_dismissals (tenant_id, item_key, created_at desc);

-- RLS -----------------------------------------------------------------------
alter table public.ai_artifacts enable row level security;
alter table public.briefing_feedback enable row level security;
alter table public.focus_dismissals enable row level security;

drop policy if exists ai_artifacts_select on public.ai_artifacts;
create policy ai_artifacts_select on public.ai_artifacts
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists briefing_feedback_select on public.briefing_feedback;
create policy briefing_feedback_select on public.briefing_feedback
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists briefing_feedback_insert on public.briefing_feedback;
create policy briefing_feedback_insert on public.briefing_feedback
  for insert
  with check (
    tenant_id in (select app.current_tenant_ids())
    and (actor_user_id = (select auth.uid()) or actor_user_id is null)
    and exists (
      select 1
      from public.ai_artifacts artifact
      where artifact.id = briefing_feedback.artifact_id
        and artifact.tenant_id = briefing_feedback.tenant_id
        and coalesce(artifact.output -> 'insights', '[]'::jsonb) @>
          jsonb_build_array(jsonb_build_object('id', briefing_feedback.item_ref))
    )
  );

drop policy if exists focus_dismissals_select on public.focus_dismissals;
create policy focus_dismissals_select on public.focus_dismissals
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists focus_dismissals_insert on public.focus_dismissals;
create policy focus_dismissals_insert on public.focus_dismissals
  for insert
  with check (
    tenant_id in (select app.current_tenant_ids())
    and (actor_user_id = (select auth.uid()) or actor_user_id is null)
  );

-- Grants --------------------------------------------------------------------
-- Hosted defaults are broad, so strip them before granting the exact surface.
revoke all on public.ai_artifacts from anon, authenticated, service_role;
revoke all on public.briefing_feedback from anon, authenticated, service_role;
revoke all on public.focus_dismissals from anon, authenticated, service_role;

grant select on public.ai_artifacts to authenticated, service_role;
grant insert, update, delete on public.ai_artifacts to service_role;

grant select, insert on public.briefing_feedback to authenticated, service_role;
grant select, insert on public.focus_dismissals to authenticated, service_role;

-- Feedback and queue decisions are append-only evidence. Corrections append a
-- later row; no app role, including service_role, may rewrite history.
revoke update, delete on public.briefing_feedback
  from anon, authenticated, service_role;
revoke update, delete on public.focus_dismissals
  from anon, authenticated, service_role;
