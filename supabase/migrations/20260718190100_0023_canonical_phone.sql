-- Phase 3 · unit 1b — one canonical US SMS identity for imported people,
-- inbound STOP processing, and outbound suppression checks.

-- Source-of-truth rule: packages/comms/src/phone.ts (toE164US). Keep these
-- exact three outcomes in sync: 11 digits beginning with 1 => + plus digits;
-- 10 digits => +1 plus digits; every other input => NULL.
create or replace function public.to_e164_us(raw text)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when length(digits.value) = 11 and left(digits.value, 1) = '1'
      then '+' || digits.value
    when length(digits.value) = 10
      then '+1' || digits.value
    else null
  end
  from (
    select regexp_replace(coalesce(raw, ''), '\D', '', 'g') as value
  ) digits;
$$;

comment on function public.to_e164_us(text) is
  'US-only phone canonicalizer shared by people.phone_e164 and SMS suppression matching. Mirrors packages/comms/src/phone.ts toE164US; non-US or otherwise un-normalizable values return NULL.';

alter table public.people
  add column phone_e164 text
  generated always as (public.to_e164_us(phone)) stored;

comment on column public.people.phone_e164 is
  'Canonical US E.164 SMS identity derived from raw provenance in people.phone; NULL means no reliable US SMS identity.';

create index people_tenant_phone_e164_idx
  on public.people (tenant_id, phone_e164)
  where phone_e164 is not null;

comment on column public.comms_suppressions.address is
  'Address-scoped hard block. SMS addresses are canonical US E.164 values sourced from Twilio; email addresses retain their provider form and match case-insensitively.';

revoke all on function public.to_e164_us(text) from public;
grant execute on function public.to_e164_us(text) to authenticated, service_role;
