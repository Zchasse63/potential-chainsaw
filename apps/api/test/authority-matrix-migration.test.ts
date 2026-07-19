import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural guards on the authority matrix (migration 0042) + its API layer.
// These keep a drift in the SQL, route, or data layer from silently violating an
// append-only / owner-only / tenancy invariant; the live RLS attack suite
// (rls_attack.sql block 34) proves the runtime behavior.

const migration = readFileSync(
  "supabase/migrations/20260719160100_0042_authority_matrix.sql",
  "utf8",
);
const dataAuthority = readFileSync("apps/api/src/data-authority.ts", "utf8");
const routeAuthority = readFileSync("apps/api/src/routes/authority.ts", "utf8");
const appSrc = readFileSync("apps/api/src/app.ts", "utf8");
const attackSuite = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create or replace function <name>( … )` body up to its `$$;`. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const CLOSED_DOMAINS = [
  "people",
  "bookings",
  "schedule",
  "memberships",
  "payments",
  "comms",
  "waivers",
  "retail",
];

describe("migration 0042 — authority_flips (append-only cutover ledger)", () => {
  it("constrains domain to the CLOSED set and authority to glofox|kelo", () => {
    expect(migration).toContain("create table public.authority_flips");
    // The domain check lists exactly the eight closed-set domains.
    const check = migration.slice(migration.indexOf("check (domain in ("));
    for (const d of CLOSED_DOMAINS) {
      expect(check).toContain(`'${d}'`);
    }
    expect(migration).toContain("check (authority in ('glofox', 'kelo'))");
  });

  it("requires a non-empty reason and keys idempotency on (tenant, key)", () => {
    expect(migration).toContain("reason          text not null check (length(trim(reason)) > 0)");
    expect(migration).toContain("evidence_url    text");
    expect(migration).toContain("actor           uuid not null");
    expect(migration).toContain("unique (tenant_id, idempotency_key)");
  });

  it("is APPEND-ONLY: SELECT-only grant, NO insert/update/delete for ANY role", () => {
    // Revoke-all then grant only SELECT (the definer RPC writes as owner).
    expect(migration).toContain(
      "revoke all on public.authority_flips from anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "grant select on public.authority_flips to authenticated, service_role",
    );
    // No write grant of any kind is handed back.
    expect(migration).not.toMatch(/grant\s+insert[\s\S]*authority_flips/i);
    expect(migration).not.toMatch(/grant\s+update[\s\S]*authority_flips/i);
    expect(migration).not.toMatch(/grant\s+delete[\s\S]*authority_flips/i);
  });

  it("enables RLS with a membership-based tenant SELECT policy", () => {
    expect(migration).toContain("alter table public.authority_flips enable row level security");
    expect(migration).toMatch(
      /create policy authority_flips_select on public\.authority_flips for select\s+using \(tenant_id in \(select app\.current_tenant_ids\(\)\)\)/,
    );
  });
});

describe("migration 0042 — current_authority view (default-to-glofox)", () => {
  const body = fnBody(migration, "create or replace view public.current_authority");

  it("is SECURITY INVOKER so RLS scopes it to the caller", () => {
    expect(migration).toContain("with (security_invoker = true)");
    // Sourced from the caller's own tenant set.
    expect(migration).toContain("from app.current_tenant_ids() as t(tenant_id)");
  });

  it("crosses every closed-set domain and DEFAULTS un-flipped domains to glofox", () => {
    expect(body).toContain("cross join unnest(array[");
    for (const d of CLOSED_DOMAINS) {
      expect(body).toContain(`'${d}'`);
    }
    // Absence of a flip ⇒ glofox (no seeding).
    expect(body).toContain("coalesce(f.authority, 'glofox') as authority");
    // The latest flip per (tenant, domain) wins.
    expect(body).toMatch(/order by af\.created_at desc, af\.id desc\s+limit 1/);
  });

  it("the view is member-read only", () => {
    expect(migration).toContain(
      "revoke all on public.current_authority from anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "grant select on public.current_authority to authenticated, service_role",
    );
  });
});

describe("migration 0042 — app.flip_authority (owner-only append-only writer)", () => {
  const body = fnBody(migration, "create or replace function app.flip_authority(");

  it("is SECURITY DEFINER, search_path='', re-verifies actor + OWNER role in-body", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("(select auth.uid()) <> p_actor");
    // OWNER-only — not the owner/manager/front_desk trio the booking RPCs use.
    expect(body).toContain("app.has_tenant_role(p_tenant, array['owner'])");
    expect(body).toContain("owner role required to flip authority");
  });

  it("validates the closed domain/authority sets and a non-empty reason in-body", () => {
    expect(body).toContain("raise exception 'invalid authority domain'");
    expect(body).toContain("raise exception 'invalid authority target'");
    expect(body).toContain("raise exception 'a non-empty reason is required'");
    for (const d of CLOSED_DOMAINS) {
      expect(body).toContain(`'${d}'`);
    }
  });

  it("is idempotent on (tenant, key): a replay returns the existing id, appends nothing", () => {
    expect(body).toContain("where tenant_id = p_tenant and idempotency_key = p_idempotency_key");
    expect(body).toContain("when unique_violation");
    // The idempotency fast-path returns BEFORE the insert + audit write.
    const replayIdx = body.indexOf("if found then\n    return v_flip_id;");
    const insertIdx = body.indexOf("insert into public.authority_flips");
    expect(replayIdx).toBeGreaterThanOrEqual(0);
    expect(replayIdx).toBeLessThan(insertIdx);
  });

  it("appends the flip AND an audit_events row (evidence trail)", () => {
    expect(body).toContain("insert into public.authority_flips");
    expect(body).toMatch(/insert into public\.audit_events[\s\S]*'authority\.flipped'/);
    // NEVER an in-place mutation of the ledger.
    expect(body).not.toMatch(/update\s+public\.authority_flips/);
    expect(body).not.toMatch(/delete\s+from\s+public\.authority_flips/);
  });

  it("ships a public invoker wrapper with the six-arg core as a stable prefix", () => {
    expect(migration).toContain("create or replace function public.flip_authority(");
    expect(migration).toContain("p_evidence_url    text default null");
    expect(migration).toContain(
      "revoke all on function public.flip_authority(uuid, text, text, text, uuid, text, text) from public",
    );
    expect(migration).toContain(
      "grant execute on function public.flip_authority(uuid, text, text, text, uuid, text, text)",
    );
  });
});

describe("API layer — data-authority.ts (RPC-only writes, typed error mapping)", () => {
  it("has no direct table writes and maps the SQLSTATEs", () => {
    expect(dataAuthority).not.toContain(".insert(");
    expect(dataAuthority).not.toContain(".update(");
    expect(dataAuthority).not.toContain(".delete(");
    expect(dataAuthority).toContain('"flip_authority"');
    expect(dataAuthority).toContain('.from("current_authority")');
    expect(dataAuthority).toContain("authority_forbidden");
    expect(dataAuthority).toContain("authority_invalid");
  });

  it("exports the closed domain set used by the route's Zod enum", () => {
    for (const d of CLOSED_DOMAINS) {
      expect(dataAuthority).toContain(`"${d}"`);
    }
  });
});

describe("API layer — routes/authority.ts (owner-only + step-up + idempotency)", () => {
  it("GET is owner/manager read; POST /flip is owner-only + step-up + idempotency", () => {
    expect(routeAuthority).toContain('requireRole("owner", "manager")');
    expect(routeAuthority).toContain('requireRole("owner")');
    expect(routeAuthority).toContain("requireIdempotencyKey");
    expect(routeAuthority).toContain("validateStepUpGrant");
    expect(routeAuthority).toContain('AUTHORITY_FLIP_STEP_UP_CONTEXT = "authority_flip"');
    expect(routeAuthority).toContain("step_up_required");
    // The client key threads into the RPC.
    expect(routeAuthority).toContain("idempotencyKey: idempotencyKeyOf(c)");
  });

  it("is mounted in the app", () => {
    expect(appSrc).toContain("registerAuthorityRoutes(app, resolved, deps.env)");
  });
});

describe("rls_attack.sql — authority coverage (block 34 + block 26)", () => {
  it("lists authority_flips in the block-26 append-only grant guard", () => {
    const block26 = attackSuite.slice(attackSuite.indexOf("(26) APPEND-ONLY GRANT GUARD"));
    expect(block26.slice(0, block26.indexOf("end\n$$;"))).toContain("'authority_flips'");
  });

  it("adds block 34 covering read/flip refusals, append-only, and idempotent replay", () => {
    expect(attackSuite).toContain("(34) AUTHORITY MATRIX");
    expect(attackSuite).toContain("app.flip_authority");
    expect(attackSuite).toContain("(34) uB can SELECT tenant A authority_flips");
    expect(attackSuite).toContain("(34) a manager could flip authority");
    expect(attackSuite).toContain("(34) a front_desk could flip authority");
    expect(attackSuite).toContain("(34) uA (owner of A) could flip tenant B authority");
    expect(attackSuite).toContain("(34) uB could UPDATE authority_flips");
    expect(attackSuite).toContain("(34) an unknown domain was accepted");
    expect(attackSuite).toContain("(34) an empty reason was accepted");
    expect(attackSuite).toContain("(34) an idempotent replay appended a second flip row");
    expect(attackSuite).toContain("(34) an un-flipped domain did not default to glofox");
  });
});
