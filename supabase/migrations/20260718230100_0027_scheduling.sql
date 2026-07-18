-- Phase 4 · unit 2 — native scheduling authoring.
--
-- Local recurrence is deliberately stored as an iCalendar RRULE plus an
-- HH:MM wall time and IANA timezone. Application code expands the rule and
-- converts every occurrence to a timestamptz; PostgreSQL stores instants only.

create table public.resources (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  kind       text not null default 'room'
             check (kind in ('room', 'equipment', 'trainer_slot')),
  capacity   int not null default 1 check (capacity > 0),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.resource_readiness (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  resource_id    uuid not null,
  state          text not null default 'ready'
                 check (state in ('ready', 'turnover', 'maintenance', 'closed')),
  effective_from timestamptz not null,
  effective_to   timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, resource_id)
    references public.resources (tenant_id, id) on delete cascade,
  check (effective_to is null or effective_to > effective_from)
);

create index resource_readiness_tenant_window_idx
  on public.resource_readiness (tenant_id, effective_from, effective_to);

create table public.offering_templates (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  name             text not null check (length(trim(name)) > 0),
  duration_minutes int not null check (duration_minutes > 0),
  default_capacity int check (default_capacity is null or default_capacity > 0),
  kelo_type        text,
  description      text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.schedule_rules (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  offering_template_id uuid not null,
  resource_id          uuid not null,
  rrule                text not null check (length(trim(rrule)) > 0),
  local_start_time     text not null
                       check (local_start_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone             text not null,
  start_date           date not null,
  end_date             date,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  foreign key (tenant_id, offering_template_id)
    references public.offering_templates (tenant_id, id) on delete cascade,
  foreign key (tenant_id, resource_id)
    references public.resources (tenant_id, id) on delete cascade,
  check (end_date is null or end_date >= start_date)
);

comment on column public.schedule_rules.rrule is
  'iCalendar RRULE text. Expansion is performed in application code; PostgreSQL stores no recurrence extension state.';
comment on column public.schedule_rules.local_start_time is
  'HH:MM wall time interpreted in schedule_rules.timezone for every occurrence, including across DST.';

create or replace trigger schedule_rules_assert_valid_timezone
  before insert or update on public.schedule_rules
  for each row execute function app.assert_valid_timezone();

create table public.scheduled_sessions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  offering_template_id uuid not null,
  resource_id          uuid not null,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  capacity             int not null check (capacity > 0),
  status               text not null default 'draft'
                       check (status in ('draft', 'published', 'cancelled')),
  schedule_rule_id     uuid,
  created_by           uuid references auth.users (id) on delete set null,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (tenant_id, offering_template_id)
    references public.offering_templates (tenant_id, id),
  foreign key (tenant_id, resource_id)
    references public.resources (tenant_id, id),
  foreign key (tenant_id, schedule_rule_id)
    references public.schedule_rules (tenant_id, id) on delete set null,
  check (ends_at > starts_at),
  check ((status = 'published' and published_at is not null) or status <> 'published')
);

create index scheduled_sessions_tenant_starts_idx
  on public.scheduled_sessions (tenant_id, starts_at);
create unique index scheduled_sessions_rule_occurrence_key
  on public.scheduled_sessions (tenant_id, schedule_rule_id, starts_at)
  where schedule_rule_id is not null;

create or replace trigger scheduled_sessions_touch_updated_at
  before update on public.scheduled_sessions
  for each row execute function app.touch_updated_at();

create table public.schedule_publish_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  action      text not null
              check (action in ('publish', 'unpublish', 'cancel', 'bulk_publish')),
  session_ids uuid[] not null,
  actor       uuid references auth.users (id) on delete set null,
  summary     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index schedule_publish_log_tenant_created_idx
  on public.schedule_publish_log (tenant_id, created_at desc);

comment on table public.resource_readiness is
  'Operational readiness is independent of resources.capacity. Capacity never implies that a room is ready.';
comment on table public.scheduled_sessions is
  'Kelo-native authored sessions. Imported read history remains in glofox_sessions.';
comment on table public.schedule_publish_log is
  'Append-only evidence for native schedule publication state changes.';

-- Publishing is one transaction and one audit row. Already-published ids are
-- intentionally a no-op, making retries safe even before persisted API
-- idempotency keys land in phase 5.
create or replace function app.publish_sessions(
  p_tenant uuid,
  p_session_ids uuid[],
  p_actor uuid
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_published int := 0;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'publish actor must be the authenticated user' using errcode = '42501';
  end if;
  if not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;
  if p_session_ids is null or cardinality(p_session_ids) = 0 then
    raise exception 'at least one session id is required' using errcode = '22023';
  end if;

  update public.scheduled_sessions s
  set status = 'published', published_at = now()
  where s.tenant_id = p_tenant
    and s.id = any (p_session_ids)
    and s.status = 'draft';
  get diagnostics v_published = row_count;

  insert into public.schedule_publish_log
    (tenant_id, action, session_ids, actor, summary)
  values
    (p_tenant,
     case when cardinality(p_session_ids) > 1 then 'bulk_publish' else 'publish' end,
     p_session_ids,
     p_actor,
     jsonb_build_object(
       'requested_count', cardinality(p_session_ids),
       'published_count', v_published
     ));

  return v_published;
end;
$$;

create or replace function public.publish_sessions(
  p_tenant uuid,
  p_session_ids uuid[],
  p_actor uuid
)
returns int
language sql
security invoker
set search_path = ''
as $$ select app.publish_sessions(p_tenant, p_session_ids, p_actor); $$;

-- RLS: every active tenant member may read; only owner/manager memberships
-- may author. The publish log has no direct write path.
alter table public.resources enable row level security;
alter table public.resource_readiness enable row level security;
alter table public.offering_templates enable row level security;
alter table public.schedule_rules enable row level security;
alter table public.scheduled_sessions enable row level security;
alter table public.schedule_publish_log enable row level security;

create policy resources_select on public.resources for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy resources_insert on public.resources for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy resources_update on public.resources for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy resources_delete on public.resources for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy resource_readiness_select on public.resource_readiness for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy resource_readiness_insert on public.resource_readiness for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy resource_readiness_update on public.resource_readiness for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy resource_readiness_delete on public.resource_readiness for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy offering_templates_select on public.offering_templates for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy offering_templates_insert on public.offering_templates for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy offering_templates_update on public.offering_templates for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy offering_templates_delete on public.offering_templates for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy schedule_rules_select on public.schedule_rules for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy schedule_rules_insert on public.schedule_rules for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy schedule_rules_update on public.schedule_rules for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy schedule_rules_delete on public.schedule_rules for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy scheduled_sessions_select on public.scheduled_sessions for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy scheduled_sessions_insert on public.scheduled_sessions for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy scheduled_sessions_update on public.scheduled_sessions for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy scheduled_sessions_delete on public.scheduled_sessions for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy schedule_publish_log_select on public.schedule_publish_log for select
  using (tenant_id in (select app.current_tenant_ids()));

revoke all on public.resources, public.resource_readiness, public.offering_templates,
  public.schedule_rules, public.scheduled_sessions, public.schedule_publish_log
  from anon, authenticated, service_role;

grant select, insert, update, delete on public.resources, public.resource_readiness,
  public.offering_templates, public.schedule_rules, public.scheduled_sessions
  to authenticated, service_role;
grant select on public.schedule_publish_log to authenticated, service_role;
grant insert on public.schedule_publish_log to service_role;
revoke update, delete on public.schedule_publish_log
  from anon, authenticated, service_role;

revoke all on function app.publish_sessions(uuid, uuid[], uuid) from public;
grant execute on function app.publish_sessions(uuid, uuid[], uuid)
  to authenticated, service_role;
revoke all on function public.publish_sessions(uuid, uuid[], uuid) from public;
grant execute on function public.publish_sessions(uuid, uuid[], uuid)
  to authenticated, service_role;
