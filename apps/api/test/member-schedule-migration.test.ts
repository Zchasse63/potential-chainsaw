import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Unit 8.1c — structural guards on the anonymous member-schedule migration
 * (0043), its API mount, and its attack-suite block. The live behavior
 * (drafts invisible, cross-tenant scoping, the exact allowlist) is proven at
 * runtime by rls_attack.sql block 35; these guards keep the SQL and the route
 * from silently drifting off the unit's contract.
 */

const migration = readFileSync(
  "supabase/migrations/20260719170100_0043_member_schedule.sql",
  "utf8",
);
const appTs = readFileSync("apps/api/src/app.ts", "utf8");
const route = readFileSync("apps/api/src/routes/member.ts", "utf8");
const attack = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create or replace function <signature> … $$;` body. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const ALLOWLIST = [
  "session_id",
  "offering_name",
  "starts_at",
  "ends_at",
  "capacity",
  "available",
  "readiness_ok",
  "credit_cost",
];

describe("0043 member_schedule — the anonymous public surface", () => {
  it("defines public.member_schedule exactly once: SECURITY DEFINER, stable, locked search_path", () => {
    const occurrences = migration.split("create or replace function public.member_schedule(").length - 1;
    expect(occurrences).toBe(1);
    const body = fnBody(migration, "create or replace function public.member_schedule(");
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/stable/i);
    expect(body).toContain("set search_path = ''");
    expect(body).toMatch(/\(\s*p_tenant uuid,\s*p_from\s+timestamptz,\s*p_to\s+timestamptz\s*\)/);
  });

  it("returns EXACTLY the 8-column public allowlist, in contract order", () => {
    const body = fnBody(migration, "create or replace function public.member_schedule(");
    const match = /returns table \(([^)]*)\)/i.exec(body);
    expect(match, "member_schedule must declare its returns table").not.toBeNull();
    const columns = match![1]!
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0]);
    expect(columns).toEqual(ALLOWLIST);
  });

  it("hard-filters published sessions and reuses 0040's availability math", () => {
    const body = fnBody(migration, "create or replace function public.member_schedule(");
    expect(body).toContain("s.status = 'published'");
    expect(body).toContain("s.tenant_id = p_tenant");
    // The same booked+held aggregate math as public.session_availability (0040).
    expect(body).toContain("status in ('booked', 'checked_in')");
    expect(body).toContain("frozen or expires_at > now()");
    expect(body).toMatch(/greatest\(/);
    // ends_at derives from the offering duration; the fixed v1 cost model.
    expect(body).toContain("duration_minutes");
    expect(body).toContain("1 as credit_cost");
  });

  it("NEVER selects a person/attendee identifier — the return shape is the boundary", () => {
    const body = fnBody(migration, "create or replace function public.member_schedule(");
    expect(body).not.toMatch(/person|attendee|first_name|last_name|email|phone/i);
  });

  it("grants EXECUTE to anon (the intended public surface) after revoking PUBLIC", () => {
    expect(migration).toContain(
      "revoke all on function public.member_schedule(uuid, timestamptz, timestamptz) from public;",
    );
    expect(migration).toContain(
      "grant execute on function public.member_schedule(uuid, timestamptz, timestamptz) to anon, authenticated, service_role;",
    );
  });

  it("creates NO table and touches NO existing RLS policy (invariant #9)", () => {
    expect(migration).not.toMatch(/create table/i);
    expect(migration).not.toMatch(/create policy|alter policy|drop policy/i);
  });
});

describe("API wiring — anonymous mount outside the operator auth chain", () => {
  it("mounts the member group next to webhooks with no requireAuth/resolveTenant", () => {
    expect(appTs).toContain("registerMemberRoutes(app, deps)");
    expect(route).toContain('app.get("/member/schedule"');
    expect(route).not.toContain("requireAuth");
    expect(route).not.toContain("resolveTenant");
  });

  it("calls the RPC through the injectable client with the three pinned params + envelope", () => {
    expect(route).toContain('"member_schedule"');
    expect(route).toContain("p_tenant");
    expect(route).toContain("p_from");
    expect(route).toContain("p_to");
    expect(route).toContain('definitionVersion: "member-schedule:v1"');
  });
});

describe("attack suite block (35)", () => {
  it("exercises the anonymous schedule surface cross-tenant", () => {
    expect(attack).toContain("(35)");
    expect(attack).toContain("public.member_schedule(");
    expect(attack).toContain("has_function_privilege('anon'");
  });
});
