-- Wave 8 · unit 8.2c (incr 2) — member session ROTATION with reuse-detection
-- (plan-member-app §3.2 "rotation + reuse-revocation"). One atomic RPC does the
-- whole decision under a FOR UPDATE lock on the presented session so the
-- reuse-check and the rotate can never race:
--
--   * LIVE session + ACTIVE claim → revoke the old row, mint a new one with
--     rotated_from = old, INHERITING absolute_expires_at (rotation refreshes the
--     rolling 90-day window but NEVER extends the hard 12-month cap), fresh token
--     hash. Outcome 'rotated'.
--   * REVOKED token presented again AND it was already rotated (a child row has
--     rotated_from = its id) → a replay of a rotated (single-use) token = theft.
--     Revoke the ENTIRE rotation family (ancestors + descendants) and report
--     'reuse'. The route still returns the SAME neutral 401 — the family-revoke
--     is a side effect, not a distinguishable response.
--   * REVOKED (logged out, no child) / EXPIRED / needs-resolution / unknown →
--     the matching neutral outcome; the route maps them all to one 401.
--
-- Service-role only (an OTP/session verdict is an auth claim — the 0026/0044
-- guard). Only sha256 token hashes cross this boundary; raw kmb_ tokens live
-- solely in the route layer + the one cookie/response.
-- ===========================================================================

create or replace function app.refresh_member_session(
  p_token_hash     text,
  p_new_token_hash text
)
returns table (
  outcome             text,
  session_id          uuid,
  expires_at          timestamptz,
  absolute_expires_at timestamptz,
  platform            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old       public.member_sessions%rowtype;
  v_claim_ok  boolean;
  v_has_child boolean;
  v_new_id    uuid;
  v_expires   timestamptz;
begin
  -- A session rotation is an authentication event: service client only.
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    raise exception 'member session rotation may only be performed by the API service role'
      using errcode = '42501';
  end if;

  select * into v_old
  from public.member_sessions s
  where s.token_hash = p_token_hash
  for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;

  -- Revoked token replayed: reuse-detection. A child (rotated_from = old.id)
  -- means this token was already spent on a rotation → theft → burn the family.
  if v_old.revoked_at is not null then
    select exists (
      select 1 from public.member_sessions c where c.rotated_from = v_old.id
    ) into v_has_child;
    if v_has_child then
      -- The whole lineage: walk rotated_from up (ancestors) AND down
      -- (descendants) from the compromised node, revoke every live member.
      with recursive fam as (
        select s.id, s.rotated_from
        from public.member_sessions s
        where s.tenant_id = v_old.tenant_id and s.id = v_old.id
        union
        select s.id, s.rotated_from
        from public.member_sessions s
        join fam f on (s.id = f.rotated_from or s.rotated_from = f.id)
        where s.tenant_id = v_old.tenant_id
      )
      update public.member_sessions s
      set revoked_at = now()
      where s.tenant_id = v_old.tenant_id
        and s.id in (select id from fam)
        and s.revoked_at is null;
      return query select 'reuse'::text, null::uuid, null::timestamptz, null::timestamptz, null::text;
      return;
    end if;
    return query select 'revoked'::text, null::uuid, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;

  if v_old.expires_at <= now() or v_old.absolute_expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;

  select exists (
    select 1 from public.person_claims pc
    where pc.tenant_id = v_old.tenant_id
      and pc.person_id = v_old.person_id
      and pc.status = 'active'
  ) into v_claim_ok;
  if not v_claim_ok then
    return query select 'needs_resolution'::text, null::uuid, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;

  -- Rotate: single-use — revoke the presented session, mint its child.
  update public.member_sessions s set revoked_at = now() where s.id = v_old.id;
  v_expires := now() + interval '90 days';
  insert into public.member_sessions
    (tenant_id, person_id, token_hash, expires_at, absolute_expires_at, platform, device_label, rotated_from)
  values
    (v_old.tenant_id, v_old.person_id, p_new_token_hash, v_expires,
     v_old.absolute_expires_at, v_old.platform, v_old.device_label, v_old.id)
  returning id into v_new_id;

  return query select 'rotated'::text, v_new_id, v_expires, v_old.absolute_expires_at, v_old.platform;
end;
$$;

comment on function app.refresh_member_session(text, text) is
  'Atomic single-use member session rotation with reuse-detection (§3.2). Service-role only. Rotation inherits absolute_expires_at (never extends the 12-month cap); replay of a rotated token revokes the whole family. Only sha256 token hashes cross this boundary.';

-- PostgREST wrapper so the API service client can call it via .rpc() (public
-- schema only). Supabase default privileges AUTO-GRANT execute on new
-- public-schema functions to anon+authenticated, so `revoke ... from public`
-- alone is not enough — revoke from the ROLES explicitly (the 8.2a finding);
-- app.refresh_member_session lives outside public and never got the auto-grant.
create or replace function public.refresh_member_session(
  p_token_hash text, p_new_token_hash text
)
returns table (
  outcome text, session_id uuid, expires_at timestamptz, absolute_expires_at timestamptz, platform text
)
language sql security invoker set search_path = ''
as $$ select * from app.refresh_member_session(p_token_hash, p_new_token_hash); $$;

revoke all on function app.refresh_member_session(text, text) from public;
revoke all on function public.refresh_member_session(text, text) from public, anon, authenticated;
grant execute on function app.refresh_member_session(text, text) to service_role;
grant execute on function public.refresh_member_session(text, text) to service_role;
