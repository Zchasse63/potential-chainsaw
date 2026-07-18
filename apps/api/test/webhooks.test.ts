import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, type RecordedCall } from "./fakes.js";

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function resendHeaders(rawBody: string, secretText: string, id = "evt_1") {
  const secretBytes = new TextEncoder().encode(secretText);
  const secret = `whsec_${toBase64(secretBytes.buffer)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer.slice(
      secretBytes.byteOffset,
      secretBytes.byteOffset + secretBytes.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  return {
    secret,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${toBase64(signed)}`,
    },
  };
}

describe("public provider webhooks", () => {
  it("401s an invalid Resend signature before creating or touching a DB client", async () => {
    const createWebhookClient = vi.fn();
    const app = createApp({
      createWebhookClient,
      webhookEnv: { RESEND_WEBHOOK_SECRET: "whsec_c2VjcmV0" },
    });
    const response = await app.request("/api/v1/webhooks/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "evt_bad",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,tampered",
      },
      body: '{"type":"email.delivered"}',
    });

    expect(response.status).toBe(401);
    expect(createWebhookClient).not.toHaveBeenCalled();
  });

  it("401s an invalid Twilio signature before creating or touching a DB client", async () => {
    const createWebhookClient = vi.fn();
    const app = createApp({
      createWebhookClient,
      webhookEnv: { TWILIO_AUTH_TOKEN: "primary-token" },
    });
    const response = await app.request("/api/v1/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "tampered",
      },
      body: "MessageSid=SM1&MessageStatus=delivered",
    });

    expect(response.status).toBe(401);
    expect(createWebhookClient).not.toHaveBeenCalled();
  });

  it("dedupes by event id and maps a hard bounce to log status plus suppression", async () => {
    let inboxAttempts = 0;
    const fake = fakeUserClient({
      webhook_events: (calls: RecordedCall[]) => {
        if (calls.some((call) => call.method === "upsert")) {
          inboxAttempts += 1;
          return { data: inboxAttempts === 1 ? [{ id: "inbox-1" }] : [] };
        }
        return { data: null };
      },
      comms_log: (calls: RecordedCall[]) =>
        calls.some((call) => call.method === "select")
          ? {
              data: [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  person_id: "22222222-2222-4222-8222-222222222222",
                  channel: "email",
                  to_address: "person@example.com",
                  status: "sent",
                },
              ],
            }
          : { data: null },
      comms_suppressions: () => ({ data: null }),
    });
    const payload = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "email_123", to: ["Person@Example.com"] },
    });
    const signed = await resendHeaders(payload, "synthetic-route-secret", "evt_bounce");
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { RESEND_WEBHOOK_SECRET: signed.secret },
      webhookNow: () => new Date("2026-07-18T12:00:00Z"),
    });

    const request = () =>
      app.request("/api/v1/webhooks/resend", {
        method: "POST",
        headers: signed.headers,
        body: payload,
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);

    expect(inboxAttempts).toBe(2);
    const logUpdates = fake.calls.filter(
      (call) => call.table === "comms_log" && call.method === "update",
    );
    expect(logUpdates).toHaveLength(1);
    expect(logUpdates[0]?.args[0]).toMatchObject({ status: "bounced" });

    const suppressions = fake.calls.filter(
      (call) => call.table === "comms_suppressions" && call.method === "upsert",
    );
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]?.args[0]).toMatchObject({
      channel: "email",
      address: "person@example.com",
      reason: "hard_bounce",
    });
  });
});
