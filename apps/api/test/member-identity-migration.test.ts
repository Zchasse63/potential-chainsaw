import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural guards on the member identity spine (migration 0044, unit 8.2a):
// person_claims, member_otp_challenges + app.consume_member_otp,
// member_sessions, claim_codes, member_verification_events. The live RLS
// attack suite (rls_attack.sql block 36) proves the runtime behavior; these
// keep a drift in the SQL from silently violating an auth invariant
// (hash-only storage, service-role-only verdicts, append-only evidence).

const migration = readFileSync(
  "supabase/migrations/20260719180100_0044_member_identity.sql",
  "utf8",
);
const purgeSrc = readFileSync("workers/src/member/purge.ts", "utf8");
const attackSuite = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create or replace function <name>( … )` body up to its `$$;`. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Slice one `create table public.<name> ( … )` definition, comments stripped. */
function tableBody(sql: string, name: string): string {
  const start = sql.indexOf(`create table public.${name} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(");", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end).replace(/--[^\n]*/g, "");
}

describe("migration 0044 — hash-only storage (raw contact/code/token NEVER stored)", () => {
  it("member_otp_challenges carries contact_hash/code_hash and no raw contact/code column", () => {
    const body = tableBody(migration, "member_otp_challenges");
    expect(body).toContain("contact_hash text not null");
    expect(body).toContain("code_hash    text not null");
    // No column that could hold the raw contact or the raw OTP.
    expect(body).not.toMatch(/\bcontact\b(?!_hash)/);
    expect(body).not.toMatch(/\bcode\b(?!_hash)/);
    expect(body).toContain("attempts     int not null default 0");
    expect(body).toContain("consumed_at  timestamptz");
  });

  it("member_sessions carries token_hash unique and no raw token column", () => {
    const body = tableBody(migration, "member_sessions");
    expect(body).toContain("token_hash     text not null unique");
    expect(body).not.toMatch(/\btoken\b(?!_hash)/);
    expect(body).toContain("expires_at     timestamptz not null");
    expect(body).toContain("absolute_expires_at timestamptz not null");
    expect(body).toContain("rotated_from   uuid");
    expect(body).toContain("platform       text check (platform in ('web', 'ios', 'android'))");
  });

  it("claim_codes + member_verification_events store hashes only", () => {
    const codes = tableBody(migration, "claim_codes");
    expect(codes).toContain("code_hash  text not null");
    expect(codes).not.toMatch(/\bcode\b(?!_hash)/);
    const events = tableBody(migration, "member_verification_events");
    expect(events).toContain("contact_hash text");
    expect(events).toContain("ip_hash      text");
    expect(events).not.toMatch(/\bcontact\b(?!_hash)/);
  });
});

describe("migration 0044 — consume_member_otp (the 0026 record_step_up_attempt shape)", () => {
  const body = fnBody(migration, "create or replace function app.consume_member_otp(");

  it("is SECURITY DEFINER with search_path='' and the service-role-only 42501 guard", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("(select auth.jwt()) ->> 'role', '') <> 'service_role'");
    expect(body).toContain("using errcode = '42501'");
  });

  it("locks the latest live challenge FOR UPDATE, then increments/compares/consumes atomically", () => {
    expect(body).toMatch(/from public\.member_otp_challenges c[\s\S]*and c\.consumed_at is null[\s\S]*for update/);
    // The cap is the lockout: at 5 attempts there is no code comparison.
    expect(body).toContain("if v_chal.attempts >= 5 then");
    // Single consume: success sets consumed_at under the same lock.
    expect(body).toContain("set consumed_at = now()");
    // Verdict only — never the code_hash or the contact.
    expect(body).toContain("returns table (\n  success boolean,\n  remaining_attempts int,\n  locked boolean\n)");
    expect(body).not.toContain("return query select v_chal.code_hash");
  });

  it("audits otp_verified / otp_failed into the append-only events table", () => {
    expect(body).toMatch(/insert into public\.member_verification_events[\s\S]*'otp_verified'/);
    expect(body).toMatch(/insert into public\.member_verification_events[\s\S]*'otp_failed'/);
  });

  it("has a public invoker wrapper, EXECUTE granted to service_role only", () => {
    expect(migration).toContain("create or replace function public.consume_member_otp(");
    expect(migration).toContain(
      "revoke all on function app.consume_member_otp(uuid, text, text, text, text) from public",
    );
    expect(migration).toContain(
      // Must revoke from the ROLES explicitly, not just PUBLIC: Supabase's
      // default privileges auto-grant EXECUTE on new public-schema functions to
      // anon + authenticated, so `from public` alone leaves the wrapper
      // member-callable (the 8.2a live-apply finding).
      "revoke all on function public.consume_member_otp(uuid, text, text, text, text)\n  from public, anon, authenticated",
    );
    expect(migration).toContain(
      "grant execute on function public.consume_member_otp(uuid, text, text, text, text)\n  to service_role",
    );
    expect(migration).not.toMatch(
      /grant execute on function (app|public)\.consume_member_otp[^;]*authenticated/,
    );
  });
});

describe("migration 0044 — RLS + grant posture per table", () => {
  it("enables RLS on every new table", () => {
    for (const t of [
      "person_claims",
      "member_otp_challenges",
      "member_sessions",
      "claim_codes",
      "member_verification_events",
    ]) {
      expect(migration).toContain(`alter table public.${t} enable row level security`);
    }
  });

  it("member_sessions / member_otp_challenges are service-role only (deny-all client policy)", () => {
    for (const t of ["member_otp_challenges", "member_sessions", "member_verification_events"]) {
      expect(migration).toMatch(
        new RegExp(`create policy ${t}_no_client_access on public\\.${t}[\\s\\S]*using \\(false\\) with check \\(false\\)`),
      );
      expect(migration).not.toMatch(new RegExp(`grant select on public\\.${t} to authenticated`));
    }
  });

  it("claim tables get a staff SELECT policy (resolution workspace), writes service-role only", () => {
    expect(migration).toContain("create policy person_claims_staff_select on public.person_claims");
    expect(migration).toContain("create policy claim_codes_staff_select on public.claim_codes");
    expect(migration).toContain("app.has_tenant_role(tenant_id, array['owner', 'manager', 'front_desk'])");
    expect(migration).not.toMatch(/grant (insert|update) on public\.person_claims to authenticated/);
  });

  it("claim_codes + member_verification_events are append-only for every app role", () => {
    expect(migration).toContain(
      "revoke update, delete on public.claim_codes from anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "revoke update, delete on public.member_verification_events from anon, authenticated, service_role",
    );
  });
});

describe("migration 0044 — person_claims partial uniques + composite FKs", () => {
  it("enforces one ACTIVE claim per person and per (tenant, contact)", () => {
    expect(migration).toMatch(
      /create unique index person_claims_one_active_per_person[\s\S]*\(tenant_id, person_id\)[\s\S]*where status = 'active'/,
    );
    expect(migration).toMatch(
      /create unique index person_claims_one_active_per_contact[\s\S]*\(tenant_id, verified_contact\)[\s\S]*where status = 'active'/,
    );
  });

  it("uses the 0026 composite-FK pattern (tenant-consistent person references)", () => {
    expect(migration).toContain(
      "create unique index if not exists people_tenant_id_id_key\n  on public.people (tenant_id, id)",
    );
    expect(migration).toMatch(
      /foreign key \(tenant_id, person_id\)\s+references public\.people \(tenant_id, id\)/,
    );
  });

  it("supports the §3.3 claim states and claim origins", () => {
    expect(migration).toContain(
      "check (status in ('active', 'needs_resolution', 'frozen', 'revoked'))",
    );
    expect(migration).toContain(
      "check (claimed_via in ('self_email', 'self_sms', 'desk_assisted'))",
    );
  });

  it("adds people.claim_frozen (owner freeze → needs_resolution)", () => {
    expect(migration).toContain(
      "add column if not exists claim_frozen boolean not null default false",
    );
  });
});

describe("migration 0044 — jobs kinds on the ONE tick (invariant #4)", () => {
  it("declares member_otp_purge + member_session_purge kind constants, no second scheduler", () => {
    expect(purgeSrc).toContain('MEMBER_OTP_PURGE_KIND = "member_otp_purge"');
    expect(purgeSrc).toContain('MEMBER_SESSION_PURGE_KIND = "member_session_purge"');
    // Registration + fan-out are 8.2b's — the constants file must not smuggle
    // a scheduler of its own.
    expect(purgeSrc).not.toContain("setInterval(");
    expect(purgeSrc).not.toContain("schedule(");
    expect(purgeSrc).not.toContain("node-cron");
  });

  it("ships the guarded purge helpers the future processors call", () => {
    for (const fn of ["purge_member_otp_challenges", "purge_member_sessions"]) {
      const body = fnBody(migration, `create or replace function app.${fn}(`);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(migration).toContain(
        `grant execute on function app.${fn}(timestamptz) to service_role`,
      );
    }
    expect(migration).toContain("where consumed_at is not null or expires_at < p_now");
    expect(migration).toContain("where absolute_expires_at < p_now");
  });
});

describe("rls_attack.sql — member identity coverage (blocks 26 + 36)", () => {
  it("adds both append-only tables to the block 26 grant guard", () => {
    expect(attackSuite).toContain("'member_verification_events', 'claim_codes'");
  });

  it("block 36 proves the cap, single-consume, replay, neutral failure, guard, and uniques", () => {
    expect(attackSuite).toContain("(36)");
    expect(attackSuite).toContain("a 6th try bypassed the 5-attempt cap");
    expect(attackSuite).toContain("a replayed OTP consumed a second time");
    expect(attackSuite).toContain("an unknown contact leaked a distinguishable failure shape");
    expect(attackSuite).toContain("in-body guard accepted a non-service-role JWT");
    expect(attackSuite).toContain("a second ACTIVE claim per person was allowed");
    expect(attackSuite).toContain("a second ACTIVE claim per (tenant, contact) was allowed");
    expect(attackSuite).toContain("tenant A person_claims are visible to tenant B staff");
    expect(attackSuite).toContain("authenticated can SELECT member_sessions");
  });
});
