import { describe, expect, it } from "vitest";
import { createMockStripe } from "@kelo/stripe";
import { runOutbox, type StripeAdapter } from "../../src/billing/outbox.js";
import { callsMatching, createBillingPool, type QueryCall, type Responder } from "./helpers.js";

/**
 * THE STRIPE OUTBOX PROCESSOR (Phase 5 · unit 5.3) — the durable delivery
 * engine. Drives pending stripe_commands to Stripe with the command's OWN
 * idempotency key (so a retry never double-charges), links the payment, retries
 * on failure, and dead-letters after N attempts. NO network, NO DB.
 */

interface CommandOverrides {
  readonly id?: string;
  readonly tenant_id?: string;
  readonly kind?: string;
  readonly idempotency_key?: string;
  readonly payload?: Record<string, unknown>;
  readonly attempts?: number;
}

function command(overrides: CommandOverrides = {}) {
  return {
    id: "c1",
    tenant_id: "t1",
    // The canonical RPC contract from migration 0034 (F2): kind
    // 'create_payment_intent' with payload {amount_cents, currency, customer_id}.
    kind: "create_payment_intent",
    idempotency_key: "idem-1",
    payload: { amount_cents: 5000, currency: "usd", customer_id: "cust_1" },
    attempts: 0,
    ...overrides,
  };
}

/** Responder: the claim returns the given commands; the account resolves to
 * `account` (pass null for "no connected account"); the customer resolves to a
 * Stripe id on file (F2: the outbox reads stripe_customer_id from customers). */
function respondFor(commands: unknown[], account: string | null = "acct_1"): Responder {
  return (text) => {
    if (text.includes("from public.stripe_commands")) return { rows: commands };
    if (text.includes("from public.stripe_accounts")) {
      return { rows: account === null ? [] : [{ stripe_account_id: account }] };
    }
    if (text.includes("from public.customers")) {
      return { rows: [{ stripe_customer_id: "cus_1" }] };
    }
    return undefined;
  };
}

function commandUpdate(call: QueryCall) {
  return { values: call.values ?? [] };
}

describe("delivery — success path", () => {
  it("calls the adapter with the command's idempotency key, marks sent, and links the payment", async () => {
    const mock = createMockStripe(); // deterministic ids: dry_pi_1, dry_pi_2, …
    const madeWith: { stripeAccountId: string }[] = [];
    const pool = createBillingPool(respondFor([command()]));

    const outcomes = await runOutbox(pool, {
      makeClient: (opts) => {
        madeWith.push(opts);
        return mock.client;
      },
    });

    // Per-connected-account scoping: the client is built for the resolved account.
    expect(madeWith).toEqual([{ stripeAccountId: "acct_1" }]);
    // The adapter was driven with the command's OWN key + payload params.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      kind: "payment_intent",
      path: "/v1/payment_intents",
      idempotencyKey: "idem-1",
      params: { amount: 5000, currency: "usd", customer: "cus_1" },
    });

    expect(outcomes).toEqual([{ commandId: "c1", status: "sent", stripeObjectId: "dry_pi_1" }]);

    // The claim uses FOR UPDATE SKIP LOCKED, like the jobs queue.
    expect(callsMatching(pool.calls, "for update skip locked")).toHaveLength(1);

    // The command advances pending→sent with the returned object id.
    const sent = callsMatching(pool.calls, "set status = 'sent'")[0]!;
    expect(commandUpdate(sent).values[0]).toBe("dry_pi_1");

    // The intent id is linked back onto the RPC-created payment (by command_id).
    const link = callsMatching(pool.calls, "update public.payments")[0]!;
    expect(link.values).toEqual(["dry_pi_1", "t1", "c1"]);
  });

  it("only links the payment for payment_intent commands (a customer command does not)", async () => {
    const mock = createMockStripe();
    const pool = createBillingPool(
      respondFor([command({ id: "c2", kind: "customer", payload: { email: "a@b.co" } })]),
    );

    await runOutbox(pool, { makeClient: () => mock.client });

    expect(mock.calls[0]).toMatchObject({ kind: "customer", idempotencyKey: "idem-1" });
    expect(callsMatching(pool.calls, "update public.payments")).toHaveLength(0);
    expect(callsMatching(pool.calls, "set status = 'sent'")).toHaveLength(1);
  });
});

describe("delivery — retry without duplication", () => {
  it("stays pending on failure, then a later tick succeeds reusing the SAME idempotency key", async () => {
    const keys: string[] = [];
    let call = 0;
    const adapter = {
      createPaymentIntent: async (params: { idempotencyKey: string }) => {
        keys.push(params.idempotencyKey);
        call += 1;
        if (call === 1) throw new Error("network blip");
        return { id: "pi_live", status: "requires_payment" };
      },
    } as unknown as StripeAdapter;

    // Tick 1: attempts 0 → the call fails → the command stays pending.
    const pool1 = createBillingPool(respondFor([command({ attempts: 0 })]));
    const out1 = await runOutbox(pool1, { makeClient: () => adapter });
    expect(out1).toEqual([{ commandId: "c1", status: "pending", attempts: 1 }]);
    const retryUpdate = callsMatching(pool1.calls, "update public.stripe_commands")[0]!;
    expect(retryUpdate.text).toContain("set attempts");
    expect(retryUpdate.text).not.toContain("status = 'failed'");
    expect(commandUpdate(retryUpdate).values[0]).toBe(1);

    // Tick 2: the persisted command now has attempts 1 → the retry succeeds.
    const pool2 = createBillingPool(respondFor([command({ attempts: 1 })]));
    const out2 = await runOutbox(pool2, { makeClient: () => adapter });
    expect(out2).toEqual([{ commandId: "c1", status: "sent", stripeObjectId: "pi_live" }]);

    // The retried Stripe call reused the SAME key — Stripe dedupes it, so the
    // retry is never a second charge.
    expect(keys).toEqual(["idem-1", "idem-1"]);
  });
});

describe("delivery — dead-letter after N attempts", () => {
  it("flips the command to 'failed' and opens a critical alert on the final attempt", async () => {
    const adapter = {
      createPaymentIntent: async () => {
        throw new Error("card_declined");
      },
    } as unknown as StripeAdapter;

    // attempts 4 with maxAttempts 5 → this attempt is the 5th (fatal).
    const pool = createBillingPool(respondFor([command({ attempts: 4 })]));
    const outcomes = await runOutbox(pool, { makeClient: () => adapter, maxAttempts: 5 });

    expect(outcomes).toEqual([{ commandId: "c1", status: "failed", attempts: 5 }]);

    const failed = callsMatching(pool.calls, "set status = 'failed'")[0]!;
    expect(commandUpdate(failed).values[0]).toBe(5); // attempts
    expect(String(commandUpdate(failed).values[1])).toContain("card_declined");

    const alert = callsMatching(pool.calls, "insert into public.alerts")[0]!;
    expect(alert.text).toContain("'stripe_command_failed'");
    expect(alert.text).toContain("'critical'");
    expect(commandUpdate(alert).values[0]).toBe("t1"); // tenant_id
    expect(commandUpdate(alert).values[3]).toBe("c1"); // dedupe_key = command id
  });
});

describe("delivery — loud failures, isolated", () => {
  it("an unknown command kind never silently drops — it errors and retries", async () => {
    const mock = createMockStripe();
    const pool = createBillingPool(respondFor([command({ kind: "bogus" })]));

    const outcomes = await runOutbox(pool, { makeClient: () => mock.client });

    expect(outcomes).toEqual([{ commandId: "c1", status: "pending", attempts: 1 }]);
    expect(mock.calls).toHaveLength(0); // never dispatched
    const update = callsMatching(pool.calls, "update public.stripe_commands")[0]!;
    expect(String(commandUpdate(update).values[1])).toContain("unknown stripe command kind");
  });

  it("a command whose tenant has no connected account stays pending with a clear error", async () => {
    let built = 0;
    const pool = createBillingPool(respondFor([command()], null));

    const outcomes = await runOutbox(pool, {
      makeClient: () => {
        built += 1;
        return createMockStripe().client;
      },
    });

    expect(outcomes).toEqual([{ commandId: "c1", status: "pending", attempts: 1 }]);
    expect(built).toBe(0); // no adapter built without an account
    const update = callsMatching(pool.calls, "update public.stripe_commands")[0]!;
    expect(String(commandUpdate(update).values[1])).toContain("no connected Stripe account");
  });

  it("one failing command never blocks the others in the batch", async () => {
    const adapter = {
      createPaymentIntent: async (params: { idempotencyKey: string }) => {
        if (params.idempotencyKey === "idem-bad") throw new Error("boom");
        return { id: "pi_ok", status: "requires_payment" };
      },
    } as unknown as StripeAdapter;

    const pool = createBillingPool(
      respondFor([
        command({ id: "c_bad", idempotency_key: "idem-bad" }),
        command({ id: "c_ok", idempotency_key: "idem-ok" }),
      ]),
    );

    const outcomes = await runOutbox(pool, { makeClient: () => adapter });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ commandId: "c_bad", status: "pending", attempts: 1 });
    expect(outcomes[1]).toMatchObject({
      commandId: "c_ok",
      status: "sent",
      stripeObjectId: "pi_ok",
    });
  });
});
