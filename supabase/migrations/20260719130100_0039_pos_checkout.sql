-- Phase 5 · unit 5.7 — THE POS BACKEND. The operator sells retail items, gift
-- cards, and (plan-typed) drop-ins over the counter, with CASH today and card
-- checkout deferred to the EXISTING create_payment_intent seam once a live
-- Stripe Connect account exists. This migration ships:
--   * payments.tender — the cash-vs-stripe discriminator (backfilled 'stripe').
--   * pos_orders + pos_order_lines — the receipt's source of truth.
--   * app.pos_checkout — the server-priced, idempotent checkout RPC.
--   * app.issue_order_gift_cards — the shared gift-card issuance path (inline for
--     cash; called by the inbox on payment_intent.succeeded for stripe tender).
--   * app.redeem_gift_card — ledger-append redemption with row-lock serialization.
--   * the global 'pos_receipt' template.
--
-- Money invariants enforced here (plan-final §5/§6, threat-model §6):
--   * Server-side pricing ONLY: pos_checkout resolves every line price from the
--     LIVE catalog and computes the total in-body — client amounts are never
--     trusted (they are not even in the RPC signature).
--   * CASH IS AN OPERATOR-ATTESTED FACT with no webhook: a cash checkout records
--     its payment 'succeeded' INSIDE the RPC (actor-audited via pos_orders.actor).
--     This is the ONE documented exception to webhook-as-authority, scoped by
--     tender = 'cash'. STRIPE payments stay webhook-only: tender 'stripe' writes
--     a requires_payment payment + a create_payment_intent outbox command (the
--     0034 pattern) keyed on the SAME idempotency key, and its terminal state is
--     the webhook/inbox's alone.
--   * Ledgers are APPEND-ONLY (invariant #6): gift_card_ledger gains an
--     idempotency_key column but keeps its revoked UPDATE/DELETE (block 26).
--     Redemption appends a NEGATIVE 'redeem' entry; it never mutates a balance.
--   * SECURITY DEFINER + search_path='' + in-body tenancy/role re-check
--     (invariant #7): owner/manager/front_desk may check out; a NONZERO discount
--     requires owner/manager (front_desk + discount → 42501). Shared-device
--     manager step-up rides the API layer (a manager re-auths so the actor IS a
--     manager); the DB re-check is the hard floor.
--   * Idempotent via the persisted idempotency middleware (API) AND
--     unique(tenant_id, idempotency_key) on pos_orders + stripe_commands.

-- payments.tender — the cash-vs-stripe discriminator ---------------------------
-- ADD COLUMN with a NOT NULL default backfills every existing payment to
-- 'stripe' in one shot (all prior payments are card intents). verify_money's
-- check 1 (terminal-paid must carry a stripe_payment_intent_id) becomes
-- tender-scoped ('stripe' only) in workers/src/billing/verify.ts — a cash sale
-- legitimately has no intent id and must NOT be a false CRITICAL violation.
alter table public.payments
  add column tender text not null default 'stripe'
    check (tender in ('stripe', 'cash', 'gift_card'));

comment on column public.payments.tender is
  'How the payment is tendered: ''stripe'' (webhook-confirmed; the default and the backfill for every pre-POS payment) or ''cash'' (operator-attested, recorded ''succeeded'' inside app.pos_checkout — the one documented exception to webhook-as-authority, scoped by this column). verify_money check 1 is tender-scoped to ''stripe'' so a cash sale''s null intent id is not a violation.';

-- gift_card_ledger idempotency (redemption) -----------------------------------
-- The ledger is append-only; redemption idempotency lives in a per-entry key +
-- a partial unique index (a re-call with the same key appends nothing). No
-- UPDATE/DELETE grant is added — the append-only invariant (block 26) holds.
alter table public.gift_card_ledger
  add column idempotency_key text;

create unique index gift_card_ledger_tenant_idem_key
  on public.gift_card_ledger (tenant_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.gift_card_ledger.idempotency_key is
  'Redemption idempotency key (app.redeem_gift_card). A partial unique index on (tenant_id, idempotency_key) makes a duplicate redemption a no-op replay. Null for issue/adjust/void entries.';

-- pos_orders — the receipt's source of truth ----------------------------------
create table public.pos_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  actor_user_id   uuid not null,
  -- Null-ok: a walk-in has no person on file. A receipt still lists the lines.
  person_id       uuid references public.people (id) on delete set null,
  -- Simple FK (payments has no (tenant_id, id) composite): the RPC sets the
  -- tenant-consistent payment id in-body. NO on-delete action — a retained sale
  -- never loses its payment link.
  payment_id      uuid references public.payments (id),
  subtotal_cents  int not null check (subtotal_cents >= 0),
  discount_cents  int not null default 0 check (discount_cents >= 0),
  tax_cents       int not null default 0 check (tax_cents >= 0),
  total_cents     int not null check (total_cents >= 0),
  tender          text not null check (tender in ('stripe', 'cash', 'gift_card')),
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  -- Composite unique so pos_order_lines carries a tenant-consistent FK.
  unique (tenant_id, id)
);

create index pos_orders_tenant_created_idx
  on public.pos_orders (tenant_id, created_at desc);

create or replace trigger pos_orders_touch_updated_at
  before update on public.pos_orders
  for each row execute function app.touch_updated_at();

comment on table public.pos_orders is
  'A completed (cash) or intended (stripe) counter sale — the receipt''s source of truth. Totals are server-computed in app.pos_checkout; the client never sends prices. Member-read; the definer RPC is the ONLY writer. Idempotent on (tenant_id, idempotency_key).';

-- pos_order_lines — the itemized receipt --------------------------------------
-- NOT append-only: a gift_card line is UPDATEd once (issued_at + gift_card_id)
-- when its card is issued (inline for cash; on payment success for stripe). All
-- writes go through definer RPCs, so no client/service write grant is needed.
create table public.pos_order_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  order_id         uuid not null,
  kind             text not null check (kind in ('retail', 'gift_card', 'drop_in')),
  -- retail_products.id / gift_card_products.id / plans.id (kelo_type drop_in).
  ref_id           uuid not null,
  qty              int not null check (qty > 0),
  unit_price_cents int not null check (unit_price_cents >= 0),
  line_total_cents int not null check (line_total_cents >= 0),
  -- Gift-card issuance state (null for retail/drop_in and un-issued gift cards).
  gift_card_id     uuid,
  issued_at        timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, order_id)
    references public.pos_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, gift_card_id)
    references public.gift_cards (tenant_id, id)
);

create index pos_order_lines_order_idx
  on public.pos_order_lines (tenant_id, order_id);
create index pos_order_lines_unissued_gift_idx
  on public.pos_order_lines (tenant_id, order_id)
  where kind = 'gift_card' and issued_at is null;

comment on table public.pos_order_lines is
  'Itemized receipt lines. unit_price_cents is the server-resolved catalog price at checkout time; line_total_cents = unit_price_cents * qty. A gift_card line''s issued_at/gift_card_id are set once when the card is issued (inline for cash; by the inbox on payment_intent.succeeded for stripe). Member-read; definer RPCs are the only writers.';

-- app.issue_order_gift_cards — the shared issuance path ------------------------
-- Issues a fresh card per un-issued gift_card line of a PAID order: generates
-- the code server-side, stores only its sha256 hash (the 0031 pattern), appends
-- the 'issue' ledger entry, and stamps the line. Returns a jsonb array of
-- {card_id, code} — the raw code exists ONLY in this return value (cash: relayed
-- to the buyer by pos_checkout; stripe: the inbox issues idempotently). GATED on
-- the order's payment being 'succeeded', and IDEMPOTENT via `issued_at is null` +
-- FOR UPDATE on the lines: a re-call issues nothing already issued (replay-safe
-- for at-least-once inbox delivery).
create or replace function app.issue_order_gift_cards(
  p_tenant uuid,
  p_order  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay_status text;
  v_person     uuid;
  v_line       record;
  v_code       text;
  v_hash       text;
  v_card_id    uuid;
  v_result     jsonb := '[]'::jsonb;
begin
  -- Only a SUCCEEDED order issues cards. A stripe order still requires_payment
  -- returns an empty array (the inbox re-calls after the webhook confirms).
  select pay.status, o.person_id
  into v_pay_status, v_person
  from public.pos_orders o
  join public.payments pay
    on pay.id = o.payment_id and pay.tenant_id = o.tenant_id
  where o.tenant_id = p_tenant and o.id = p_order;

  if v_pay_status is distinct from 'succeeded' then
    return v_result;
  end if;

  for v_line in
    select id, unit_price_cents
    from public.pos_order_lines
    where tenant_id = p_tenant
      and order_id = p_order
      and kind = 'gift_card'
      and issued_at is null
    for update
  loop
    -- Server-generated redemption secret: only its sha256 hash is persisted; the
    -- raw code is returned exactly once (0031). 20 uppercase hex chars (~80 bits).
    v_code := upper(encode(extensions.gen_random_bytes(10), 'hex'));
    v_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');

    insert into public.gift_cards (tenant_id, code_hash, issued_to_person_id, status)
    values (p_tenant, v_hash, v_person, 'active')
    returning id into v_card_id;

    insert into public.gift_card_ledger
      (tenant_id, gift_card_id, entry_type, amount_cents, reason, actor_user_id)
    values
      (p_tenant, v_card_id, 'issue', v_line.unit_price_cents, 'pos_sale', null);

    update public.pos_order_lines
    set issued_at = now(), gift_card_id = v_card_id
    where tenant_id = p_tenant and id = v_line.id;

    v_result := v_result || jsonb_build_object('card_id', v_card_id, 'code', v_code);
  end loop;

  return v_result;
end;
$$;

comment on function app.issue_order_gift_cards(uuid, uuid) is
  'Issues a gift card per un-issued gift_card line of a SUCCEEDED pos_order: server-generated code, sha256 hash stored, ''issue'' ledger entry appended, line stamped. Returns [{card_id, code}] — the raw code exists only here. Idempotent (issued_at is null + FOR UPDATE): replay-safe for at-least-once inbox delivery. Definer-owned; the service role (inbox) and app.pos_checkout are the callers.';

-- app.redeem_gift_card — ledger-append redemption -----------------------------
-- Hashes the raw code, locks the active card (FOR UPDATE serializes concurrent
-- redemptions), checks the balance via the append-only ledger, and appends a
-- NEGATIVE 'redeem' entry. Over-redemption raises. Idempotent on
-- (tenant, idempotency_key) via the ledger's partial unique index. Returns
-- {gift_card_id, redeemed_cents, balance_cents}.
create or replace function app.redeem_gift_card(
  p_tenant          uuid,
  p_actor           uuid,
  p_code            text,
  p_amount_cents    int,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash    text;
  v_card_id uuid;
  v_balance int;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'redemption actor must be the authenticated user' using errcode = '42501';
  end if;
  -- front_desk redeems at the counter (same posture as taking a payment).
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'redemption amount must be positive' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'gift card code is required' using errcode = '22023';
  end if;

  -- Idempotent replay (fast path): this key already redeemed → return its result.
  select l.gift_card_id, -l.amount_cents
  into v_card_id, v_balance
  from public.gift_card_ledger l
  where l.tenant_id = p_tenant and l.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'gift_card_id', v_card_id,
      'redeemed_cents', v_balance,
      'balance_cents', public.gift_card_balance(p_tenant, v_card_id)
    );
  end if;

  v_hash := encode(extensions.digest(p_code, 'sha256'), 'hex');

  -- Row-lock the card so concurrent redemptions on the SAME card SERIALIZE: the
  -- second waits for the first to commit, then recomputes the balance below and
  -- sees the reduced ceiling (closes the double-spend TOCTOU race).
  select id into v_card_id
  from public.gift_cards
  where tenant_id = p_tenant and code_hash = v_hash and status = 'active'
  for update;
  if not found then
    raise exception 'active gift card not found' using errcode = 'P0002';
  end if;

  v_balance := public.gift_card_balance(p_tenant, v_card_id);
  if p_amount_cents > v_balance then
    raise exception 'redemption exceeds gift card balance (% remaining)', v_balance
      using errcode = '22023';
  end if;

  begin
    insert into public.gift_card_ledger
      (tenant_id, gift_card_id, entry_type, amount_cents, reason, actor_user_id, idempotency_key)
    values
      (p_tenant, v_card_id, 'redeem', -p_amount_cents, 'pos_redeem', p_actor, p_idempotency_key);
  exception when unique_violation then
    -- Lost the (tenant, idempotency_key) race: return the winner's result.
    select l.gift_card_id, -l.amount_cents
    into v_card_id, v_balance
    from public.gift_card_ledger l
    where l.tenant_id = p_tenant and l.idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'gift_card_id', v_card_id,
      'redeemed_cents', v_balance,
      'balance_cents', public.gift_card_balance(p_tenant, v_card_id)
    );
  end;

  return jsonb_build_object(
    'gift_card_id', v_card_id,
    'redeemed_cents', p_amount_cents,
    'balance_cents', public.gift_card_balance(p_tenant, v_card_id)
  );
end;
$$;

comment on function app.redeem_gift_card(uuid, uuid, text, int, text) is
  'Redeems a gift card: hashes the code, FOR UPDATE-locks the active card (serializes concurrent redemptions), checks the balance via the append-only ledger, and appends a NEGATIVE ''redeem'' entry (never mutates a balance). Over-redemption raises 22023. Idempotent on (tenant, idempotency_key) via the ledger''s partial unique index. Owner/manager/front_desk. Returns {gift_card_id, redeemed_cents, balance_cents}.';

create or replace function public.redeem_gift_card(
  p_tenant          uuid,
  p_actor           uuid,
  p_code            text,
  p_amount_cents    int,
  p_idempotency_key text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select app.redeem_gift_card(p_tenant, p_actor, p_code, p_amount_cents, p_idempotency_key);
$$;

-- app.pos_checkout — the server-priced, idempotent checkout RPC ----------------
create or replace function app.pos_checkout(
  p_tenant          uuid,
  p_actor           uuid,
  p_idempotency_key text,
  p_person          uuid,
  p_lines           jsonb,
  p_tender          text,
  p_discount_cents  int default 0,
  -- Settlement gift card (tender='gift_card'): the RAW code the member hands
  -- over; hashed + ledger-debited in-body. Null for cash/stripe tenders.
  p_gift_card_code  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id   uuid;
  v_payment_id uuid;
  v_command_id uuid;
  v_customer   uuid;
  v_elem       jsonb;
  v_kind       text;
  v_ref        uuid;
  v_qty        int;
  v_unit       int;
  v_subtotal   int := 0;
  v_resolved   jsonb := '[]'::jsonb;
  v_r          jsonb;
  v_rate_bp    int;
  v_gift_sale  int := 0;
  v_taxable    int;
  v_tax        int;
  v_total      int;
  v_codes      jsonb := '[]'::jsonb;
  v_email      text;
  v_first      text;
  v_studio     text;
  v_body       text;
  v_log_id     uuid;
  v_out        jsonb;
begin
  -- Actor binding + role re-check (invariant #7). The service role (auth.uid()
  -- null) runs unattended with no interactive role check.
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'checkout actor must be the authenticated user' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null then
    if not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
      raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
    end if;
    -- A discount is a manager decision. front_desk + discount → 42501; a
    -- shared-device manager step-up (API layer) re-auths so the actor IS a
    -- manager, and this re-check passes.
    if coalesce(p_discount_cents, 0) > 0
       and not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
      raise exception 'a discount requires owner or manager' using errcode = '42501';
    end if;
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if p_tender is null or p_tender not in ('cash', 'stripe', 'gift_card') then
    raise exception 'tender must be cash, stripe, or gift_card' using errcode = '22023';
  end if;
  -- REVIEW FIX (5.7-crit-1): a stripe-tender gift-card SALE is refused until the
  -- code-delivery seam ships with the live Connect account — the inbox issues
  -- the card on payment success but the raw code's only carrier is the RPC
  -- return, which the buyer never sees on the async path. Money must never buy
  -- an unredeemable card. Cash (code returned once, in-person) is unaffected.
  if p_tender = 'stripe' and exists (
    select 1 from jsonb_array_elements(p_lines) l where l ->> 'kind' = 'gift_card'
  ) then
    raise exception 'gift-card sales are cash-only until card checkout ships (code delivery)'
      using errcode = '22023';
  end if;
  -- REVIEW FIX (5.7-crit-2): buying a gift card WITH a gift card is circular.
  if p_tender = 'gift_card' and exists (
    select 1 from jsonb_array_elements(p_lines) l where l ->> 'kind' = 'gift_card'
  ) then
    raise exception 'a gift card cannot pay for a gift card' using errcode = '22023';
  end if;
  if p_tender = 'gift_card' and (p_gift_card_code is null or length(trim(p_gift_card_code)) = 0) then
    raise exception 'gift_card tender requires the card code' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'at least one line is required' using errcode = '22023';
  end if;
  if coalesce(p_discount_cents, 0) < 0 then
    raise exception 'discount must be non-negative' using errcode = '22023';
  end if;
  if p_person is not null and not exists (
    select 1 from public.people pp where pp.tenant_id = p_tenant and pp.id = p_person
  ) then
    raise exception 'person not found for tenant' using errcode = 'P0002';
  end if;

  -- Idempotent replay (fast path): an order already exists for this key. The raw
  -- gift-card codes are NOT re-returned (write-once secrets); the API's persisted
  -- idempotency middleware replays the original HTTP response verbatim.
  select id, payment_id into v_order_id, v_payment_id
  from public.pos_orders
  where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('payment_id', v_payment_id, 'order_id', v_order_id);
  end if;

  -- SERVER-SIDE PRICING: resolve each line against the LIVE catalog. Client
  -- amounts are never accepted. Unknown/inactive/foreign refs raise.
  for v_elem in select value from jsonb_array_elements(p_lines) loop
    v_kind := v_elem ->> 'kind';
    v_ref  := (v_elem ->> 'ref_id')::uuid;
    v_qty  := (v_elem ->> 'qty')::int;
    if v_ref is null then
      raise exception 'each line needs a ref_id' using errcode = '22023';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'each line needs a positive qty' using errcode = '22023';
    end if;

    if v_kind = 'retail' then
      select rp.price_cents into v_unit
      from public.retail_products rp
      where rp.tenant_id = p_tenant and rp.id = v_ref and rp.active;
    elsif v_kind = 'gift_card' then
      -- One physical card per line: a qty <> 1 gift-card line is ambiguous.
      if v_qty <> 1 then
        raise exception 'a gift_card line must have qty 1' using errcode = '22023';
      end if;
      select gp.amount_cents into v_unit
      from public.gift_card_products gp
      where gp.tenant_id = p_tenant and gp.id = v_ref and gp.active;
    elsif v_kind = 'drop_in' then
      -- Price from the CURRENT (un-superseded) plan_prices phase of a drop_in plan.
      select pp.amount_cents into v_unit
      from public.plans pl
      join public.plan_prices pp
        on pp.tenant_id = pl.tenant_id and pp.plan_id = pl.id and pp.superseded_at is null
      where pl.tenant_id = p_tenant and pl.id = v_ref
        and pl.kelo_type = 'drop_in' and pl.active
      order by pp.effective_from desc
      limit 1;
    else
      raise exception 'unknown line kind %', v_kind using errcode = '22023';
    end if;

    if v_unit is null then
      raise exception 'catalog item not found for tenant (% %)', v_kind, v_ref
        using errcode = 'P0002';
    end if;

    v_subtotal := v_subtotal + v_unit * v_qty;
    v_resolved := v_resolved || jsonb_build_object(
      'kind', v_kind, 'ref_id', v_ref, 'qty', v_qty,
      'unit', v_unit, 'line_total', v_unit * v_qty
    );
  end loop;

  if coalesce(p_discount_cents, 0) > v_subtotal then
    raise exception 'discount exceeds subtotal' using errcode = '22023';
  end if;

  -- TAX is computed server-side from tenants.settings->>'tax_rate_bp' (basis
  -- points; default 0 — owner question A6 open). A client tax amount is
  -- deliberately NOT a parameter; the client cannot assert a tax figure.
  -- Digit-guarded (a malformed setting falls back to 0, never 500s checkout).
  select coalesce(
           case when t.settings ->> 'tax_rate_bp' ~ '^[0-9]{1,5}$'
                then (t.settings ->> 'tax_rate_bp')::int
           end, 0) into v_rate_bp
  from public.tenants t where t.id = p_tenant;
  if v_rate_bp is null or v_rate_bp < 0 then
    v_rate_bp := 0;
  end if;
  -- Gift-card FACE VALUE is excluded from the taxable base (standard treatment:
  -- the card is stored value; tax applies when it buys goods — and settlement
  -- tender='gift_card' orders ARE taxed normally on their goods). Pending A6.
  select coalesce(sum((r ->> 'line_total')::int), 0) into v_gift_sale
  from jsonb_array_elements(v_resolved) r
  where r ->> 'kind' = 'gift_card';
  v_taxable := greatest(v_subtotal - v_gift_sale - coalesce(p_discount_cents, 0), 0);
  v_tax     := (v_taxable * v_rate_bp) / 10000;   -- integer floor
  v_total   := v_subtotal - coalesce(p_discount_cents, 0) + v_tax;

  -- For stripe tender the buyer must be a customer on file (the create_intent
  -- seam needs it). Terminal is not built now — this documents the card path.
  if p_tender = 'stripe' then
    if p_person is null then
      raise exception 'stripe tender requires a customer on file' using errcode = '22023';
    end if;
    select c.id into v_customer
    from public.customers c
    where c.tenant_id = p_tenant and c.person_id = p_person;
    if v_customer is null then
      raise exception 'stripe tender requires a customer on file' using errcode = '22023';
    end if;
  end if;

  -- Fresh: create the payment + order + lines in one transaction. A concurrent
  -- duplicate loses the (tenant, idempotency_key) race on stripe_commands or
  -- pos_orders and replays the winner.
  begin
    if p_tender = 'stripe' then
      -- The 0034 pattern: the outbox command BEFORE the payment, same key.
      insert into public.stripe_commands
        (tenant_id, kind, idempotency_key, payload, status)
      values
        (p_tenant, 'create_payment_intent', p_idempotency_key,
         jsonb_build_object('amount_cents', v_total, 'currency', 'usd', 'customer_id', v_customer),
         'pending')
      returning id into v_command_id;

      insert into public.payments
        (tenant_id, customer_id, amount_cents, currency, status, tender, command_id)
      values
        (p_tenant, v_customer, v_total, 'usd', 'requires_payment', 'stripe', v_command_id)
      returning id into v_payment_id;
    elsif p_tender = 'gift_card' then
      -- REVIEW FIX (5.7-crit-2): SETTLEMENT WITH A GIFT CARD — the ledger debit
      -- and the payment record happen in THIS transaction, so a sale paid by
      -- gift card is never rung as phantom cash (double-counted revenue). The
      -- debit reuses app.redeem_gift_card (row-lock serialization, ledger-sum
      -- balance, over-redemption raises, idempotent on the derived key); the
      -- payment is an attested non-stripe settlement (tender scopes it out of
      -- verify_money check 1, like cash).
      perform app.redeem_gift_card(
        p_tenant, p_actor, p_gift_card_code, v_total, p_idempotency_key || ':settle');

      insert into public.payments
        (tenant_id, customer_id, amount_cents, currency, status, tender)
      values
        (p_tenant, null, v_total, 'usd', 'succeeded', 'gift_card')
      returning id into v_payment_id;
    else
      -- CASH: operator-attested succeeded, no webhook, no intent id. tender scopes
      -- the exception so verify_money check 1 does not flag the null intent id.
      insert into public.payments
        (tenant_id, customer_id, amount_cents, currency, status, tender)
      values
        (p_tenant, null, v_total, 'usd', 'succeeded', 'cash')
      returning id into v_payment_id;
    end if;

    insert into public.pos_orders
      (tenant_id, actor_user_id, person_id, payment_id, subtotal_cents,
       discount_cents, tax_cents, total_cents, tender, idempotency_key)
    values
      (p_tenant, p_actor, p_person, v_payment_id, v_subtotal,
       coalesce(p_discount_cents, 0), v_tax, v_total, p_tender, p_idempotency_key)
    returning id into v_order_id;

    for v_r in select value from jsonb_array_elements(v_resolved) loop
      insert into public.pos_order_lines
        (tenant_id, order_id, kind, ref_id, qty, unit_price_cents, line_total_cents)
      values
        (p_tenant, v_order_id, v_r ->> 'kind', (v_r ->> 'ref_id')::uuid,
         (v_r ->> 'qty')::int, (v_r ->> 'unit')::int, (v_r ->> 'line_total')::int);
    end loop;
  exception when unique_violation then
    select id, payment_id into v_order_id, v_payment_id
    from public.pos_orders
    where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
    if not found then
      raise exception 'idempotency key already used for a different operation'
        using errcode = '23505';
    end if;
    return jsonb_build_object('payment_id', v_payment_id, 'order_id', v_order_id);
  end;

  -- CASH gift-card lines issue inline (the payment already succeeded); the raw
  -- codes are relayed once. STRIPE issuance is deferred to the inbox on
  -- payment_intent.succeeded (guard on the line's issued_at).
  if p_tender = 'cash' then
    v_codes := app.issue_order_gift_cards(p_tenant, v_order_id);
  end if;

  -- RECEIPT (cash success): a transactional email (consent-exempt,
  -- quiet-hours-exempt — classifyMessageKind maps a non-dunning, non-campaign
  -- row to 'transactional'). Enqueued only when the person has a deliverable
  -- email. Body resolved server-side (comms.send sends body_preview verbatim).
  -- A stripe receipt rides the inbox seam on payment success (not built now).
  if p_tender = 'cash' and p_person is not null then
    select p.email::text, p.first_name, t.name
    into v_email, v_first, v_studio
    from public.people p
    join public.tenants t on t.id = p_tenant
    where p.tenant_id = p_tenant and p.id = p_person;

    if v_email is not null and v_email <> '' then
      v_body := 'Hi ' || coalesce(nullif(v_first, ''), 'there')
        || ', thanks for your purchase at ' || coalesce(v_studio, 'the studio') || '. '
        || jsonb_array_length(v_resolved) || ' item(s), total $'
        || to_char(v_total / 100.0, 'FM999999990.00') || ' (' || p_tender || ').';

      insert into public.comms_log
        (tenant_id, person_id, channel, direction, template_key,
         subject, body_preview, to_address, status)
      values
        (p_tenant, p_person, 'email', 'outbound', 'pos_receipt',
         'Your ' || coalesce(v_studio, 'studio') || ' receipt',
         left(v_body, 200), v_email, 'queued')
      returning id into v_log_id;

      perform app.enqueue_job(
        'comms.send', jsonb_build_object('comms_log_id', v_log_id),
        p_tenant, now(), 100, 5, 'comms.send:' || v_log_id::text
      );
    end if;
  end if;

  v_out := jsonb_build_object('payment_id', v_payment_id, 'order_id', v_order_id);
  if jsonb_array_length(v_codes) > 0 then
    v_out := v_out || jsonb_build_object('gift_card_codes', v_codes);
  end if;
  return v_out;
end;
$$;

comment on function app.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text) is
  'The POS checkout RPC. Resolves every line price from the LIVE catalog (retail_products / gift_card_products / drop_in plan_prices current phase), computes subtotal + server-side tax (tenants.settings->>''tax_rate_bp'') + total in-body — client amounts are never trusted. CASH → a succeeded payment recorded in-body (the documented webhook exception, tender-scoped) + inline gift-card issuance + a receipt. STRIPE → a requires_payment payment + a create_payment_intent outbox command (same key); issuance deferred to the inbox. owner/manager/front_desk; a nonzero discount requires owner/manager. Idempotent on (tenant, idempotency_key). Returns {payment_id, order_id, gift_card_codes?}.';

create or replace function public.pos_checkout(
  p_tenant          uuid,
  p_actor           uuid,
  p_idempotency_key text,
  p_person          uuid,
  p_lines           jsonb,
  p_tender          text,
  p_discount_cents  int default 0,
  p_gift_card_code  text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select app.pos_checkout(
    p_tenant, p_actor, p_idempotency_key, p_person, p_lines, p_tender, p_discount_cents,
    p_gift_card_code
  );
$$;

-- The global 'pos_receipt' template. Only {{first_name}}/{{studio_name}} are
-- valid merge fields (message_templates check). comms.send sends the resolved
-- body_preview; this row is the registry entry + the merge-field allowlist.
insert into public.message_templates
  (id, tenant_id, key, version, channel, kind, subject, body, segment_key)
values
  ('39000000-0000-4000-8000-000000000001', null, 'pos_receipt', 1,
   'email', 'transactional', 'Your {{studio_name}} receipt',
   'Hi {{first_name}}, thanks for your purchase at {{studio_name}}. Your itemized receipt and total are included above.',
   null);

-- RLS -------------------------------------------------------------------------
alter table public.pos_orders enable row level security;
alter table public.pos_order_lines enable row level security;

create policy pos_orders_select on public.pos_orders for select
  using (tenant_id in (select app.current_tenant_ids()));
create policy pos_order_lines_select on public.pos_order_lines for select
  using (tenant_id in (select app.current_tenant_ids()));

-- Exact grants ----------------------------------------------------------------
-- Member-read only; there is NO client or service write path — every write goes
-- through the definer RPCs (which run as the table owner). service_role reads
-- (the inbox joins pos_orders/payments to issue deferred gift cards).
revoke all on public.pos_orders, public.pos_order_lines
  from anon, authenticated, service_role;
grant select on public.pos_orders, public.pos_order_lines to authenticated, service_role;

-- Function grants. pos_checkout/redeem are member-callable (the RPC re-checks
-- role); issue_order_gift_cards is service-role only (the inbox), plus the
-- internal pos_checkout call (definer-owned, so grant-independent).
revoke all on function app.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text) from public;
grant execute on function app.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text)
  to authenticated, service_role;
revoke all on function public.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text) from public;
grant execute on function public.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text)
  to authenticated, service_role;

revoke all on function app.redeem_gift_card(uuid, uuid, text, int, text) from public;
grant execute on function app.redeem_gift_card(uuid, uuid, text, int, text)
  to authenticated, service_role;
revoke all on function public.redeem_gift_card(uuid, uuid, text, int, text) from public;
grant execute on function public.redeem_gift_card(uuid, uuid, text, int, text)
  to authenticated, service_role;

revoke all on function app.issue_order_gift_cards(uuid, uuid) from public;
grant execute on function app.issue_order_gift_cards(uuid, uuid) to service_role;
