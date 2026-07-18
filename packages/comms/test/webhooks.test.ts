import { describe, expect, it } from "vitest";
import { verifyResendSignature, verifyTwilioSignature } from "../src/index.js";

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signature(algorithm: "SHA-256", key: Uint8Array, content: string): Promise<string> {
  const keyData = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const imported = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  return toBase64(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(content)));
}

describe("webhook signatures", () => {
  it("accepts a synthetic Resend/Svix fixture and rejects body tampering", async () => {
    const rawBody = '{"type":"email.delivered"}';
    const id = "msg_fixture";
    const timestamp = "1784383200";
    const secretBytes = new TextEncoder().encode("synthetic-resend-secret");
    const secret = `whsec_${toBase64(secretBytes.buffer)}`;
    const value = await signature("SHA-256", secretBytes, `${id}.${timestamp}.${rawBody}`);
    const headers = {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${value}`,
    };

    await expect(
      verifyResendSignature(rawBody, headers, secret, { nowSeconds: Number(timestamp) }),
    ).resolves.toBe(true);
    await expect(
      verifyResendSignature(`${rawBody} `, headers, secret, { nowSeconds: Number(timestamp) }),
    ).resolves.toBe(false);
  });

  it("matches Twilio's published HMAC-SHA1 fixture and rejects changed params", async () => {
    const url = "https://example.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    };
    const headers = { "x-twilio-signature": "L/OH5YylLD5NRKLltdqwSvS0BnU=" };
    await expect(verifyTwilioSignature(url, params, headers, "12345")).resolves.toBe(true);
    await expect(
      verifyTwilioSignature(url, { ...params, Digits: "9999" }, headers, "12345"),
    ).resolves.toBe(false);
  });
});
