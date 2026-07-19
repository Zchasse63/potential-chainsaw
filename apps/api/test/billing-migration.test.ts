import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Migration-content assertions for the billing core spine (migration 0033).
// These are structural guards on the money schema: append-only price history,
// the deny-all webhook inbox, the tenant-scoped unique keys, and the "webhook
// is the authority / no optimistic client write" grant shape. The live RLS
// attack suite (rls_attack.sql block 27) proves the same at runtime; this keeps
// a drift in the migration text from ever reaching that stage silently.

const migration = readFileSync(
  "supabase/migrations/20260718290100_0033_billing_core.sql",
  "utf8",
);
const attackSuite = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create table public.<name> ( … \n);` block. */
function tableBlock(sql: string, name: string): string {
  const start = sql.indexOf(`create table public.${name} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n);", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 0033 — billing core schema", () => {
  it("keeps prices IMMUTABLE: plans has no price column; plan_prices is append-only except superseded_at", () => {
    // No monetary column lives on plans — prices are phases in plan_prices.
    const plans = tableBlock(migration, "plans");
    expect(plans).not.toContain("_cents");
    expect(plans).not.toContain("amount");
    expect(plans).not.toContain("price_");

    // Append-only at the privilege level for EVERY role, service_role included.
    expect(migration).toContain(
      "revoke update, delete on public.plan_prices from anon, authenticated, service_role",
    );
    // New phases are INSERTed; the ONLY superseded_at writer is a definer fn.
    expect(migration).toContain("grant insert on public.plan_prices to service_role");
    expect(migration).toMatch(/create or replace function app\.supersede_plan_price/);
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/set superseded_at = coalesce\(p_superseded_at, now\(\)\)/);
    // The definer re-verifies tenancy in-body (invariant #7).
    expect(migration).toContain("app.has_tenant_role(p_tenant, array['owner', 'manager'])");
  });

  it("the stripe_events inbox has NO tenant_id and is deny-all to every client role", () => {
    const events = tableBlock(migration, "stripe_events");
    expect(events).not.toContain("tenant_id");
    expect(events).toContain("unique (event_id)");

    expect(migration).toContain(
      "create policy stripe_events_no_client_access on public.stripe_events",
    );
    expect(migration).toContain("for all to authenticated, anon");
    expect(migration).toContain("using (false) with check (false)");
    // Service-role only; no client grant at all.
    expect(migration).toContain(
      "grant select, insert, update on public.stripe_events to service_role",
    );
  });

  it("carries the tenant-scoped unique keys the spine depends on", () => {
    expect(tableBlock(migration, "stripe_accounts")).toContain("unique (tenant_id)");
    expect(tableBlock(migration, "customers")).toContain("unique (tenant_id, person_id)");
    expect(tableBlock(migration, "stripe_commands")).toContain(
      "unique (tenant_id, idempotency_key)",
    );
    expect(tableBlock(migration, "idempotency_keys")).toContain("unique (tenant_id, key)");
    // Composite uniques so downstream FKs stay tenant-consistent (0024/0027 style).
    expect(tableBlock(migration, "plans")).toContain("unique (tenant_id, id)");
    expect(tableBlock(migration, "customers")).toContain("unique (tenant_id, id)");
    expect(tableBlock(migration, "stripe_commands")).toContain("unique (tenant_id, id)");
  });

  it("makes the webhook the payment authority with NO optimistic client write", () => {
    // The service role (webhook processor) flips payment status; members read only.
    expect(migration).toContain("grant select on public.payments to authenticated, service_role");
    expect(migration).toContain("grant insert, update on public.payments to service_role");
    // A member is never granted INSERT/UPDATE on payments — money is not optimistic.
    expect(migration).not.toMatch(/grant[^;]*(insert|update)[^;]*on public\.payments[^;]*authenticated/);
  });

  it("persists request-level idempotency: member-read, service reserve/store/release", () => {
    expect(migration).toContain("create table public.idempotency_keys (");
    expect(migration).toContain("request_hash    text not null");
    expect(migration).toContain("response_status int");
    expect(migration).toContain("response_body   jsonb");
    expect(migration).toContain(
      "grant select on public.idempotency_keys to authenticated, service_role",
    );
    // DELETE is granted (service only) so a failed request releases its reservation.
    expect(migration).toContain(
      "grant insert, update, delete on public.idempotency_keys to service_role",
    );
  });

  it("enables RLS + a member-SELECT policy on every tenant-scoped table (invariant #7)", () => {
    for (const table of [
      "stripe_accounts",
      "plans",
      "plan_prices",
      "customers",
      "stripe_commands",
      "payments",
      "idempotency_keys",
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`create policy ${table}_select on public.${table} for select`);
    }
    expect(migration).toContain("alter table public.stripe_events enable row level security");
  });
});

describe("rls_attack.sql — billing coverage", () => {
  it("adds plan_prices to the append-only grant guard (block 26)", () => {
    expect(attackSuite).toContain("'ask_misses', 'schedule_publish_log', 'plan_prices'");
  });

  it("adds a cross-tenant attack block for the billing tables (block 27)", () => {
    expect(attackSuite).toContain("(27) uB can SELECT tenant A payments");
    expect(attackSuite).toContain("(27) uB could INSERT into payments");
    expect(attackSuite).toContain("(27) uB can read public.stripe_events");
    expect(attackSuite).toContain(
      "(27) service_role holds UPDATE on plan_prices — the definer is the only writer",
    );
    expect(attackSuite).toContain("app.supersede_plan_price(v_b, v_price_b)");
  });
});
