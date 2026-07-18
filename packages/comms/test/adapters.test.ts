import { describe, expect, it, vi } from "vitest";
import { ResendAdapter, TwilioAdapter, type FetchImpl } from "../src/index.js";

describe("provider adapters", () => {
  it("dry-runs Resend and Twilio with no credentials and makes no network call", async () => {
    const fetchImpl = vi.fn<FetchImpl>(() => Promise.reject(new Error("network must not run")));
    const resend = new ResendAdapter({ fetchImpl });
    const twilio = new TwilioAdapter({ fetchImpl });

    await expect(
      resend.send({ to: "a@example.com", subject: "Hello", body: "Body" }),
    ).resolves.toMatchObject({ dryRun: true });
    await expect(twilio.send({ to: "+12125550123", body: "Body" })).resolves.toMatchObject({
      dryRun: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the documented Resend JSON payload through injected fetch", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    const adapter = new ResendAdapter({
      apiKey: "re_test",
      from: "Kelo <hello@example.com>",
      fetchImpl,
    });
    await expect(
      adapter.send({ to: "person@example.com", subject: "Booked", body: "See you." }),
    ).resolves.toEqual({ providerMessageId: "email_123" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "Kelo <hello@example.com>",
      to: ["person@example.com"],
      subject: "Booked",
      text: "See you.",
    });
  });

  it("sends Twilio form data and rejects non-US destinations before fetch", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      async () => new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }),
    );
    const adapter = new TwilioAdapter({
      accountSid: "AC123",
      authToken: "token",
      messagingServiceSid: "MG123",
      fetchImpl,
    });
    await expect(adapter.send({ to: "+12125550123", body: "Booked" })).resolves.toEqual({
      providerMessageId: "SM123",
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      To: "+12125550123",
      Body: "Booked",
      MessagingServiceSid: "MG123",
    });

    await expect(adapter.send({ to: "+442079460123", body: "No" })).rejects.toThrow("US-only");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
