import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural guards on the payment-intent + refund RPCs (migration 0034) and the
// money-route/data source. These keep a drift in the SQL or the API layer from
// silently violating a money invariant; the live RLS attack suite
// (rls_attack.sql block 28) proves the tenancy/idempotency behavior at runtime.

const migration = readFileSync(
  "supabase/migrations/20260718300100_0034_payment_rpcs.sql",
  "utf8",
);
const dataPayments = readFileSync("apps/api/src/data-payments.ts", "utf8");
const routePayments = readFileSync("apps/api/src/routes/payments.ts", "utf8");
const attackSuite = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create or replace function <name>( … )` body up to its `$$;`. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 0034 — payment-intent + refund RPCs", () => {
  it("both RPCs are SECURITY DEFINER, search_path='', and re-check tenancy in-body (invariant #7)", () => {
    for (const sig of [
      "create or replace function app.create_payment_intent(",
      "create or replace function app.create_refund(",
    ]) {
      const body = fnBody(migration, sig);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      // Actor binding + role re-check against the caller's membership.
      expect(body).toContain("(select auth.uid()) <> p_actor");
      expect(body).toContain("app.has_tenant_role(p_tenant");
    }
  });

  it("create_payment_intent writes the outbox command BEFORE the payment, both pending/requires_payment", () => {
    const body = fnBody(migration, "create or replace function app.create_payment_intent(");
    // A command is inserted (status pending) and a payment at requires_payment —
    // never a terminal money status at creation time.
    expect(body).toContain("insert into public.stripe_commands");
    expect(body).toContain("'create_payment_intent'");
    expect(body).toContain("'requires_payment'");
    expect(body).toContain("insert into public.payments");
    // Payment-taking role widens to front_desk (POS).
    expect(body).toContain("array['owner', 'manager', 'front_desk']");
    // Idempotent on the outbox unique key: a duplicate replays, never doubles.
    expect(body).toContain("when unique_violation");
  });

  it("create_refund NEVER flips the payment status — the webhook is the authority", () => {
    const body = fnBody(migration, "create or replace function app.create_refund(");
    // It writes only a refund command; it must not mutate public.payments.
    expect(body).toContain("insert into public.stripe_commands");
    expect(body).toContain("'create_refund'");
    // Refunds are owner/manager only (no front_desk).
    expect(body).toContain("array['owner', 'manager']");
    expect(body).not.toContain("array['owner', 'manager', 'front_desk']");
    // The succeeded precondition + refundable ceiling.
    expect(body).toContain("only a succeeded payment can be refunded");
    expect(body).toContain("refund exceeds refundable amount");
    // The invariant, proven at the text level: no payment status write anywhere
    // in the refund RPC (the webhook/inbox flips it).
    expect(body).not.toMatch(/update\s+public\.payments/);
  });

  it("NO RPC anywhere in the migration flips a payment to a terminal money status", () => {
    // There is NO update of public.payments anywhere — terminal money statuses
    // (succeeded/refunded/partially_refunded) are written by the webhook/inbox
    // (unit 5.1), never by these intent RPCs.
    expect(migration).not.toMatch(/update\s+public\.payments/);
    // The one and only payment write is a requires_payment INSERT.
    expect(migration.match(/insert into public\.payments/g)).toHaveLength(1);
    const payInsert = migration.slice(migration.indexOf("insert into public.payments"));
    expect(payInsert.slice(0, 200)).toContain("'requires_payment'");
    // 'succeeded' appears ONLY as the refund precondition read, never as a write.
    expect(migration).toContain("v_status <> 'succeeded'");
  });

  it("grants execute to authenticated + service_role on both definer and invoker wrappers", () => {
    for (const sig of [
      "app.create_payment_intent(uuid, uuid, int, text, text, uuid)",
      "public.create_payment_intent(uuid, uuid, int, text, text, uuid)",
      "app.create_refund(uuid, uuid, int, text, uuid, text)",
      "public.create_refund(uuid, uuid, int, text, uuid, text)",
    ]) {
      expect(migration).toContain(`revoke all on function ${sig} from public`);
      expect(migration).toContain(`grant execute on function ${sig}`);
    }
  });
});

describe("money API layer — no direct payment mutation (webhook authority)", () => {
  it("data-payments.ts reads payments and calls RPCs only — never insert/update/delete", () => {
    // Money moves through the RPC → outbox → webhook. The API data layer must
    // never write public.payments directly.
    expect(dataPayments).not.toContain(".insert(");
    expect(dataPayments).not.toContain(".update(");
    expect(dataPayments).not.toContain(".delete(");
    // It does call the two intent RPCs.
    expect(dataPayments).toContain('rpc("create_payment_intent"');
    expect(dataPayments).toContain('rpc("create_refund"');
  });

  it("the money routes go through the persisted idempotency middleware", () => {
    expect(routePayments).toContain("persistIdempotency(createBillingClient)");
    // The refund route consumes the 4.1 step-up grant above the threshold.
    expect(routePayments).toContain("validateStepUpGrant(");
    expect(routePayments).toContain("refund_over_threshold");
  });
});

describe("rls_attack.sql — payment RPC coverage (block 28)", () => {
  it("adds a cross-tenant attack block for the payment-intent + refund RPCs", () => {
    expect(attackSuite).toContain("(28)");
    // A foreign-tenant caller cannot create an intent or a refund.
    expect(attackSuite).toContain("app.create_payment_intent");
    expect(attackSuite).toContain("app.create_refund");
    // The refund RPC leaves the payment status untouched (webhook authority).
    expect(attackSuite).toContain("create_refund flipped the payment status");
  });
});
