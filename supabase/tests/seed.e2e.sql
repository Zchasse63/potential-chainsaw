-- supabase/tests/seed.e2e.sql — E2E harness seed (WS-2).
--
-- NOT a migration and NOT reachable from app code (CLAUDE.md invariant #2):
-- it lives under supabase/tests/ and is applied ONLY by scripts/e2e-db.sh into
-- a throwaway local Supabase stack for Playwright runs. Never ships anywhere a
-- member or operator can reach.
--
-- It seeds the minimum a Playwright smoke needs: ONE tenant with a fixed id (so
-- the member app's KELO_TENANT_ID can pin it) and ONE published, upcoming
-- session, so the anonymous public schedule (public.member_schedule, migration
-- 0043) SSRs exactly one visible row — the offering "Morning Contrast".
--
-- Verified against the live production schema via the member_schedule RPC
-- (returns exactly this row over a now()..now()+7d window) before commit.

begin;

insert into public.tenants (id, name, slug)
  values ('e2e00000-0000-4000-8000-000000000001', 'E2E Studio', 'e2e-studio')
  on conflict (id) do nothing;

insert into public.resources (id, tenant_id, name)
  values (
    'e2e00000-0000-4000-8000-000000000002',
    'e2e00000-0000-4000-8000-000000000001',
    'Sauna Room'
  )
  on conflict (id) do nothing;

insert into public.offering_templates (id, tenant_id, name, duration_minutes)
  values (
    'e2e00000-0000-4000-8000-000000000003',
    'e2e00000-0000-4000-8000-000000000001',
    'Morning Contrast',
    60
  )
  on conflict (id) do nothing;

-- Published + starts ~1 day out, so it lands inside the member app's default
-- schedule window and its status/published_at gates in member_schedule pass.
insert into public.scheduled_sessions
  (id, tenant_id, offering_template_id, resource_id, starts_at, ends_at, capacity, status, published_at)
  values (
    'e2e00000-0000-4000-8000-000000000004',
    'e2e00000-0000-4000-8000-000000000001',
    'e2e00000-0000-4000-8000-000000000003',
    'e2e00000-0000-4000-8000-000000000002',
    now() + interval '1 day',
    now() + interval '1 day' + interval '1 hour',
    8,
    'published',
    now()
  )
  on conflict (id) do nothing;

commit;
