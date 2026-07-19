-- Phase 5 · unit 1 — the BILLING CORE schema: the data spine every later
-- billing unit builds on. Connect account per tenant, sellable plans with
-- IMMUTABLE price phases, tenant↔Stripe customers, the durable webhook INBOX
-- (stripe_events) + command OUTBOX (stripe_commands), the payment event record,
-- and request-level idempotency_keys.
--
-- Money invariants enforced here (plan-final §5/§6, threat-model §6):
--   * Ledgers/price history are APPEND-ONLY (invariant #6): plan_prices is
--     immutable except superseded_at, which only a definer fn may set — no
--     client UPDATE grant. The attack suite block (26) re-asserts this.
--   * The webhook receiver consumes the stripe_events TABLE, never the HTTP
--     request; every intended Stripe mutation is INSERTED into stripe_commands
--     (status 'pending') with its idempotency key BEFORE any API call — the
--     crash-safety spine.
--   * Webhooks are the confirmation authority: payments.status is flipped by
--     the service role (the webhook processor), never by an optimistic client.
--   * Everything is scoped per connected account (stripe_account_id) from the
--     first line — retrofitting Connect topology is the costliest payments
--     refactor to get wrong.
--
-- NO live Stripe exists yet (owner/Glofox-gated). Every stripe_* id column is
-- nullable until the account/customer/intent is actually created; the adapter
-- runs DRY-RUN without keys, exactly like the comms adapters.

-- Connect account per tenant --------------------------------------------------
create table public.stripe_accounts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  stripe_account_id text,
  status            text not null default 'pending'
                    check (status in ('pending', 'active', 'restricted', 'disabled')),
  charges_enabled   boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id)
);

create unique index stripe_accounts_stripe_id_key
  on public.stripe_accounts (stripe_account_id)
  where stripe_account_id is not null;

create or replace trigger stripe_accounts_touch_updated_at
  before update on public.stripe_accounts
  for each row execute function app.touch_updated_at();

comment on table public.stripe_accounts is
  'One Stripe Connect (Standard) account per tenant. stripe_account_id is null until the studio links as the first connected account. Member-read; the service role writes (account linking + webhook-driven status).';

-- Sellable plans (IMMUTABLE prices live in plan_prices, never here) -----------
create table public.plans (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  kelo_type  text not null
             check (kelo_type in ('recurring', 'unlimited', 'pack', 'drop_in', 'intro')),
  name       text not null check (length(trim(name)) > 0),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite unique so plan_prices carries a tenant-consistent FK.
  unique (tenant_id, id)
);

create index plans_tenant_active_idx
  on public.plans (tenant_id, active, kelo_type);

create or replace trigger plans_touch_updated_at
  before update on public.plans
  for each row execute function app.touch_updated_at();

comment on table public.plans is
  'Sellable plan definitions. Deliberately has NO price column — prices are immutable phases in plan_prices (launch-tier ramps are new rows, never mutations). Member-read; plan/price authoring (a later Phase 5 unit) writes via the service role.';

-- Immutable price PHASES (append-only history; supersede, never mutate) --------
create table public.plan_prices (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  plan_id         uuid not null,
  amount_cents    int not null check (amount_cents >= 0),
  currency        text not null default 'usd',
  interval        text check (interval is null or interval in ('month', 'week')),
  effective_from  timestamptz not null default now(),
  superseded_at   timestamptz,
  stripe_price_id text,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, plan_id)
    references public.plans (tenant_id, id) on delete cascade,
  check (superseded_at is null or superseded_at >= effective_from)
);

create index plan_prices_tenant_plan_effective_idx
  on public.plan_prices (tenant_id, plan_id, effective_from desc);
create index plan_prices_current_idx
  on public.plan_prices (tenant_id, plan_id)
  where superseded_at is null;

comment on table public.plan_prices is
  'APPEND-ONLY immutable price history (interval null = one-time). A launch-tier ramp (founding→opening→standard) is a NEW row; a superseded phase is NEVER re-priced. UPDATE/DELETE are revoked from every app role including service_role; the ONLY mutation is app.supersede_plan_price setting superseded_at (definer, no client grant).';

-- The single writer of superseded_at. SECURITY DEFINER runs as the table owner,
-- so it can UPDATE the one closed-off column even though every app role's UPDATE
-- grant is revoked; it re-verifies tenancy/role in-body (invariant #7). The
-- amount, currency, interval, and effective_from of a price are never touched.
create or replace function app.supersede_plan_price(
  p_tenant       uuid,
  p_price_id     uuid,
  p_superseded_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Enforce role only for an authenticated caller; the service role (auth.uid()
  -- null) runs the price-ramp automation with no interactive session.
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;

  update public.plan_prices pp
  set superseded_at = coalesce(p_superseded_at, now())
  where pp.tenant_id = p_tenant
    and pp.id = p_price_id
    and pp.superseded_at is null;
end;
$$;

comment on function app.supersede_plan_price(uuid, uuid, timestamptz) is
  'The ONLY path that sets plan_prices.superseded_at. Definer-owned so it bypasses the revoked UPDATE grant; re-verifies owner/manager tenancy; closes a price phase without ever re-pricing it. Prices remain immutable.';

create or replace function public.supersede_plan_price(
  p_tenant       uuid,
  p_price_id     uuid,
  p_superseded_at timestamptz default now()
)
returns void
language sql
security invoker
set search_path = ''
as $$ select app.supersede_plan_price(p_tenant, p_price_id, p_superseded_at); $$;

-- Tenant customer ↔ Stripe customer ------------------------------------------
create table public.customers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  person_id          uuid not null references public.people (id) on delete cascade,
  stripe_customer_id text,
  created_at         timestamptz not null default now(),
  unique (tenant_id, person_id),
  -- Composite unique so payments carries a tenant-consistent FK.
  unique (tenant_id, id)
);

create unique index customers_stripe_id_key
  on public.customers (stripe_customer_id)
  where stripe_customer_id is not null;

comment on table public.customers is
  'Tenant person ↔ Stripe customer mapping (lazy: stripe_customer_id is null until the first card-on-file/charge). unique(tenant_id, person_id) — one Stripe customer per person per tenant. Member-read; the service role writes.';

-- RAW WEBHOOK INBOX (threat-model §6): processors consume THIS TABLE ----------
-- No tenant_id: tenancy resolves during processing via stripe_account_id (the
-- connected account). Deny-all client RLS, exactly like webhook_events (0022).
create table public.stripe_events (
  id                uuid primary key default gen_random_uuid(),
  stripe_account_id text,
  event_id          text not null,
  type              text,
  payload           jsonb not null default '{}'::jsonb,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  status            text not null default 'received'
                    check (status in ('received', 'processed', 'error', 'ignored')),
  error             text,
  unique (event_id)
);

create index stripe_events_status_received_idx
  on public.stripe_events (status, received_at);

comment on table public.stripe_events is
  'Signature-verified Stripe webhook inbox, deduped on event_id BEFORE processing. Processors consume this table, never the raw HTTP request (threat-model §6). No tenant_id: events resolve tenancy through stripe_account_id. The generic tenant guard skips this table; explicit deny-all client RLS is still mandatory.';

-- DURABLE COMMAND OUTBOX (threat-model §6): persist BEFORE the API call --------
create table public.stripe_commands (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  kind             text not null check (length(trim(kind)) > 0),
  idempotency_key  text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'confirmed', 'failed')),
  stripe_object_id text,
  attempts         int not null default 0 check (attempts >= 0),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  -- Composite unique so payments carries a tenant-consistent FK to the command.
  unique (tenant_id, id)
);

create index stripe_commands_tenant_status_created_idx
  on public.stripe_commands (tenant_id, status, created_at);

create or replace trigger stripe_commands_touch_updated_at
  before update on public.stripe_commands
  for each row execute function app.touch_updated_at();

comment on table public.stripe_commands is
  'The durable OUTBOX: every intended Stripe mutation is INSERTED here (status pending) with its idempotency_key BEFORE any API call, then advanced pending→sent→confirmed/failed. Crash between insert and API call is recoverable; the idempotency_key makes the retried Stripe call safe. unique(tenant_id, idempotency_key). Member-read; the service role writes.';

-- Payment EVENT record (not a mutable balance) -------------------------------
create table public.payments (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants (id) on delete cascade,
  customer_id              uuid,
  stripe_payment_intent_id text,
  amount_cents             int not null check (amount_cents >= 0),
  currency                 text not null default 'usd',
  status                   text not null
                           check (status in (
                             'requires_payment', 'processing', 'succeeded',
                             'failed', 'refunded', 'partially_refunded'
                           )),
  command_id               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Composite FKs keep the customer/command tenant-consistent. NO on-delete
  -- action (not SET NULL — that would try to null the NOT NULL tenant_id, and
  -- not CASCADE — a payment is a retained financial event): a customer or
  -- command referenced by a payment cannot be deleted out from under it. A
  -- person with payment history is pseudonymized, never hard-deleted.
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id),
  foreign key (tenant_id, command_id)
    references public.stripe_commands (tenant_id, id)
);

create index payments_tenant_created_idx
  on public.payments (tenant_id, created_at desc);
create unique index payments_intent_key
  on public.payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create or replace trigger payments_touch_updated_at
  before update on public.payments
  for each row execute function app.touch_updated_at();

comment on table public.payments is
  'A payment is an EVENT, not a mutable balance column (invariant #6). The signed webhook is the confirmation authority: the service role flips status (requires_payment→processing→succeeded/failed/refunded). Member-read; NO optimistic client write path for money.';

-- REQUEST-level idempotency (replaces the middleware stub) --------------------
create table public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  key             text not null,
  request_hash    text not null,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  unique (tenant_id, key)
);

comment on table public.idempotency_keys is
  'Request-level idempotency (plan-final §3). The mutation middleware RESERVES a row (response null) before executing, then stores the response. Same (tenant,key)+same request_hash → replay the stored response; same key + DIFFERENT request_hash → 409 conflict. Member-read; the service role writes (reserve/store/release).';

-- RLS ------------------------------------------------------------------------
alter table public.stripe_accounts enable row level security;
alter table public.plans enable row level security;
alter table public.plan_prices enable row level security;
alter table public.customers enable row level security;
alter table public.stripe_events enable row level security;
alter table public.stripe_commands enable row level security;
alter table public.payments enable row level security;
alter table public.idempotency_keys enable row level security;

create policy stripe_accounts_select on public.stripe_accounts for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy plans_select on public.plans for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy plan_prices_select on public.plan_prices for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy customers_select on public.customers for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy stripe_commands_select on public.stripe_commands for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy payments_select on public.payments for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy idempotency_keys_select on public.idempotency_keys for select
  using (tenant_id in (select app.current_tenant_ids()));

-- stripe_events has no tenant_id. The service role bypasses RLS; every client
-- role is denied explicitly (mirrors webhook_events in 0022).
create policy stripe_events_no_client_access on public.stripe_events
  for all to authenticated, anon
  using (false) with check (false);

-- Exact grants ---------------------------------------------------------------
revoke all on public.stripe_accounts, public.plans, public.plan_prices,
  public.customers, public.stripe_events, public.stripe_commands,
  public.payments, public.idempotency_keys
  from anon, authenticated, service_role;

-- Member-read; the service role writes the account + webhook-driven status.
grant select on public.stripe_accounts to authenticated, service_role;
grant insert, update on public.stripe_accounts to service_role;

-- Plans: member-read; the plan-authoring unit writes via the service role.
grant select on public.plans to authenticated, service_role;
grant insert, update on public.plans to service_role;

-- Prices: member-read; the service role INSERTS new phases. UPDATE/DELETE are
-- revoked from EVERY role (append-only); app.supersede_plan_price (definer,
-- owner-run) is the sole path that sets superseded_at.
grant select on public.plan_prices to authenticated, service_role;
grant insert on public.plan_prices to service_role;
revoke update, delete on public.plan_prices from anon, authenticated, service_role;

grant select on public.customers to authenticated, service_role;
grant insert, update on public.customers to service_role;

-- Inbox: service-role only (select/insert/update the status). No client access.
grant select, insert, update on public.stripe_events to service_role;

grant select on public.stripe_commands to authenticated, service_role;
grant insert, update on public.stripe_commands to service_role;

grant select on public.payments to authenticated, service_role;
grant insert, update on public.payments to service_role;

-- Idempotency: member-read; the service role reserves/stores/releases. DELETE is
-- granted (only to service_role) so a failed request releases its reservation.
grant select on public.idempotency_keys to authenticated, service_role;
grant insert, update, delete on public.idempotency_keys to service_role;

revoke all on function app.supersede_plan_price(uuid, uuid, timestamptz) from public;
grant execute on function app.supersede_plan_price(uuid, uuid, timestamptz)
  to authenticated, service_role;
revoke all on function public.supersede_plan_price(uuid, uuid, timestamptz) from public;
grant execute on function public.supersede_plan_price(uuid, uuid, timestamptz)
  to authenticated, service_role;
