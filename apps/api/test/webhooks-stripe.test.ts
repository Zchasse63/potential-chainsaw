import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient } from "./fakes.js";

/**
 * The Stripe webhook receiver (Phase 5 · unit 5.3). The signature IS the auth
 * (threat-model §6): an invalid or stale signature is 401'd with NO DB write,
 * and a valid event is durably recorded in the stripe_events inbox exactly once
 * (on conflict(event_id) do nothing). The receiver NEVER processes inline — the
 * 'stripe.process_inbox' worker consumes the table.
 */

const URL = "http://localhost/api/v1/webhooks/stripe";
const SECRET = "whsec_test_secret";

function hex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Build a valid `t=<ts>,v1=<hmacHex>` header for the raw body. */
async function stripeSignature(
  rawBody: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  return `t=${timestamp},v1=${hex(signature)}`;
}

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_1",
    type: "payment_intent.succeeded",
    account: "acct_studio",
    data: { object: { id: "pi_1", amount: 5000, currency: "usd", status: "succeeded" } },
    ...overrides,
  });
}

function stripeEventsFake() {
  return fakeUserClient({
    stripe_events: () => ({ data: null }),
  });
}

describe("POST /webhooks/stripe", () => {
  it("401s an invalid signature before creating or touching a DB client", async () => {
    const createWebhookClient = vi.fn();
    const app = createApp({
      createWebhookClient,
      webhookEnv: { STRIPE_WEBHOOK_SECRET: SECRET },
    });
    const body = eventBody();
    const response = await app.request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Correct scheme, wrong HMAC.
        "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`,
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(createWebhookClient).not.toHaveBeenCalled();
  });

  it("401s a STALE but otherwise-valid signature (replay past tolerance) with no DB write", async () => {
    const createWebhookClient = vi.fn();
    const body = eventBody();
    const staleTs = 1_000_000; // long in the past
    const signature = await stripeSignature(body, SECRET, staleTs);
    const app = createApp({
      createWebhookClient,
      webhookEnv: { STRIPE_WEBHOOK_SECRET: SECRET },
      // Now is far beyond the 300s tolerance from the signed timestamp.
      webhookNow: () => new Date((staleTs + 10_000) * 1000),
    });

    const response = await app.request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });

    expect(response.status).toBe(401);
    expect(createWebhookClient).not.toHaveBeenCalled();
  });

  it("503s when the signing secret is not configured (no DB write)", async () => {
    const createWebhookClient = vi.fn();
    const app = createApp({ createWebhookClient, webhookEnv: {} });
    const response = await app.request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
      body: eventBody(),
    });

    expect(response.status).toBe(503);
    expect(createWebhookClient).not.toHaveBeenCalled();
  });

  it("records a valid event in the stripe_events inbox (on conflict(event_id) do nothing) and 200s", async () => {
    const fake = stripeEventsFake();
    const timestamp = 1_760_000_000;
    const body = eventBody();
    const signature = await stripeSignature(body, SECRET, timestamp);
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { STRIPE_WEBHOOK_SECRET: SECRET },
      webhookNow: () => new Date(timestamp * 1000),
    });

    const response = await app.request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    const upserts = fake.calls.filter(
      (call) => call.table === "stripe_events" && call.method === "upsert",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.args[0]).toMatchObject({
      event_id: "evt_1",
      type: "payment_intent.succeeded",
      stripe_account_id: "acct_studio",
      status: "received",
    });
    // The full event body is persisted as the payload (processors read the table).
    expect((upserts[0]?.args[0] as { payload: { id: string } }).payload.id).toBe("evt_1");
    expect(upserts[0]?.args[1]).toEqual({ onConflict: "event_id", ignoreDuplicates: true });
  });

  it("dedupes a redelivered event id: both deliveries 200 with an idempotent insert", async () => {
    const fake = stripeEventsFake();
    const timestamp = 1_760_000_100;
    const body = eventBody({ id: "evt_dup" });
    const signature = await stripeSignature(body, SECRET, timestamp);
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { STRIPE_WEBHOOK_SECRET: SECRET },
      webhookNow: () => new Date(timestamp * 1000),
    });

    const send = () =>
      app.request(URL, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body,
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    // Both deliveries run the SAME idempotent upsert (unique(event_id) dedupes);
    // there is no second-writer money path in the receiver.
    const upserts = fake.calls.filter(
      (call) => call.table === "stripe_events" && call.method === "upsert",
    );
    expect(upserts).toHaveLength(2);
    for (const call of upserts) {
      expect(call.args[1]).toEqual({ onConflict: "event_id", ignoreDuplicates: true });
      expect(call.args[0]).toMatchObject({ event_id: "evt_dup" });
    }
  });

  it("400s a signed body that is missing an event id (no inbox write)", async () => {
    const fake = stripeEventsFake();
    const timestamp = 1_760_000_200;
    const body = JSON.stringify({ type: "payment_intent.succeeded", data: { object: {} } });
    const signature = await stripeSignature(body, SECRET, timestamp);
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { STRIPE_WEBHOOK_SECRET: SECRET },
      webhookNow: () => new Date(timestamp * 1000),
    });

    const response = await app.request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });

    expect(response.status).toBe(400);
    expect(fake.calls.some((call) => call.table === "stripe_events")).toBe(false);
  });
});
