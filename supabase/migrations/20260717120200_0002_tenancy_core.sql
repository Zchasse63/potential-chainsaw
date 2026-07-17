-- Phase 0 · unit 2 — tenancy core tables (public schema).
-- Every mutable table carries created_at/updated_at + an app.touch_updated_at() trigger.
-- audit_events is evidence-class / APPEND-ONLY: created_at only, no updated_at, and
-- UPDATE/DELETE are revoked for all app roles in 0004 (threat model 4b).

-- updated_at touch trigger ----------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- studio-day primitive guard: locations.timezone must be a real IANA zone -----
create or replace function app.assert_valid_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.timezone not in (select name from pg_catalog.pg_timezone_names) then
    raise exception 'invalid timezone %: must be an IANA name from pg_timezone_names', new.timezone;
  end if;
  return new;
end;
$$;

-- tenants ----------------------------------------------------------------------
create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       citext not null unique,
  settings   jsonb not null default '{}'::jsonb,
  status     text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- locations --------------------------------------------------------------------
create table if not exists public.locations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  name         text not null,
  timezone     text not null,
  currency     text not null default 'USD',
  external_ref text,
  address      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists locations_tenant_external_ref_key
  on public.locations (tenant_id, external_ref)
  where external_ref is not null;
create index if not exists locations_tenant_id_idx
  on public.locations (tenant_id);

-- tenant_users -----------------------------------------------------------------
-- mfa_required is GENERATED from role so "MFA mandatory for owner/manager"
-- (threat model §5) cannot be set wrong.
create table if not exists public.tenant_users (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('owner', 'manager', 'front_desk', 'trainer')),
  status          text not null default 'active' check (status in ('active', 'deactivated')),
  step_up_pin_hash text,
  mfa_required    boolean not null generated always as (role in ('owner', 'manager')) stored,
  invited_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists tenant_users_user_id_idx
  on public.tenant_users (user_id);
create index if not exists tenant_users_tenant_id_idx
  on public.tenant_users (tenant_id);

-- tenant_invitations -----------------------------------------------------------
-- Only token_hash is stored; the raw invite token is emailed, never persisted.
create table if not exists public.tenant_invitations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  email            citext not null,
  role             text not null check (role in ('owner', 'manager', 'front_desk', 'trainer')),
  token_hash       text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at       timestamptz not null,
  accepted_at      timestamptz,
  accepted_user_id uuid,
  invited_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists tenant_invitations_pending_email_key
  on public.tenant_invitations (tenant_id, email)
  where status = 'pending';
create index if not exists tenant_invitations_tenant_id_idx
  on public.tenant_invitations (tenant_id);

-- audit_events -----------------------------------------------------------------
-- EVIDENCE-CLASS / APPEND-ONLY. No updated_at by design (rows never change);
-- UPDATE/DELETE grants are revoked in 0004_rls_policies.sql.
create table if not exists public.audit_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  actor_user_id uuid,
  actor_role    text,
  action        text not null,
  reason_code   text,
  target_type   text,
  target_id     text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists audit_events_tenant_created_idx
  on public.audit_events (tenant_id, created_at desc);

-- triggers ---------------------------------------------------------------------
create or replace trigger tenants_touch_updated_at
  before update on public.tenants
  for each row execute function app.touch_updated_at();

create or replace trigger locations_touch_updated_at
  before update on public.locations
  for each row execute function app.touch_updated_at();

create or replace trigger locations_assert_valid_timezone
  before insert or update on public.locations
  for each row execute function app.assert_valid_timezone();

create or replace trigger tenant_users_touch_updated_at
  before update on public.tenant_users
  for each row execute function app.touch_updated_at();

create or replace trigger tenant_invitations_touch_updated_at
  before update on public.tenant_invitations
  for each row execute function app.touch_updated_at();
