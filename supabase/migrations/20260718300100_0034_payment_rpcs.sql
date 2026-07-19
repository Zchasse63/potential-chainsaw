-- Phase 5 · unit 4 — the PAYMENT-INTENT + REFUND RPCs: the intent layer that
-- FEEDS the durable outbox. These functions CREATE COMMANDS; they never call
-- Stripe. The outbox processor (unit 5.3) makes the actual adapter call; the
-- signed webhook (unit 5.1 inbox) is the sole confirmation authority.
--
-- Money invariants enforced here (plan-final §5/§6, threat-model §2/§6):
--   * Every intended Stripe mutation is INSERTED into stripe_commands (status
--     'pending') with its idempotency_key BEFORE any API call — the crash-safe
--     spine. These RPCs are that INSERT and nothing more.
--   * The webhook is the authority: create_refund NEVER flips payments.status.
--     A refund resolves to refunded/partially_refunded only when Stripe
--     confirms, through the service-role inbox processor — never optimistically
--     here (invariant #5; no optimistic UI for money).
--   * Idempotent on (tenant_id, idempotency_key) via the outbox unique
--     constraint: a duplicate key returns the EXISTING result and never writes a
--     second command (so a retried money request can never double-charge).
--   * Ledgers/price history stay append-only; a payment is an EVENT, not a
--     mutable balance (invariant #6). We INSERT a payment at requires_payment;
--     its terminal money status is written elsewhere (the webhook).
--   * SECURITY DEFINER + search_path='' + in-body tenancy/role re-check
--     (invariant #7): the definer owns the write, so it bypasses the revoked
--     client INSERT grant on payments/stripe_commands, but re-verifies the
--     caller's tenant role every time. The actor must be the authenticated user;
--     the service role (auth.uid() null) runs unattended with no role check.
--
-- NO live Stripe exists yet (owner/Glofox-gated). Nothing here touches the
-- network — it only writes rows the outbox will later act on.

-- create_payment_intent -------------------------------------------------------
-- Records the INTENT to charge: a payments row (requires_payment) + its linked
-- create_payment_intent command (pending), in ONE transaction, keyed on the
-- caller's idempotency key so request-level and outbox-level idempotency share
-- it. Returns the payment id. front_desk may take a payment (POS); the role gate
-- widens to front_desk here and narrows to owner/manager for refunds.
create or replace function app.create_payment_intent(
  p_tenant          uuid,
  p_customer        uuid,
  p_amount_cents    int,
  p_currency        text,
  p_idempotency_key text,
  p_actor           uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency   text;
  v_command_id uuid;
  v_payment_id uuid;
begin
  -- Actor binding: an interactive caller can only act as itself; the service
  -- role (auth.uid() null) runs unattended (e.g. dunning retries).
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'payment actor must be the authenticated user' using errcode = '42501';
  end if;
  -- Role re-check for an interactive caller (front_desk takes payments at POS).
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager', 'front_desk']) then
    raise exception 'owner, manager, or front_desk role required' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'payment amount must be positive' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  v_currency := lower(coalesce(nullif(trim(p_currency), ''), 'usd'));
  if length(v_currency) <> 3 then
    raise exception 'currency must be a 3-letter ISO code' using errcode = '22023';
  end if;
  -- The customer must exist and belong to THIS tenant (server-side resolution;
  -- the client never asserts cross-tenant ownership).
  if p_customer is null or not exists (
    select 1 from public.customers c where c.tenant_id = p_tenant and c.id = p_customer
  ) then
    raise exception 'customer not found for tenant' using errcode = 'P0002';
  end if;

  -- Idempotent replay (fast path): a create_payment_intent command already
  -- exists for this (tenant, key) → return its existing payment, no new command.
  select p.id into v_payment_id
  from public.stripe_commands sc
  join public.payments p
    on p.tenant_id = sc.tenant_id and p.command_id = sc.id
  where sc.tenant_id = p_tenant
    and sc.idempotency_key = p_idempotency_key
    and sc.kind = 'create_payment_intent';
  if found then
    return v_payment_id;
  end if;

  -- Fresh: the command (BEFORE any adapter call) + the payment event, linked, in
  -- one transaction. A concurrent duplicate loses the unique race and replays.
  begin
    insert into public.stripe_commands
      (tenant_id, kind, idempotency_key, payload, status)
    values
      (p_tenant, 'create_payment_intent', p_idempotency_key,
       jsonb_build_object(
         'amount_cents', p_amount_cents,
         'currency', v_currency,
         'customer_id', p_customer
       ),
       'pending')
    returning id into v_command_id;

    insert into public.payments
      (tenant_id, customer_id, amount_cents, currency, status, command_id)
    values
      (p_tenant, p_customer, p_amount_cents, v_currency, 'requires_payment', v_command_id)
    returning id into v_payment_id;
  exception when unique_violation then
    -- Lost the (tenant_id, idempotency_key) race: return the winner's payment.
    select p.id into v_payment_id
    from public.stripe_commands sc
    join public.payments p
      on p.tenant_id = sc.tenant_id and p.command_id = sc.id
    where sc.tenant_id = p_tenant
      and sc.idempotency_key = p_idempotency_key
      and sc.kind = 'create_payment_intent';
    if not found then
      raise exception 'idempotency key already used for a different operation'
        using errcode = '23505';
    end if;
  end;

  return v_payment_id;
end;
$$;

comment on function app.create_payment_intent(uuid, uuid, int, text, text, uuid) is
  'Records the INTENT to charge: a payments row (requires_payment) + a linked create_payment_intent outbox command (pending), keyed on the caller idempotency key, in one transaction. Owner/manager/front_desk. Does NOT call Stripe (the outbox processor does) and does NOT confirm the charge (the webhook does). Idempotent on (tenant_id, idempotency_key): a duplicate returns the existing payment, never a second command. Returns the payment id.';

create or replace function public.create_payment_intent(
  p_tenant          uuid,
  p_customer        uuid,
  p_amount_cents    int,
  p_currency        text,
  p_idempotency_key text,
  p_actor           uuid
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select app.create_payment_intent(
    p_tenant, p_customer, p_amount_cents, p_currency, p_idempotency_key, p_actor
  );
$$;

-- create_refund ---------------------------------------------------------------
-- Records the INTENT to refund a SUCCEEDED payment: a create_refund command
-- (pending), keyed on the idempotency key. The refund amount may never exceed
-- (original − already-refunded), where already-refunded is the sum of prior
-- create_refund commands for the payment that have not failed (a pending or
-- confirmed refund reserves its slice; a failed one frees it). Owner/manager.
-- NEVER flips payments.status — the webhook/inbox does that on Stripe
-- confirmation. Returns the refund command id.
create or replace function app.create_refund(
  p_tenant          uuid,
  p_payment         uuid,
  p_amount_cents    int,
  p_idempotency_key text,
  p_actor           uuid,
  p_reason          text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status    text;
  v_amount    int;
  v_refunded  int;
  v_remaining int;
  v_command_id uuid;
begin
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor then
    raise exception 'refund actor must be the authenticated user' using errcode = '42501';
  end if;
  -- Refunds are owner/manager only (the step-up gate above the tenant threshold
  -- lives at the API edge, which is where the grant header is available).
  if (select auth.uid()) is not null
     and not app.has_tenant_role(p_tenant, array['owner', 'manager']) then
    raise exception 'owner or manager role required' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'refund amount must be positive' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  -- Idempotent replay (fast path): a create_refund command already exists for
  -- this (tenant, key) → return it, no new command, no re-validation.
  select id into v_command_id
  from public.stripe_commands
  where tenant_id = p_tenant
    and idempotency_key = p_idempotency_key
    and kind = 'create_refund';
  if found then
    return v_command_id;
  end if;

  -- The payment must exist for this tenant and be SUCCEEDED. Only a captured
  -- charge can be refunded; requires_payment/processing/failed cannot.
  select status, amount_cents into v_status, v_amount
  from public.payments
  where tenant_id = p_tenant and id = p_payment;
  if not found then
    raise exception 'payment not found for tenant' using errcode = 'P0002';
  end if;
  if v_status <> 'succeeded' then
    raise exception 'only a succeeded payment can be refunded (status %)', v_status
      using errcode = '22023';
  end if;

  -- Already-refunded = sum of non-failed create_refund commands for this
  -- payment. A pending refund reserves its amount so two partials cannot
  -- collectively exceed the original; a failed one frees it back.
  select coalesce(sum((sc.payload ->> 'amount_cents')::int), 0) into v_refunded
  from public.stripe_commands sc
  where sc.tenant_id = p_tenant
    and sc.kind = 'create_refund'
    and sc.status <> 'failed'
    and (sc.payload ->> 'payment_id') = p_payment::text;

  v_remaining := v_amount - v_refunded;
  if p_amount_cents > v_remaining then
    raise exception 'refund exceeds refundable amount (% remaining of %)',
      v_remaining, v_amount using errcode = '22023';
  end if;

  begin
    insert into public.stripe_commands
      (tenant_id, kind, idempotency_key, payload, status)
    values
      (p_tenant, 'create_refund', p_idempotency_key,
       jsonb_build_object(
         'payment_id', p_payment,
         'amount_cents', p_amount_cents,
         'reason', p_reason
       ),
       'pending')
    returning id into v_command_id;
  exception when unique_violation then
    select id into v_command_id
    from public.stripe_commands
    where tenant_id = p_tenant
      and idempotency_key = p_idempotency_key
      and kind = 'create_refund';
    if not found then
      raise exception 'idempotency key already used for a different operation'
        using errcode = '23505';
    end if;
  end;

  -- Deliberately NO update of public.payments here. The webhook/inbox is the
  -- confirmation authority and flips the payment to refunded/partially_refunded.
  return v_command_id;
end;
$$;

comment on function app.create_refund(uuid, uuid, int, text, uuid, text) is
  'Records the INTENT to refund a SUCCEEDED payment: a create_refund outbox command (pending), keyed on the idempotency key. Owner/manager. Enforces amount <= original minus already-refunded (sum of non-failed refund commands). NEVER flips payments.status — the webhook confirms and the inbox flips it. Idempotent on (tenant_id, idempotency_key). Returns the refund command id.';

create or replace function public.create_refund(
  p_tenant          uuid,
  p_payment         uuid,
  p_amount_cents    int,
  p_idempotency_key text,
  p_actor           uuid,
  p_reason          text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select app.create_refund(
    p_tenant, p_payment, p_amount_cents, p_idempotency_key, p_actor, p_reason
  );
$$;

-- Grants: both the definer (security boundary) and its PostgREST invoker wrapper
-- are callable by authenticated members (RLS/role re-checked in the body) and by
-- the service role (unattended flows).
revoke all on function app.create_payment_intent(uuid, uuid, int, text, text, uuid) from public;
grant execute on function app.create_payment_intent(uuid, uuid, int, text, text, uuid)
  to authenticated, service_role;
revoke all on function public.create_payment_intent(uuid, uuid, int, text, text, uuid) from public;
grant execute on function public.create_payment_intent(uuid, uuid, int, text, text, uuid)
  to authenticated, service_role;

revoke all on function app.create_refund(uuid, uuid, int, text, uuid, text) from public;
grant execute on function app.create_refund(uuid, uuid, int, text, uuid, text)
  to authenticated, service_role;
revoke all on function public.create_refund(uuid, uuid, int, text, uuid, text) from public;
grant execute on function public.create_refund(uuid, uuid, int, text, uuid, text)
  to authenticated, service_role;
