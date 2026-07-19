import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural guards on the POS backend (migration 0039) + its API layer. These
// keep a drift in the SQL or the routes from silently violating a money
// invariant; the live RLS attack suite (rls_attack.sql block 31) proves the
// tenancy/pricing/redemption behavior at runtime.

const migration = readFileSync(
  "supabase/migrations/20260719130100_0039_pos_checkout.sql",
  "utf8",
);
const dataPos = readFileSync("apps/api/src/data-pos.ts", "utf8");
const routePos = readFileSync("apps/api/src/routes/pos.ts", "utf8");
const verify = readFileSync("workers/src/billing/verify.ts", "utf8");
const inbox = readFileSync("workers/src/billing/inbox.ts", "utf8");
const attackSuite = readFileSync("supabase/tests/rls_attack.sql", "utf8");

/** Slice one `create or replace function <name>( … )` body up to its `$$;`. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 0039 — payments.tender + append-only ledger idempotency", () => {
  it("adds payments.tender constrained to stripe|cash|gift_card with a stripe default (backfill)", () => {
    expect(migration).toMatch(/alter table public\.payments\s+add column tender text not null default 'stripe'/);
    expect(migration).toContain("check (tender in ('stripe', 'cash', 'gift_card'))");
  });

  it("adds a redemption idempotency key WITHOUT granting UPDATE/DELETE (still append-only)", () => {
    expect(migration).toContain("alter table public.gift_card_ledger");
    expect(migration).toContain("add column idempotency_key text");
    expect(migration).toContain("gift_card_ledger_tenant_idem_key");
    // The ledger must NOT gain a write grant anywhere in this migration.
    expect(migration).not.toMatch(/grant update.*gift_card_ledger/i);
    expect(migration).not.toMatch(/grant delete.*gift_card_ledger/i);
  });
});

describe("migration 0039 — pos_checkout (server-side pricing, cash exception)", () => {
  it("is SECURITY DEFINER, search_path='', and re-checks tenancy/actor/role in-body", () => {
    const body = fnBody(migration, "create or replace function app.pos_checkout(");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("(select auth.uid()) <> p_actor");
    expect(body).toContain("array['owner', 'manager', 'front_desk']");
    // A nonzero discount narrows to owner/manager (front_desk + discount → 42501).
    expect(body).toContain("a discount requires owner or manager");
    expect(body).toContain("array['owner', 'manager']");
  });

  it("prices from the LIVE catalog and never accepts a client amount (no p_tax_cents)", () => {
    const body = fnBody(migration, "create or replace function app.pos_checkout(");
    // Prices are resolved server-side from the three catalogs.
    expect(body).toContain("from public.retail_products");
    expect(body).toContain("from public.gift_card_products");
    expect(body).toContain("kelo_type = 'drop_in'");
    expect(body).toContain("pp.superseded_at is null"); // current price phase
    // Tax is computed from settings, never sent by the client.
    expect(body).toContain("settings ->> 'tax_rate_bp'");
    // The signature does NOT accept a tax amount from the caller.
    expect(migration).not.toContain("p_tax_cents");
  });

  it("cash records a SUCCEEDED payment in-body (tender-scoped exception); stripe stays webhook-only", () => {
    const body = fnBody(migration, "create or replace function app.pos_checkout(");
    // Cash → succeeded + tender cash, no intent id, no command.
    expect(body).toMatch(/'succeeded', 'cash'/);
    // Stripe → requires_payment + a create_payment_intent outbox command (0034
    // pattern) with the SAME idempotency key; never a terminal money status.
    expect(body).toContain("'create_payment_intent'");
    expect(body).toMatch(/'requires_payment', 'stripe'/);
    // Idempotent on (tenant, idempotency_key) via the order unique constraint.
    expect(body).toContain("when unique_violation");
  });

  it("issues gift cards inline for CASH only; stripe issuance is deferred", () => {
    const body = fnBody(migration, "create or replace function app.pos_checkout(");
    // Inline issuance is gated on the cash branch.
    expect(body).toMatch(/if p_tender = 'cash' then\s+v_codes := app\.issue_order_gift_cards/);
  });
});

describe("migration 0039 — issuance + redemption (append-only, serialized)", () => {
  it("issue_order_gift_cards is gated on a SUCCEEDED payment and idempotent (issued_at + FOR UPDATE)", () => {
    const body = fnBody(migration, "create or replace function app.issue_order_gift_cards(");
    expect(body).toContain("security definer");
    expect(body).toContain("v_pay_status is distinct from 'succeeded'");
    expect(body).toContain("issued_at is null");
    expect(body).toContain("for update");
    // Only the sha256 HASH is stored; the raw code is returned, never persisted.
    expect(body).toContain("extensions.digest");
    expect(body).toContain("insert into public.gift_cards");
    expect(body).toContain("'issue'");
  });

  it("redeem_gift_card appends a NEGATIVE entry, row-locks the card, and refuses over-redemption", () => {
    const body = fnBody(migration, "create or replace function app.redeem_gift_card(");
    expect(body).toContain("security definer");
    // FOR UPDATE serializes concurrent redemptions on the same card.
    expect(body).toMatch(/from public\.gift_cards[\s\S]*for update/);
    // A negative 'redeem' entry — never a balance mutation.
    expect(body).toContain("'redeem', -p_amount_cents");
    expect(body).not.toMatch(/update\s+public\.gift_card_ledger/);
    // Over-redemption + idempotency.
    expect(body).toContain("redemption exceeds gift card balance");
    expect(body).toContain("when unique_violation");
    // front_desk may redeem at the counter.
    expect(body).toContain("array['owner', 'manager', 'front_desk']");
  });

  it("grants execute to authenticated + service_role on the member RPCs and service-only on issuance", () => {
    for (const sig of [
      "app.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text)",
      "public.pos_checkout(uuid, uuid, text, uuid, jsonb, text, int, text)",
      "app.redeem_gift_card(uuid, uuid, text, int, text)",
      "public.redeem_gift_card(uuid, uuid, text, int, text)",
    ]) {
      expect(migration).toContain(`revoke all on function ${sig} from public`);
      expect(migration).toContain(`grant execute on function ${sig}`);
    }
    // Issuance is service-role only (the inbox) — no client execute.
    expect(migration).toContain(
      "grant execute on function app.issue_order_gift_cards(uuid, uuid) to service_role",
    );
    expect(migration).not.toContain(
      "grant execute on function app.issue_order_gift_cards(uuid, uuid)\n  to authenticated",
    );
  });

  it("the receipt tables have member-SELECT and NO client/service write grant", () => {
    expect(migration).toContain("grant select on public.pos_orders, public.pos_order_lines to authenticated, service_role");
    expect(migration).not.toMatch(/grant insert.*pos_orders/i);
    expect(migration).not.toMatch(/grant update.*pos_orders/i);
    expect(migration).not.toMatch(/grant insert.*pos_order_lines/i);
  });
});

describe("verify_money tender-scoping regression (unit 5.7)", () => {
  it("check 1 excludes cash sales so a cash null intent id is not a CRITICAL violation", () => {
    // The terminal-paid check must scope to tender='stripe'; otherwise every
    // operator-attested cash sale is a false CRITICAL.
    expect(verify).toMatch(/status in \('succeeded', 'refunded', 'partially_refunded'\)\s+and tender = 'stripe'\s+and stripe_payment_intent_id is null/);
  });
});

describe("inbox POS gift-card seam (unit 5.7)", () => {
  it("issues the order's deferred gift cards on payment_intent.succeeded, idempotently", () => {
    expect(inbox).toContain("issueGiftCardsForPaidIntent");
    expect(inbox).toContain("app.issue_order_gift_cards");
    // It runs in the payment_succeeded path, after the guarded transition.
    const succeeded = inbox.slice(inbox.indexOf('case "payment_succeeded"'));
    expect(succeeded.slice(0, 900)).toContain("issueGiftCardsForPaidIntent");
  });
});

describe("POS API layer — server pricing, persisted idempotency", () => {
  it("data-pos.ts calls the RPCs only — never writes the money/order tables", () => {
    expect(dataPos).not.toContain(".insert(");
    expect(dataPos).not.toContain(".update(");
    expect(dataPos).not.toContain(".delete(");
    expect(dataPos).toContain('rpc("pos_checkout"');
    expect(dataPos).toContain('rpc("redeem_gift_card"');
  });

  it("the checkout schema has NO price field (client prices are never accepted)", () => {
    expect(routePos).not.toContain("price_cents");
    expect(routePos).not.toContain("unit_price_cents");
    expect(routePos).not.toContain("amount_cents: z"); // no per-line amount
  });

  it("both POS mutations go through the persisted idempotency middleware", () => {
    expect(routePos).toContain("persistIdempotency(createBillingClient)");
    expect(routePos).toContain("requireRole(\"owner\", \"manager\", \"front_desk\")");
  });
});

describe("rls_attack.sql — POS coverage (block 31)", () => {
  it("adds a cross-tenant attack block for checkout + redemption", () => {
    expect(attackSuite).toContain("(31)");
    expect(attackSuite).toContain("app.pos_checkout");
    expect(attackSuite).toContain("app.redeem_gift_card");
    // The load-bearing checks: server pricing, front_desk-discount refusal,
    // over-redemption refusal, append-only redemption ledger.
    expect(attackSuite).toContain("trusted a client-sent line price");
    expect(attackSuite).toContain("front_desk could apply a discount");
    expect(attackSuite).toContain("redeem allowed exceeding the balance");
    expect(attackSuite).toContain("redemption ledger is append-only");
  });
});

describe("5.7 review fixes (director) — settlement + refusals in the RPC SQL", () => {
  it("refuses gift-card SALES on stripe tender until code delivery ships (crit-1)", () => {
    expect(migration).toContain("gift-card sales are cash-only until card checkout ships");
    // The refusal fires for stripe tender + any gift_card line.
    expect(migration).toMatch(/p_tender = 'stripe' and exists \(\s*select 1 from jsonb_array_elements\(p_lines\) l where l ->> 'kind' = 'gift_card'/);
  });

  it("adds tender='gift_card' SETTLEMENT: ledger debit + payment in ONE transaction (crit-2)", () => {
    expect(migration).toContain("tender must be cash, stripe, or gift_card");
    // Settlement reuses the serialized, idempotent redeem path with a derived key…
    expect(migration).toContain("p_idempotency_key || ':settle'");
    // …and records an attested non-stripe payment (tender-scoped out of check 1).
    expect(migration).toMatch(/'succeeded', 'gift_card'/);
    // Circularity refused: a gift card cannot pay for a gift card.
    expect(migration).toContain("a gift card cannot pay for a gift card");
  });

  it("tax: digit-guarded rate + gift-card face value excluded from the taxable base", () => {
    expect(migration).toContain("~ '^[0-9]{1,5}$'");
    expect(migration).toMatch(/v_taxable := greatest\(v_subtotal - v_gift_sale/);
  });
});
