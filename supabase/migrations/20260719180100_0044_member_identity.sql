-- Wave 8 · unit 8.2a — member identity spine (plan-member-app §3.2/§3.3/§10,
-- "W8-2 — member identity migration"), mirroring the 0026 step-up auth pattern.
--
-- Security posture:
--   * Raw contacts, OTP codes, and session tokens are NEVER stored — only
--     sha256 hashes (contact_hash / code_hash / token_hash). The API hashes
--     before the write; no column here can hold a raw value.
--   * member_sessions and member_otp_challenges are service-role-only tables.
--     Token hashes and code hashes must never be member-readable, so there is
--     deliberately NO authenticated SELECT policy — the API's service client
--     (which bypasses RLS) is the sole reader. The explicit deny-all policy
--     documents intent and satisfies the attack suite's generic guard (every
--     tenant_id table needs RLS enabled AND at least one policy).
--   * person_claims / claim_codes carry a staff SELECT policy
--     (app.has_tenant_role owner/manager/front_desk) for the claim-resolution
--     workspace (§10); all writes are service-client / definer-RPC only.
--   * app.consume_member_otp is the ONLY OTP verdict path: SECURITY DEFINER,
--     service-role-guarded in-body, one FOR UPDATE row lock making the
--     5-attempt cap race-free (the record_step_up_attempt shape from 0026).
--   * claim_codes and member_verification_events are APPEND-ONLY for every
--     application role (the 0026 step_up_events revoke pattern).

-- Composite-FK support: a service insert cannot pair tenant A with a people
-- row belonging to tenant B (the 0026 tenant_users pattern).
create unique index if not exists people_tenant_id_id_key
  on public.people (tenant_id, id);

-- Owner kill-switch for claiming (§3.6 desk path): a frozen person routes
-- every claim to needs_resolution instead of active.
alter table public.people
  add column if not exists claim_frozen boolean not null default false;

comment on column public.people.claim_frozen is
  'Owner-set freeze on identity claiming for this person (plan-member-app §3.6); while true, every claim attempt routes to the staff resolution workspace.';

-- ---------------------------------------------------------------------------
-- person_claims — the verified contact → person binding. Person identity is
-- resolved server-side from this table per request (§3.2), never from
-- anything the client sends.
-- ---------------------------------------------------------------------------
create table public.person_claims (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  person_id      uuid not null,
  verified_contact citext not null,
  channel        text not null check (channel in ('email', 'sms')),
  status         text not null default 'active'
                 check (status in ('active', 'needs_resolution', 'frozen', 'revoked')),
  claimed_via    text not null
                 check (claimed_via in ('self_email', 'self_sms', 'desk_assisted')),
  -- The desk operator who assisted a claim; bare composite FK (no delete
  -- action) — audit attribution must not vanish or cascade with staff changes.
  desk_actor_tenant_user_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, person_id)
    references public.people (tenant_id, id) on delete cascade,
  foreign key (tenant_id, desk_actor_tenant_user_id)
    references public.tenant_users (tenant_id, id)
);

-- One ACTIVE claim per person AND one active claim per (tenant, contact).
-- needs_resolution / frozen / revoked rows never collide — only 'active' is
-- exclusive, which is what makes a second claim attempt routable to the
-- resolution workspace instead of a hard error.
create unique index person_claims_one_active_per_person
  on public.person_claims (tenant_id, person_id)
  where status = 'active';

create unique index person_claims_one_active_per_contact
  on public.person_claims (tenant_id, verified_contact)
  where status = 'active';

create index person_claims_tenant_status_idx
  on public.person_claims (tenant_id, status);

create or replace trigger person_claims_touch_updated_at
  before update on public.person_claims
  for each row execute function app.touch_updated_at();

comment on table public.person_claims is
  'Verified contact → person binding; the sole server-side source of member identity (§3.2). Status transitions are written by the API service client / definer RPCs only — never by a member directly.';

-- ---------------------------------------------------------------------------
-- member_otp_challenges — one-time codes for verify + step-up. The RAW
-- contact and RAW code are never stored: only their sha256 hashes.
-- ---------------------------------------------------------------------------
create table public.member_otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  contact_hash text not null,  -- sha256 of the normalized contact
  channel      text not null check (channel in ('email', 'sms')),
  code_hash    text not null,  -- sha256 of the OTP
  expires_at   timestamptz not null,  -- API sets now() + 10 minutes
  attempts     int not null default 0 check (attempts >= 0),
  consumed_at  timestamptz,
  ip_hash      text,
  created_at   timestamptz not null default now()
);

comment on table public.member_otp_challenges is
  'OTP challenges keyed by contact/code HASHES only (raw values never persisted). Written by the service client; attempts/consumed_at advance ONLY through app.consume_member_otp. Purged by app.purge_member_otp_challenges.';

-- Lookup path of consume_member_otp: the latest live (unconsumed) challenge
-- for (tenant, contact, channel). expires_at cannot join the partial
-- predicate (now() is not immutable); the expiry filter applies at query time.
create index member_otp_challenges_live_idx
  on public.member_otp_challenges (tenant_id, contact_hash, channel, created_at desc)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- member_sessions — opaque-token sessions (§3.2). token_hash is sha256 of the
-- `kmb_…` bearer; the RAW token is never stored.
-- ---------------------------------------------------------------------------
create table public.member_sessions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  person_id      uuid not null,
  token_hash     text not null unique,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz not null,  -- rolling 90 days, slid on activity
  absolute_expires_at timestamptz not null,  -- hard 12-month cap
  revoked_at     timestamptz,
  -- Reuse-detection lineage: the session this one was rotated from. Bare uuid
  -- (deliberately no self-FK) so the purge can delete an expired ancestor
  -- without rewriting its successors.
  rotated_from   uuid,
  step_up_at     timestamptz,
  device_label   text,
  platform       text check (platform in ('web', 'ios', 'android')),
  foreign key (tenant_id, person_id)
    references public.people (tenant_id, id) on delete cascade
);

create index member_sessions_tenant_person_idx
  on public.member_sessions (tenant_id, person_id);

comment on table public.member_sessions is
  'Member sessions keyed by token HASH (raw kmb_ tokens never persisted). NO authenticated SELECT policy by design — token hashes must never be member-readable; the API service client is the sole reader/writer (§3.2). Purged by app.purge_member_sessions.';

-- ---------------------------------------------------------------------------
-- claim_codes — desk-assisted claim codes (§3.6). Single-use, 15-minute TTL.
-- ---------------------------------------------------------------------------
create table public.claim_codes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  person_id  uuid not null,
  code_hash  text not null,  -- sha256 of the desk-minted code; raw never stored
  created_by uuid not null,  -- the desk tenant_user who minted it
  expires_at timestamptz not null,  -- mint time + 15 minutes
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, person_id)
    references public.people (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by)
    references public.tenant_users (tenant_id, id)
);

comment on table public.claim_codes is
  'Desk-minted single-use claim codes (hash only). APPEND-ONLY for every application role: single-use is modeled by letting the 8.2b consume RPC — SECURITY DEFINER, executing as the function OWNER, which the revokes do not constrain — set used_at exactly once, the same mechanism that lets 0026 definers append to step_up_events. No client-assumable role can silently alter or delete a code.';

-- ---------------------------------------------------------------------------
-- member_verification_events — APPEND-ONLY audit, the 0026 step_up_events
-- pattern (member edition). Hashes only; no raw contact, code, or IP.
-- ---------------------------------------------------------------------------
create table public.member_verification_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  kind         text not null
               check (kind in ('otp_sent', 'otp_verified', 'otp_failed',
                               'claim_attempt', 'claim_conflict', 'claim_resolved',
                               'step_up', 'contact_changed', 'card_updated',
                               'session_revoked')),
  contact_hash text,
  ip_hash      text,
  -- Bare uuid, deliberately NO foreign key: audit evidence must survive a
  -- data-rights person deletion (0025).
  person_id    uuid,
  created_at   timestamptz not null default now()
);

create index member_verification_events_tenant_created_idx
  on public.member_verification_events (tenant_id, created_at desc);

comment on table public.member_verification_events is
  'Append-only member auth/claim audit (the member edition of step_up_events). contact/ip are sha256 hashes only; UPDATE/DELETE are revoked from every application role.';

-- ---------------------------------------------------------------------------
-- app.consume_member_otp — the ONLY OTP verdict path.
-- Atomic shape mirrors 0026 record_step_up_attempt: one FOR UPDATE row lock
-- serializes concurrent verifies, so the increment + compare + consume are a
-- single race-free statement-path and a concurrent 6th try cannot bypass the
-- 5-attempt cap. NEVER returns the code_hash or the contact.
-- ---------------------------------------------------------------------------
create or replace function app.consume_member_otp(
  p_tenant uuid,
  p_contact_hash text,
  p_channel text,
  p_code_hash text,
  p_ip_hash text
)
returns table (
  success boolean,
  remaining_attempts int,
  locked boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chal public.member_otp_challenges%rowtype;
begin
  -- An OTP verdict is an authentication claim: only the API's service client
  -- may submit one (the 0026 record_step_up_attempt guard).
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    raise exception 'member OTP outcomes may only be submitted by the API service role'
      using errcode = '42501';
  end if;

  -- Latest live challenge for this contact, locked FOR UPDATE.
  select c.* into v_chal
  from public.member_otp_challenges c
  where c.tenant_id = p_tenant
    and c.contact_hash = p_contact_hash
    and c.channel = p_channel
    and c.consumed_at is null
  order by c.created_at desc
  limit 1
  for update;

  -- Neutral failure: an unknown contact and an expired challenge are
  -- indistinguishable (anti-enumeration) and neither burns an attempt.
  if not found then
    return query select false, 0, false;
    return;
  end if;
  if v_chal.expires_at <= now() then
    return query select false, 0, false;
    return;
  end if;

  -- The cap IS the lockout: after 5 failures no code comparison happens at
  -- all — not even for the correct code.
  if v_chal.attempts >= 5 then
    return query select false, 0, true;
    return;
  end if;

  if p_code_hash = v_chal.code_hash then
    update public.member_otp_challenges
    set consumed_at = now()
    where id = v_chal.id;
    insert into public.member_verification_events (tenant_id, kind, contact_hash, ip_hash)
    values (p_tenant, 'otp_verified', p_contact_hash, p_ip_hash);
    return query select true, 0, false;
    return;
  end if;

  v_chal.attempts := v_chal.attempts + 1;
  update public.member_otp_challenges
  set attempts = v_chal.attempts
  where id = v_chal.id;

  insert into public.member_verification_events (tenant_id, kind, contact_hash, ip_hash)
  values (p_tenant, 'otp_failed', p_contact_hash, p_ip_hash);

  return query select false, greatest(0, 5 - v_chal.attempts), v_chal.attempts >= 5;
end;
$$;

comment on function app.consume_member_otp(uuid, text, text, text, text) is
  'Atomically consumes a member OTP: service-role only, FOR UPDATE-locked attempt increment + 5-attempt cap + single consume. Unknown/expired contacts return one neutral failure shape (anti-enumeration); hashes in, verdict out — never the code or contact.';

-- PostgREST exposes public, not app. The invoker wrapper retains app.* as the
-- security boundary while making the RPC callable by the API service client.
create or replace function public.consume_member_otp(
  p_tenant uuid,
  p_contact_hash text,
  p_channel text,
  p_code_hash text,
  p_ip_hash text
)
returns table (
  success boolean,
  remaining_attempts int,
  locked boolean
)
language sql security invoker set search_path = ''
as $$ select * from app.consume_member_otp(p_tenant, p_contact_hash, p_channel, p_code_hash, p_ip_hash); $$;

-- ---------------------------------------------------------------------------
-- Purge helpers for the two new jobs kinds (drained by the ONE tick —
-- invariant #4, no new scheduler):
--   member_otp_purge     → app.purge_member_otp_challenges(now())
--   member_session_purge → app.purge_member_sessions(now())
-- The kind constants are declared in workers/src/member/purge.ts; the
-- processors.ts registration + cadenced fan-out land with unit 8.2b.
-- Grant-only service-role gating (the 0040 app.expire_holds pattern): the
-- tick's direct pg connection carries no JWT, so an auth.jwt() guard here
-- would reject the legitimate caller; EXECUTE is granted to service_role only.
-- ---------------------------------------------------------------------------
create or replace function app.purge_member_otp_challenges(p_now timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from public.member_otp_challenges
  where consumed_at is not null or expires_at < p_now;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function app.purge_member_otp_challenges(timestamptz) is
  'The member_otp_purge drain: deletes every consumed or expired OTP challenge across tenants. p_now is injected (the tick passes now()). Returns the deleted count.';

create or replace function app.purge_member_sessions(p_now timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from public.member_sessions
  where absolute_expires_at < p_now;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function app.purge_member_sessions(timestamptz) is
  'The member_session_purge drain: deletes every session past its 12-month absolute cap across tenants (rolling-expired sessions are refused at resolve time, not purged here). p_now is injected. Returns the deleted count.';

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
alter table public.person_claims enable row level security;
alter table public.member_otp_challenges enable row level security;
alter table public.member_sessions enable row level security;
alter table public.claim_codes enable row level security;
alter table public.member_verification_events enable row level security;

-- Staff read for the claim-resolution workspace (§10); members never read
-- claims directly — the API resolves identity server-side.
drop policy if exists person_claims_staff_select on public.person_claims;
create policy person_claims_staff_select on public.person_claims
  for select
  using (app.has_tenant_role(tenant_id, array['owner', 'manager', 'front_desk']));

drop policy if exists claim_codes_staff_select on public.claim_codes;
create policy claim_codes_staff_select on public.claim_codes
  for select
  using (app.has_tenant_role(tenant_id, array['owner', 'manager', 'front_desk']));

-- Service-role ONLY tables (the 0005 jobs pattern): explicit deny-all for
-- client roles documents intent and satisfies the attack suite's generic
-- guard; the service role bypasses RLS regardless.
drop policy if exists member_otp_challenges_no_client_access on public.member_otp_challenges;
create policy member_otp_challenges_no_client_access on public.member_otp_challenges
  for all to authenticated, anon
  using (false) with check (false);

drop policy if exists member_sessions_no_client_access on public.member_sessions;
create policy member_sessions_no_client_access on public.member_sessions
  for all to authenticated, anon
  using (false) with check (false);

drop policy if exists member_verification_events_no_client_access on public.member_verification_events;
create policy member_verification_events_no_client_access on public.member_verification_events
  for all to authenticated, anon
  using (false) with check (false);

-- person_claims: staff read via the policy above; status transitions are
-- service-client / definer-RPC writes only — no direct authenticated write.
revoke all on public.person_claims from anon, authenticated, service_role;
grant select on public.person_claims to authenticated, service_role;
grant insert, update on public.person_claims to service_role;

-- member_otp_challenges: service-role only. No UPDATE/DELETE grant to any
-- application role — attempts/consumed_at advance ONLY through
-- app.consume_member_otp; rows leave ONLY through app.purge_member_otp_challenges.
revoke all on public.member_otp_challenges from anon, authenticated, service_role;
grant select, insert on public.member_otp_challenges to service_role;

-- member_sessions: service-role only; token hashes never member-readable.
revoke all on public.member_sessions from anon, authenticated, service_role;
grant select, insert, update on public.member_sessions to service_role;

-- claim_codes: APPEND-ONLY (see the table comment for the single-use model).
revoke all on public.claim_codes from anon, authenticated, service_role;
grant select on public.claim_codes to authenticated, service_role;
grant insert on public.claim_codes to service_role;
revoke update, delete on public.claim_codes from anon, authenticated, service_role;

-- member_verification_events: evidence is append-only even for the service
-- role (the 0026 step_up_events pattern).
revoke all on public.member_verification_events from anon, authenticated, service_role;
grant select, insert on public.member_verification_events to service_role;
revoke update, delete on public.member_verification_events from anon, authenticated, service_role;

revoke all on function app.consume_member_otp(uuid, text, text, text, text) from public;
revoke all on function public.consume_member_otp(uuid, text, text, text, text) from public;
grant execute on function app.consume_member_otp(uuid, text, text, text, text)
  to service_role;
grant execute on function public.consume_member_otp(uuid, text, text, text, text)
  to service_role;

revoke all on function app.purge_member_otp_challenges(timestamptz) from public;
grant execute on function app.purge_member_otp_challenges(timestamptz) to service_role;
revoke all on function app.purge_member_sessions(timestamptz) from public;
grant execute on function app.purge_member_sessions(timestamptz) to service_role;
