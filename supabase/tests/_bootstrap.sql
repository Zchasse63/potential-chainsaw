-- supabase/tests/_bootstrap.sql — CI/local plain-Postgres shim.
--
-- Recreates what hosted Supabase already provides (roles, auth schema, auth.users,
-- auth.uid()/auth.role(), pgcrypto) so the migrations + attack suite run on a
-- throwaway postgres:17 container. Idempotent; safe to re-run.
--
-- NEVER run this against a real Supabase database: Supabase owns these objects
-- and this file would redefine them. Requires a superuser (e.g. postgres).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create role anon nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create role authenticated nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'create role service_role nologin bypassrls';
  end if;
end
$$;

-- Idempotent attribute fix-up in case the role pre-existed without BYPASSRLS.
alter role service_role bypassrls;

-- Grant membership to the runner role so `set local role <r>` works from the
-- migration/test session (a no-op for superusers, required otherwise).
do $$
begin
  execute format('grant anon, authenticated, service_role to %I', current_user);
end
$$;

create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

-- Minimal stand-ins for Supabase's JWT-claim readers. The attack suite sets
-- request.jwt.claims via set_config() to impersonate users.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb);
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', 'anon');
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
