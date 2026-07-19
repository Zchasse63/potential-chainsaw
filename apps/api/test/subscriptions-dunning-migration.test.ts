import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Migration-content assertions for subscriptions + the dunning ledger (0037).
// Structural guards on the recurring-money schema: the append-only dunning
// ledger, the webhook-synced (no optimistic client) subscription status, the
// one-live-sub partial unique, and the single dunning writer. The live RLS
// attack suite (rls_attack.sql block 29) proves the same at runtime; this keeps
// a migration-text drift from reaching that stage silently.

const migration = readFileSync(
  "supabase/migrations/20260719110100_0037_subscriptions_dunning.sql",
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

describe("migration 0037 — subscriptions + dunning schema", () => {
  it("scopes subscriptions to one live subscription per plan per customer", () => {
    const subs = tableBlock(migration, "subscriptions");
    expect(subs).toContain("unique (tenant_id, id)");
    // Composite FKs keep customer/plan tenant-consistent (0033 style).
    expect(subs).toContain("references public.customers (tenant_id, id)");
    expect(subs).toContain("references public.plans (tenant_id, id)");
    // The partial unique enforces the single live subscription.
    expect(migration).toContain("create unique index subscriptions_one_live_idx");
    expect(migration).toMatch(
      /where status in \('incomplete', 'active', 'past_due', 'paused'\)/,
    );
  });

  it("makes the webhook the subscription-status authority with NO optimistic client write", () => {
    expect(migration).toContain("grant select on public.subscriptions to authenticated, service_role");
    expect(migration).toContain("grant insert, update on public.subscriptions to service_role");
    // A member is never granted INSERT/UPDATE on subscriptions.
    expect(migration).not.toMatch(
      /grant[^;]*(insert|update)[^;]*on public\.subscriptions[^;]*authenticated/,
    );
  });

  it("keeps the dunning ledger APPEND-ONLY for every role including service_role", () => {
    expect(migration).toContain("create table public.dunning_states (");
    // Insert-only for the service role; update/delete revoked from every role.
    expect(migration).toContain("grant insert on public.dunning_states to service_role");
    expect(migration).toContain(
      "revoke update, delete on public.dunning_states from anon, authenticated, service_role",
    );
    // No mutable "current state" — the ledger IS the state (enum check only).
    const ledger = tableBlock(migration, "dunning_states");
    expect(ledger).toContain("stage           text not null");
    expect(ledger).not.toContain("updated_at");
  });

  it("routes every dunning transition through ONE definer writer", () => {
    expect(migration).toMatch(/create or replace function app\.record_dunning_stage/);
    expect(migration).toMatch(/security definer/);
    // Idempotency backstop: a same-stage re-call is a no-op.
    expect(migration).toContain("if v_latest is not distinct from p_stage then");
    // Service-role only — never an interactive client.
    expect(migration).toContain(
      "grant execute on function app.record_dunning_stage(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb)\n  to service_role",
    );
    expect(migration).not.toMatch(
      /grant execute on function app\.record_dunning_stage[^;]*authenticated/,
    );
  });

  it("seeds the global dunning_reminder template as transactional_quiet", () => {
    expect(migration).toContain("'dunning_reminder', 1,");
    expect(migration).toContain("'transactional_quiet'");
  });

  it("exposes the dunning queue read as a SECURITY INVOKER function", () => {
    expect(migration).toMatch(/create or replace function public\.dunning_queue/);
    expect(migration).toContain("security invoker");
    expect(migration).toContain("grant execute on function public.dunning_queue(uuid) to authenticated, service_role");
  });

  it("enables RLS + a member-SELECT policy on both tenant-scoped tables (invariant #7)", () => {
    for (const table of ["subscriptions", "dunning_states"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`create policy ${table}_select on public.${table} for select`);
    }
  });
});

describe("rls_attack.sql — subscriptions/dunning coverage", () => {
  it("adds dunning_states to the append-only grant guard (block 26)", () => {
    expect(attackSuite).toContain("'schedule_publish_log', 'plan_prices', 'dunning_states'");
  });

  it("adds a cross-tenant attack block for subscriptions + dunning (block 29)", () => {
    expect(attackSuite).toContain("(29) uB can SELECT tenant A subscriptions");
    expect(attackSuite).toContain("(29) uB could INSERT into subscriptions");
    expect(attackSuite).toContain("(29) uB could INSERT into dunning_states");
    expect(attackSuite).toContain(
      "(29) service_role holds UPDATE on dunning_states — the ledger is append-only",
    );
    expect(attackSuite).toContain(
      "(29) a second live subscription for the same plan+customer was allowed",
    );
    expect(attackSuite).toContain("app.record_dunning_stage(v_a, v_sub_a, 'past_due'");
  });
});
