-- 0029 — tighten public.to_e164_us with NANP structural validation.
--
-- Live backfill (2026-07-18) revealed structurally-invalid placeholders being
-- accepted as canonical E.164: +10000000000 was shared by 36 people (a Glofox
-- all-zeros junk entry). Under NANP a valid US national number is NXX-NXX-XXXX
-- where the area code (NPA, digit 1) and central-office/exchange code (NXX,
-- digit 4) both start [2-9]. Numbers with 0/1-leading area or exchange codes are
-- not dialable and must never be treated as a real SMS identity (they would be
-- a false send target or an over-broad STOP suppression key).
--
-- This CREATE OR REPLACE keeps the function's signature/immutability so the
-- STORED generated column people.phone_e164 continues to depend on it; the
-- forced no-op UPDATE at the end recomputes the 1,366 existing rows under the
-- stricter rule. Mirror of packages/comms/src/phone.ts toE164US — the two MUST
-- stay in exact lockstep (same three length cases + the same NANP guard).
create or replace function public.to_e164_us(raw text)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when national.n is null then null
    -- NANP: area code (NPA) and exchange (NXX) must start [2-9].
    when substr(national.n, 1, 1) not between '2' and '9' then null
    when substr(national.n, 4, 1) not between '2' and '9' then null
    else '+1' || national.n
  end
  from (
    select case
      when length(digits.value) = 11 and left(digits.value, 1) = '1' then right(digits.value, 10)
      when length(digits.value) = 10 then digits.value
      else null
    end as n
    from (
      select regexp_replace(coalesce(raw, ''), '\D', '', 'g') as value
    ) digits
  ) national;
$$;

comment on function public.to_e164_us(text) is
  'US-only phone canonicalizer with NANP structural validation (NPA + NXX must start [2-9]) shared by people.phone_e164 and SMS suppression matching. Mirrors packages/comms/src/phone.ts toE164US; non-US, structurally-invalid, or otherwise un-normalizable values return NULL.';

-- Recompute the STORED generated column under the new rule. Assigning phone to
-- itself puts it in the UPDATE targetlist, which forces phone_e164 to
-- regenerate; junk placeholders (e.g. the 36 +10000000000 rows) become NULL.
update public.people set phone = phone where phone is not null;
