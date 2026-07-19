import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../src/index.js";

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Reproduce Stripe's scheme: HMAC-SHA256(`${t}.${body}`) keyed by the whole secret string, hex. */
async function sign(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  return toHex(digest);
}

const SECRET = "whsec_synthetic_endpoint_secret";
const TS = 1_784_383_200;
const BODY = '{"id":"evt_1","type":"payment_intent.succeeded"}';

describe("verifyStripeSignature", () => {
  it("accepts a correctly-signed body", async () => {
    const header = `t=${TS},v1=${await sign(SECRET, TS, BODY)}`;
    await expect(
      verifyStripeSignature(BODY, header, SECRET, { nowSeconds: TS }),
    ).resolves.toBe(true);
  });

  it("accepts when a rotated v1 (of several) matches", async () => {
    const good = await sign(SECRET, TS, BODY);
    const header = `t=${TS},v1=deadbeef,v1=${good}`;
    await expect(
      verifyStripeSignature(BODY, header, SECRET, { nowSeconds: TS }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const header = `t=${TS},v1=${await sign(SECRET, TS, BODY)}`;
    await expect(
      verifyStripeSignature(`${BODY} `, header, SECRET, { nowSeconds: TS }),
    ).resolves.toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const header = `t=${TS},v1=${await sign("whsec_wrong", TS, BODY)}`;
    await expect(
      verifyStripeSignature(BODY, header, SECRET, { nowSeconds: TS }),
    ).resolves.toBe(false);
  });

  it("rejects a timestamp outside tolerance (replay defense)", async () => {
    const header = `t=${TS},v1=${await sign(SECRET, TS, BODY)}`;
    // Signature is valid, but the event is 10 minutes old vs a 300s tolerance.
    await expect(
      verifyStripeSignature(BODY, header, SECRET, { nowSeconds: TS + 600 }),
    ).resolves.toBe(false);
    // Widening the tolerance lets the same (otherwise valid) event through.
    await expect(
      verifyStripeSignature(BODY, header, SECRET, { nowSeconds: TS + 600, toleranceSeconds: 900 }),
    ).resolves.toBe(true);
  });

  it("rejects malformed or missing headers and an empty secret", async () => {
    const header = `t=${TS},v1=${await sign(SECRET, TS, BODY)}`;
    await expect(verifyStripeSignature(BODY, "", SECRET, { nowSeconds: TS })).resolves.toBe(false);
    await expect(
      verifyStripeSignature(BODY, `v1=${await sign(SECRET, TS, BODY)}`, SECRET, { nowSeconds: TS }),
    ).resolves.toBe(false);
    await expect(verifyStripeSignature(BODY, `t=${TS}`, SECRET, { nowSeconds: TS })).resolves.toBe(
      false,
    );
    await expect(verifyStripeSignature(BODY, header, "", { nowSeconds: TS })).resolves.toBe(false);
  });
});
