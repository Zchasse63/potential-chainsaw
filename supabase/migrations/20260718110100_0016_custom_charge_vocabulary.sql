-- Fifth glofox_event value (2026-07-18, the last 3 open quarantines): rare
-- manual/one-off charges surface as `custom_charge` (2 rows in 31 months).
-- Classifier vocabulary widened in the same commit; CHECK follows.
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
    'subscription_payment','invoice_payment','book_class',
    'subscription_payment_failed','custom_charge','unknown'
  ));
