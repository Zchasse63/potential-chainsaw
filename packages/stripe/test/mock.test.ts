import { describe, expect, it } from "vitest";
import { createMockStripe } from "../src/index.js";

describe("createMockStripe", () => {
  it("yields deterministic dry-run ids from an injected counter and records calls", async () => {
    const { client, calls } = createMockStripe({ stripeAccountId: "acct_test" });
    expect(client.isDryRun).toBe(true);

    const pi = await client.createPaymentIntent({
      amount: 1000,
      currency: "usd",
      customer: "cus_1",
      idempotencyKey: "k1",
    });
    const re = await client.createRefund({ paymentIntent: "pi_x", idempotencyKey: "k2" });

    // Deterministic — no Math.random / Date.now anywhere in the id path.
    expect(pi).toEqual({ id: "dry_pi_1", dryRun: true });
    expect(re).toEqual({ id: "dry_re_2", dryRun: true });

    expect(calls).toEqual([
      {
        kind: "payment_intent",
        path: "/v1/payment_intents",
        params: { amount: 1000, currency: "usd", customer: "cus_1" },
        idempotencyKey: "k1",
      },
      {
        kind: "refund",
        path: "/v1/refunds",
        params: { payment_intent: "pi_x", amount: undefined },
        idempotencyKey: "k2",
      },
    ]);
  });

  it("honors a custom seed for id numbering", async () => {
    const { client } = createMockStripe({ seed: 100 });
    await expect(
      client.createCustomer({ email: "a@example.com", idempotencyKey: "k" }),
    ).resolves.toEqual({ id: "dry_cus_101", dryRun: true });
  });

  it("never touches the network", async () => {
    const { client } = createMockStripe();
    // The mock's fetchImpl rejects; dry-run must not reach it.
    await expect(
      client.createPrice({ currency: "usd", unitAmount: 500, idempotencyKey: "k" }),
    ).resolves.toMatchObject({ dryRun: true });
  });
});
