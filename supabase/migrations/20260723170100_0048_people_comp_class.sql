-- 0048 — people.comp_class: the native "no revenue expected" classification.
--
-- Owners, original owners, trainers, and their partners hold real member
-- accounts with large comp credit balances (free memberships), so revenue and
-- credit-liability reporting must be able to exclude them. This is a NATIVE
-- column: the Glofox members upsert (workers/src/glofox/entities/members.ts)
-- only writes import-owned columns in its ON CONFLICT ... DO UPDATE SET, so a
-- column it does not list is never clobbered by a re-import (same posture as
-- lead_status/next_action/pipeline_owner). NULL = a normal paying member;
-- reporting treats `comp_class is not null` as revenue-exempt.
--
-- The specific person->class assignments are applied directly to production
-- (member PII never enters this public repo). Column-list UPDATE grant for the
-- operator UI is deferred until that surface exists (mirrors kelo_type).

alter table public.people
  add column if not exists comp_class text
    check (comp_class in ('owner', 'original_owner', 'trainer', 'related'));

comment on column public.people.comp_class is
  'Native no-revenue classification (NOT import-owned — never clobbered by the members upsert). '
  'NULL = normal paying member. Non-NULL flags a comp/free account (owner, original_owner, trainer, '
  'or related partner) that revenue and credit-liability reporting must exclude.';
