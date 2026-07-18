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

async function twilioRequest(
  params: Record<string, string>,
  token: string,
): Promise<{ url: string; body: string; headers: Record<string, string> }> {
  const url = "http://localhost/api/v1/webhooks/twilio";
  let signedContent = url;
  for (const name of Object.keys(params).sort()) signedContent += `${name}${params[name]}`;
  const tokenBytes = new TextEncoder().encode(token);
  const key = await crypto.subtle.importKey(
    "raw",
    tokenBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  return {
    url,
    body: new URLSearchParams(params).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": toBase64(signature),
    },
  };
}

function inboxHandler(calls: RecordedCall[]) {
  return calls.some((call) => call.method === "upsert")
    ? { data: [{ id: "inbox-stop" }] }
    : { data: null };
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

  it("matches an E.164 STOP through phone_e164 when the imported phone was raw", async () => {
    const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const personId = "11111111-1111-4111-8111-111111111111";
    const fake = fakeUserClient({
      webhook_events: inboxHandler,
      people: (calls) => ({
        data: calls.some(
          (call) =>
            call.method === "eq" &&
            call.args[0] === "phone_e164" &&
            call.args[1] === "+18135551234",
        )
          ? [{ id: personId, tenant_id: tenantId, source_phone: "813-555-1234" }]
          : [],
      }),
    });
    const token = "synthetic-twilio-token";
    const request = await twilioRequest(
      {
        MessageSid: "SM_stop_raw",
        OptOutType: "STOP",
        From: "+18135551234",
        To: "+18135550000",
        Body: "STOP",
      },
      token,
    );
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { TWILIO_AUTH_TOKEN: token },
      webhookNow: () => new Date("2026-07-18T12:00:00Z"),
    });

    expect(
      (
        await app.request(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        })
      ).status,
    ).toBe(200);

    expect(fake.calls).toContainEqual({
      table: "people",
      method: "eq",
      args: ["phone_e164", "+18135551234"],
    });
    expect(fake.calls).not.toContainEqual({
      table: "people",
      method: "limit",
      args: expect.anything(),
    });
    const suppression = fake.calls.find(
      (call) => call.table === "comms_suppressions" && call.method === "upsert",
    );
    expect(suppression?.args[0]).toEqual([
      {
        tenant_id: tenantId,
        person_id: personId,
        channel: "sms",
        address: "+18135551234",
        reason: "stop_reply",
      },
    ]);
  });

  it("fails open across every tenant sharing a STOP number", async () => {
    const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fake = fakeUserClient({
      webhook_events: inboxHandler,
      people: () => ({
        data: [
          { id: "11111111-1111-4111-8111-111111111111", tenant_id: tenantA },
          { id: "22222222-2222-4222-8222-222222222222", tenant_id: tenantA },
          { id: "33333333-3333-4333-8333-333333333333", tenant_id: tenantB },
        ],
      }),
    });
    const token = "synthetic-twilio-token";
    const request = await twilioRequest(
      {
        MessageSid: "SM_stop_shared",
        OptOutType: "STOP",
        From: "+18135551234",
        To: "+18135550000",
        Body: "STOP",
      },
      token,
    );
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { TWILIO_AUTH_TOKEN: token },
    });

    await app.request(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    const suppression = fake.calls.find(
      (call) => call.table === "comms_suppressions" && call.method === "upsert",
    );
    expect(suppression?.args[0]).toEqual([
      expect.objectContaining({ tenant_id: tenantA, person_id: null }),
      expect.objectContaining({
        tenant_id: tenantB,
        person_id: "33333333-3333-4333-8333-333333333333",
      }),
    ]);
    const consent = fake.calls.find(
      (call) => call.table === "communication_consents" && call.method === "insert",
    );
    expect(consent?.args[0]).toHaveLength(3);
    const inbound = fake.calls.find(
      (call) => call.table === "comms_log" && call.method === "insert",
    );
    expect(inbound?.args[0]).toEqual([
      expect.objectContaining({ tenant_id: tenantA, person_id: null }),
      expect.objectContaining({
        tenant_id: tenantB,
        person_id: "33333333-3333-4333-8333-333333333333",
      }),
    ]);
  });

  it("processes an unresolved STOP with a review note instead of discarding it", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = fakeUserClient({
      webhook_events: inboxHandler,
      people: () => ({ data: [] }),
    });
    const token = "synthetic-twilio-token";
    const request = await twilioRequest(
      {
        MessageSid: "SM_stop_unknown",
        OptOutType: "STOP",
        From: "+18135559999",
        To: "+18135550000",
        Body: "STOP",
      },
      token,
    );
    const app = createApp({
      createWebhookClient: () => fake.client,
      webhookEnv: { TWILIO_AUTH_TOKEN: token },
    });

    const response = await app.request(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(200);
    const finalized = fake.calls.find(
      (call) => call.table === "webhook_events" && call.method === "update",
    );
    expect(finalized?.args[0]).toMatchObject({
      status: "processed",
      error: "stop_unresolved_no_person",
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("unresolved Twilio STOP"));
    expect(
      fake.calls.some((call) =>
        ["comms_suppressions", "communication_consents", "comms_log"].includes(call.table),
      ),
    ).toBe(false);
    warning.mockRestore();
  });
});
