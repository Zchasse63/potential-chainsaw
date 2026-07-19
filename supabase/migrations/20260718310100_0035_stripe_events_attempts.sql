-- 0035 — stripe_events retry counter, for the inbox dead-letter fix.
--
-- Review finding (5.3): an inbox event that referenced a payment not yet linked
-- by the outbox (a transient, self-healing condition) was marked status='error'
-- TERMINALLY and never reprocessed — stranding a captured payment in a
-- non-terminal state with no operator signal. The fix makes inbox failures
-- RETRYABLE up to a bound (the event stays 'received' and a later drain retries
-- once the outbox has linked the payment), then DEAD-LETTERS to 'error' with a
-- critical alert. This column tracks the attempt count that bounds the retry.
alter table public.stripe_events
  add column if not exists attempts int not null default 0;
