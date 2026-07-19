import { describe, expect, it, vi } from "vitest";
import {
  StripeApiError,
  StripeClient,
  stripeConfigFromEnv,
  type FetchImpl,
  type StripeCall,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("StripeClient dry-run", () => {
  it("returns synthetic ids without touching the injected fetch when no key is set", async () => {
    const fetchImpl = vi.fn<FetchImpl>(() => Promise.reject(new Error("network must not run")));
    // A fixed id factory keeps the assertion deterministic (no Math.random/Date.now).
    let n = 0;
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      fetchImpl,
      newId: () => `uuid${(n += 1)}`,
    });

    expect(client.isDryRun).toBe(true);

    await expect(
      client.createPaymentIntent({
        amount: 2500,
        currency: "usd",
        customer: "cus_1",
        idempotencyKey: "idem_pi",
      }),
    ).resolves.toEqual({ id: "dry_pi_uuid1", dryRun: true });
    await expect(
      client.createRefund({ paymentIntent: "pi_1", idempotencyKey: "idem_re" }),
    ).resolves.toEqual({ id: "dry_re_uuid2", dryRun: true });
    await expect(
      client.createCustomer({ email: "a@example.com", idempotencyKey: "idem_cus" }),
    ).resolves.toEqual({ id: "dry_cus_uuid3", dryRun: true });
    await expect(
      client.createSubscription({
        customer: "cus_1",
        items: [{ price: "price_1" }],
        idempotencyKey: "idem_sub",
      }),
    ).resolves.toEqual({ id: "dry_sub_uuid4", dryRun: true });
    await expect(
      client.createPrice({ currency: "usd", unitAmount: 5000, idempotencyKey: "idem_price" }),
    ).resolves.toEqual({ id: "dry_price_uuid5", dryRun: true });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forces dry-run even when a secret key is present", async () => {
    const fetchImpl = vi.fn<FetchImpl>(() => Promise.reject(new Error("network must not run")));
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      secretKey: "sk_test_present",
      dryRun: true,
      fetchImpl,
      newId: () => "x",
    });
    await expect(
      client.createPaymentIntent({ amount: 100, currency: "usd", idempotencyKey: "k" }),
    ).resolves.toMatchObject({ dryRun: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stripeConfigFromEnv reads STRIPE_SECRET_KEY by name and selects dry-run when absent", () => {
    expect(stripeConfigFromEnv("acct_1", {}).secretKey).toBeUndefined();
    expect(new StripeClient(stripeConfigFromEnv("acct_1", {})).isDryRun).toBe(true);
    const config = stripeConfigFromEnv("acct_1", { STRIPE_SECRET_KEY: "sk_test_x" });
    expect(config.secretKey).toBe("sk_test_x");
    expect(new StripeClient(config).isDryRun).toBe(false);
  });
});

describe("StripeClient live calls (injected fetch)", () => {
  it("scopes to the connected account and forwards the caller's Idempotency-Key", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({ id: "pi_live", status: "requires_confirmation" }),
    );
    const client = new StripeClient({
      stripeAccountId: "acct_connected_42",
      secretKey: "sk_test_live",
      fetchImpl,
    });

    await expect(
      client.createPaymentIntent({
        amount: 4200,
        currency: "usd",
        customer: "cus_9",
        idempotencyKey: "outbox-key-123",
      }),
    ).resolves.toEqual({ id: "pi_live", status: "requires_confirmation" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/payment_intents");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("stripe-account")).toBe("acct_connected_42");
    expect(headers.get("idempotency-key")).toBe("outbox-key-123");
    expect(headers.get("authorization")).toBe("Bearer sk_test_live");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      amount: "4200",
      currency: "usd",
      customer: "cus_9",
    });
  });

  it("encodes a refund body and drops the amount when omitted (full refund)", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({ id: "re_1", status: "succeeded" }),
    );
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      secretKey: "sk_test",
      fetchImpl,
    });
    await client.createRefund({ paymentIntent: "pi_1", idempotencyKey: "k1" });
    expect(Object.fromEntries(new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body)))).toEqual(
      { payment_intent: "pi_1" },
    );

    await client.createRefund({ paymentIntent: "pi_2", amount: 500, idempotencyKey: "k2" });
    expect(Object.fromEntries(new URLSearchParams(String(fetchImpl.mock.calls[1]![1]?.body)))).toEqual(
      { payment_intent: "pi_2", amount: "500" },
    );
  });

  it("encodes nested subscription items and price recurring with Stripe bracket syntax", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ id: "sub_1", status: "active" }));
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      secretKey: "sk_test",
      fetchImpl,
    });
    await client.createSubscription({
      customer: "cus_1",
      items: [{ price: "price_a", quantity: 2 }],
      idempotencyKey: "k",
    });
    const subBody = String(fetchImpl.mock.calls[0]![1]?.body);
    expect(subBody).toContain("items%5B0%5D%5Bprice%5D=price_a");
    expect(subBody).toContain("items%5B0%5D%5Bquantity%5D=2");
    expect(subBody).toContain("customer=cus_1");

    await client.createPrice({
      currency: "usd",
      unitAmount: 9900,
      product: "prod_1",
      recurring: { interval: "month" },
      idempotencyKey: "k2",
    });
    const priceBody = String(fetchImpl.mock.calls[1]![1]?.body);
    expect(priceBody).toContain("unit_amount=9900");
    expect(priceBody).toContain("recurring%5Binterval%5D=month");
    expect(priceBody).toContain("product=prod_1");
  });

  it("throws StripeApiError on a non-2xx response", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      async () => new Response("card_declined", { status: 402 }),
    );
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      secretKey: "sk_test",
      fetchImpl,
    });
    await expect(
      client.createPaymentIntent({ amount: 100, currency: "usd", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(StripeApiError);
  });

  it("refuses any mutation without an Idempotency-Key, before any network call", async () => {
    const fetchImpl = vi.fn<FetchImpl>(() => Promise.reject(new Error("network must not run")));
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      secretKey: "sk_test",
      fetchImpl,
    });
    await expect(
      client.createPaymentIntent({ amount: 100, currency: "usd", idempotencyKey: "" }),
    ).rejects.toThrow(/Idempotency-Key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty connected account id at construction", () => {
    expect(() => new StripeClient({ stripeAccountId: "", secretKey: "sk_test" })).toThrow(
      /stripeAccountId/,
    );
  });

  it("records the intended call for the outbox even in dry-run", async () => {
    const recorded: StripeCall[] = [];
    const client = new StripeClient({
      stripeAccountId: "acct_1",
      newId: () => "u",
      recorder: (call) => recorded.push(call),
    });
    await client.createPaymentIntent({
      amount: 100,
      currency: "usd",
      customer: "cus_1",
      idempotencyKey: "idem-1",
    });
    expect(recorded).toEqual([
      {
        kind: "payment_intent",
        path: "/v1/payment_intents",
        params: { amount: 100, currency: "usd", customer: "cus_1" },
        idempotencyKey: "idem-1",
      },
    ]);
  });
});
