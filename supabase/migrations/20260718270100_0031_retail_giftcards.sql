-- Phase 4 · unit 4 — retail catalog, gift-card catalog, and MANUAL (comp)
-- gift-card grants on an append-only balance ledger.
--
-- Scope discipline (plan-final §6 phase-4 row): this unit ships the CATALOG,
-- the ISSUED card, the append-only ledger, and the comp/manual grant path.
-- The PAID sale (money movement, redemption at POS) is phase 5 — no charge,
-- refund, or redeem RPC lives here. The redemption code is a SECRET: only its
-- sha256 hash is ever stored (mirrors migration 0002 invitation tokens), and
-- the raw code is returned exactly once by the API at grant time.

-- Retail catalog ------------------------------------------------------------
create table public.retail_products (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  sku          text,
  price_cents  int not null check (price_cents >= 0),
  tax_category text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index retail_products_tenant_active_name_idx
  on public.retail_products (tenant_id, active, name);

comment on table public.retail_products is
  'Sellable retail catalog. Price is authored in minor units (cents). The PAID sale ships with POS in phase 5; this is the catalog only.';

-- Gift-card catalog (purchasable SKUs / denominations) ----------------------
create table public.gift_card_products (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  amount_cents int not null check (amount_cents > 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index gift_card_products_tenant_active_name_idx
  on public.gift_card_products (tenant_id, active, name);

comment on table public.gift_card_products is
  'Purchasable gift-card denominations/designs. Selling one for money ships with POS (phase 5); comping one is app.grant_gift_card here.';

-- Issued gift card ----------------------------------------------------------
-- Only the sha256 HASH of the redemption code is stored. The raw code exists
-- transiently in the API response at grant time and is unrecoverable after.
create table public.gift_cards (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  code_hash           text not null check (length(trim(code_hash)) > 0),
  issued_to_person_id uuid references public.people (id) on delete set null,
  status              text not null default 'active' check (status in ('active', 'void')),
  created_at          timestamptz not null default now(),
  unique (tenant_id, code_hash),
  -- Composite unique so gift_card_ledger can carry a tenant-consistent FK.
  unique (tenant_id, id)
);

create index gift_cards_tenant_created_idx
  on public.gift_cards (tenant_id, created_at desc);

comment on table public.gift_cards is
  'An issued gift card. code_hash is sha256(raw code) — the raw code is never persisted and is returned exactly once at grant time. Balance lives in gift_card_ledger, never in a column.';

-- Append-only balance ledger (invariant #6 — NO mutable balance column) -----
create table public.gift_card_ledger (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  gift_card_id  uuid not null,
  entry_type    text not null check (entry_type in ('issue', 'redeem', 'adjust', 'void')),
  amount_cents  int not null,
  reason        text,
  actor_user_id uuid,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, gift_card_id)
    references public.gift_cards (tenant_id, id) on delete cascade,
  -- Signed convention: +issue, -redeem. adjust/void may move either way.
  check (
    (entry_type = 'issue' and amount_cents > 0)
    or (entry_type = 'redeem' and amount_cents < 0)
    or entry_type in ('adjust', 'void')
  )
);

create index gift_card_ledger_tenant_card_created_idx
  on public.gift_card_ledger (tenant_id, gift_card_id, created_at);

comment on table public.gift_card_ledger is
  'APPEND-ONLY gift-card balance history. Balance = sum(amount_cents). UPDATE and DELETE are revoked from every application role, including service_role. Redemption entries land with POS in phase 5.';

-- Balance = sum over the ledger. SECURITY INVOKER so RLS scopes the read to
-- the caller's tenant; a foreign tenant simply sums to zero rows.
create or replace function public.gift_card_balance(p_tenant uuid, p_card uuid)
returns int
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(l.amount_cents), 0)::int
  from public.gift_card_ledger l
  where l.tenant_id = p_tenant
    and l.gift_card_id = p_card;
$$;

comment on function public.gift_card_balance(uuid, uuid) is
  'Current gift-card balance as the sum of its append-only ledger. RLS-scoped (SECURITY INVOKER); reads nothing outside the caller''s tenant.';

-- MANUAL (comp) grant: the ONLY write path to gift_cards + the ledger in phase
-- 4. It issues the card and its initial 'issue' entry in one transaction. No
-- money moves. Owner/manager + tenancy are re-verified in-body (invariant #7).
create or replace function app.grant_gift_card(
  p_tenant       uuid,
  p_amount_cents int,
  p_code_hash    text,
  p_person       uuid,
  p_actor        uuid,
  p_reason       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_id uuid;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_actor then
    raise exception 'grant actor must be the authenticated user' using errcode = '42501';
  end if;
  if not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'gift card amount must be positive' using errcode = '22023';
  end if;
  if p_code_hash is null or length(trim(p_code_hash)) = 0 then
    raise exception 'gift card code hash is required' using errcode = '22023';
  end if;
  if p_person is not null and not exists (
    select 1 from public.people pp where pp.tenant_id = p_tenant and pp.id = p_person
  ) then
    raise exception 'person not found' using errcode = 'P0002';
  end if;

  insert into public.gift_cards (tenant_id, code_hash, issued_to_person_id, status)
  values (p_tenant, p_code_hash, p_person, 'active')
  returning id into v_card_id;

  insert into public.gift_card_ledger
    (tenant_id, gift_card_id, entry_type, amount_cents, reason, actor_user_id)
  values
    (p_tenant, v_card_id, 'issue', p_amount_cents, p_reason, p_actor);

  return v_card_id;
end;
$$;

comment on function app.grant_gift_card(uuid, int, text, uuid, uuid, text) is
  'OWNER/MANAGER manual (comp) grant. Re-verifies tenancy + actor, issues the card and its initial ''issue'' ledger entry in one transaction, and returns the card id. No money movement — paid sales ship with POS in phase 5.';

-- PostgREST invoker wrapper: keeps app.grant_gift_card the security boundary
-- while making it callable through the ordinary user-scoped Supabase client.
create or replace function public.grant_gift_card(
  p_tenant       uuid,
  p_amount_cents int,
  p_code_hash    text,
  p_person       uuid,
  p_actor        uuid,
  p_reason       text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select app.grant_gift_card(p_tenant, p_amount_cents, p_code_hash, p_person, p_actor, p_reason); $$;

-- RLS: every active tenant member may read; only owner/manager may author the
-- catalogs. Issued cards + the ledger have NO direct authenticated write path
-- (grant_gift_card runs as its owner; phase-5 redemption runs as service_role).
alter table public.retail_products enable row level security;
alter table public.gift_card_products enable row level security;
alter table public.gift_cards enable row level security;
alter table public.gift_card_ledger enable row level security;

create policy retail_products_select on public.retail_products for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy retail_products_insert on public.retail_products for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy retail_products_update on public.retail_products for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy retail_products_delete on public.retail_products for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy gift_card_products_select on public.gift_card_products for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy gift_card_products_insert on public.gift_card_products for insert
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy gift_card_products_update on public.gift_card_products for update
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']))
  with check (app.has_tenant_role(tenant_id, array['owner', 'manager']));
create policy gift_card_products_delete on public.gift_card_products for delete
  using (app.has_tenant_role(tenant_id, array['owner', 'manager']));

create policy gift_cards_select on public.gift_cards for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy gift_card_ledger_select on public.gift_card_ledger for select
  using (tenant_id in (select app.current_tenant_ids()));

-- Exact grants. Catalogs are directly writable by owner/manager (RLS-gated).
revoke all on public.retail_products, public.gift_card_products
  from anon, authenticated, service_role;
grant select, insert, update, delete on public.retail_products, public.gift_card_products
  to authenticated, service_role;

-- Issued cards: no direct authenticated write; grant_gift_card (definer) issues
-- them, and service_role may void/adjust status in phase 5.
revoke all on public.gift_cards from anon, authenticated, service_role;
grant select on public.gift_cards to authenticated, service_role;
grant insert, update on public.gift_cards to service_role;
revoke delete on public.gift_cards from anon, authenticated, service_role;

-- Ledger: APPEND-ONLY. Read for members; insert only for service_role (phase-5
-- redemption); UPDATE and DELETE revoked from everyone, service_role included.
revoke all on public.gift_card_ledger from anon, authenticated, service_role;
grant select on public.gift_card_ledger to authenticated, service_role;
grant insert on public.gift_card_ledger to service_role;
revoke update, delete on public.gift_card_ledger from anon, authenticated, service_role;

revoke all on function public.gift_card_balance(uuid, uuid) from public;
grant execute on function public.gift_card_balance(uuid, uuid) to authenticated, service_role;

revoke all on function app.grant_gift_card(uuid, int, text, uuid, uuid, text) from public;
grant execute on function app.grant_gift_card(uuid, int, text, uuid, uuid, text)
  to authenticated, service_role;
revoke all on function public.grant_gift_card(uuid, int, text, uuid, uuid, text) from public;
grant execute on function public.grant_gift_card(uuid, int, text, uuid, uuid, text)
  to authenticated, service_role;
