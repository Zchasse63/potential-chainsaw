-- Phase 1 · unit 3 — imported Glofox FACTS: sessions, bookings, transactions.
-- These are the glofox-zone queryable PROJECTIONS: glofox_raw (0007) stays the
-- immutable record; the sync jobs re-transform from raw on any mapping fix
-- (plan-final §4 "The pipeline"). This unit imports facts ONLY — the native
-- booking engine (holds, constraints, capacity enforcement) is phase 6 and
-- gets its own native tables (plan-final §2); no engine machinery here.
--
-- All three tables are written ONLY by the sync jobs under the service role
-- (upsert keyed (tenant_id, external_ref)); clients get member-SELECT so the
-- operator UI can read rosters, schedules, and the failed-payment queue.
-- Invariant #8: unknowns are never silently classified — they land in these
-- tables VISIBLY flagged (status_known / glofox_event_class='unknown') AND in
-- import_quarantine for review.

-- glofox_sessions ---------------------------------------------------------------
-- Imported class/event instances (event _id); feeds the demand heatmap. The
-- native `sessions` authoring table is phase 4 — this is the glofox-zone
-- mirror. booked_count/waiting_count are IMPORTED Glofox facts, fine here;
-- the invariant against cached counts applies to the NATIVE engine (phase 6).
create table if not exists public.glofox_sessions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  external_ref         text not null,
  program_external_ref text,
  name                 text,
  time_start           timestamptz,
  duration_minutes     int,
  capacity             int,
  booked_count         int,
  waiting_count        int,
  trainer_refs         jsonb not null default '[]'::jsonb,
  facility_ref         text,
  is_private           boolean,
  status               text,
  raw                  jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists glofox_sessions_tenant_external_ref_key
  on public.glofox_sessions (tenant_id, external_ref);
create index if not exists glofox_sessions_tenant_time_start_idx
  on public.glofox_sessions (tenant_id, time_start desc);

-- glofox_bookings ---------------------------------------------------------------
-- Imported booking facts. status keeps the RAW Glofox string: the vendor
-- documents more statuses than the five observed live (SPEC lists "…"), so a
-- CHECK would reject real data. Instead status_known is GENERATED from the
-- known five — an unknown status stays stored and visible (and the mapper
-- also quarantines it), never silently dropped.
create table if not exists public.glofox_bookings (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants (id) on delete cascade,
  external_ref           text not null,
  person_external_ref    text not null,
  session_external_ref   text,
  booking_type           text,
  model                  text,
  status                 text not null,
  status_known           boolean not null generated always as (
                           status in ('BOOKED', 'WAITING', 'CANCELED', 'RESERVED', 'FAILED')
                         ) stored,
  attended               boolean,
  paid                   boolean,
  payment_method         text,
  time_start             timestamptz,
  time_finish            timestamptz,
  is_first               boolean,
  is_from_waiting_list   boolean,
  is_late_cancellation   boolean,
  guest_bookings         int,
  canceled_at            timestamptz,
  -- Aggregator-channel candidate (must-answer #2): null in pinned samples but
  -- kept — the phase-1 full-history distinct-value scan reads this column.
  origin                 text,
  raw                    jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists glofox_bookings_tenant_external_ref_key
  on public.glofox_bookings (tenant_id, external_ref);
create index if not exists glofox_bookings_tenant_time_start_idx
  on public.glofox_bookings (tenant_id, time_start desc);
create index if not exists glofox_bookings_tenant_person_idx
  on public.glofox_bookings (tenant_id, person_external_ref);

-- glofox_transactions -------------------------------------------------------------
-- The money facts: reconciliation source + the pre-cutover FAILED-PAYMENT
-- queue (plan-final §4 negative branch: Stripe is Glofox-gated, so
-- transaction_status='ERROR' rows are the failed-payment source until phase
-- 5). transaction_status is a hard CHECK — the PAID/ERROR/REFUNDED vocabulary
-- is [LIVE]-verified complete, and the mapper quarantines anything else
-- rather than letting it near revenue. glofox_event_class is the classifier
-- output (contracts classifyGlofoxEvent); 'unknown' rows land here AS unknown
-- for visibility AND in import_quarantine for review (invariant #8).
-- updated_at + touch BY DESIGN: Glofox rows CAN change (PAID→REFUNDED) and
-- the import upserts them — the IMMUTABLE record is glofox_raw; this table is
-- the queryable projection.
create table if not exists public.glofox_transactions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete cascade,
  external_ref            text not null,
  -- The wrapper key (README §5: only StripeCharge observed; the mapper
  -- quarantines unknown wrappers rather than mapping them).
  provider                text not null default 'StripeCharge',
  transaction_status      text not null
                          check (transaction_status in ('PAID', 'ERROR', 'REFUNDED')),
  amount                  numeric(10, 2) not null,
  currency                text not null,
  amount_refunded         numeric(10, 2),
  glofox_event            text,
  glofox_event_class      text not null
                          check (glofox_event_class in (
                            'subscription_payment', 'invoice_payment', 'book_class', 'unknown'
                          )),
  person_external_ref     text,
  plan_code               text,
  stripe_subscription_id  text,
  payment_method          text,
  invoice_external_ref    text,
  event_external_ref      text,
  transaction_created_at  timestamptz,
  raw                     jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index if not exists glofox_transactions_tenant_external_ref_key
  on public.glofox_transactions (tenant_id, external_ref);
create index if not exists glofox_transactions_tenant_created_idx
  on public.glofox_transactions (tenant_id, transaction_created_at desc);
-- The failed-payment queue path: partial index keeps it small and hot.
create index if not exists glofox_transactions_tenant_errors_idx
  on public.glofox_transactions (tenant_id, transaction_status)
  where transaction_status = 'ERROR';
create index if not exists glofox_transactions_tenant_event_class_idx
  on public.glofox_transactions (tenant_id, glofox_event_class);

-- triggers ----------------------------------------------------------------------
create or replace trigger glofox_sessions_touch_updated_at
  before update on public.glofox_sessions
  for each row execute function app.touch_updated_at();

create or replace trigger glofox_bookings_touch_updated_at
  before update on public.glofox_bookings
  for each row execute function app.touch_updated_at();

create or replace trigger glofox_transactions_touch_updated_at
  before update on public.glofox_transactions
  for each row execute function app.touch_updated_at();

-- RLS ---------------------------------------------------------------------------
-- Member-SELECT on all three (membership-based, invariant #7): the operator
-- UI reads rosters/schedules/money screens. Money role-narrowing to
-- owner/manager lands with the Payments UI phase. NO client write policies —
-- the sync jobs write under the service role, which bypasses RLS.
alter table public.glofox_sessions enable row level security;
alter table public.glofox_bookings enable row level security;
alter table public.glofox_transactions enable row level security;

drop policy if exists glofox_sessions_select on public.glofox_sessions;
create policy glofox_sessions_select on public.glofox_sessions
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists glofox_bookings_select on public.glofox_bookings;
create policy glofox_bookings_select on public.glofox_bookings
  for select
  using (tenant_id in (select app.current_tenant_ids()));

drop policy if exists glofox_transactions_select on public.glofox_transactions;
create policy glofox_transactions_select on public.glofox_transactions
  for select
  using (tenant_id in (select app.current_tenant_ids()));

-- grants ------------------------------------------------------------------------
-- The operator app is auth-gated: anon gets nothing. Strip table-level write
-- privileges from authenticated FIRST (hosted Supabase default privileges
-- grant them — the 0007 revoke pattern): service-writes-only, member-SELECT.
revoke all on public.glofox_sessions from anon;
revoke insert, update, delete on public.glofox_sessions from authenticated;
grant select on public.glofox_sessions to authenticated;

revoke all on public.glofox_bookings from anon;
revoke insert, update, delete on public.glofox_bookings from authenticated;
grant select on public.glofox_bookings to authenticated;

revoke all on public.glofox_transactions from anon;
revoke insert, update, delete on public.glofox_transactions from authenticated;
grant select on public.glofox_transactions to authenticated;
