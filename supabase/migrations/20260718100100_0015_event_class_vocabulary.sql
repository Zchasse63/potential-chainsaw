-- Phase 1.7 backfill discovery (2026-07-18): the full ~31-month history carries
-- a FOURTH glofox_event value the 30-day probe window never showed —
-- `subscription_payment_failed` (failed recurring charges: a pre-cutover
-- dunning signal alongside transaction_status='ERROR'). The classifier
-- vocabulary (contracts primitives) gains it in the same commit; this widens
-- the projection table's CHECK to match. Rows previously quarantined as
-- 'unknown glofox_event' re-import cleanly after the watermark reset.
do $$
declare
  v_constraint text;
begin
  select conname into v_constraint
  from pg_constraint
  where conrelid = 'public.glofox_transactions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%glofox_event_class%';
  if v_constraint is not null then
    execute format('alter table public.glofox_transactions drop constraint %I', v_constraint);
  end if;
end
$$;

alter table public.glofox_transactions
  add constraint glofox_transactions_glofox_event_class_check
  check (glofox_event_class in (
    'subscription_payment',
    'invoice_payment',
    'book_class',
    'subscription_payment_failed',
    'unknown'
  ));
