/**
 * Stripe webhook signature verification (threat-model §6: webhook receivers are
 * signature-verified; the receiver persists to the `stripe_events` inbox and
 * processors consume the TABLE, never the HTTP request). Pure — the caller (the
 * webhook edge boundary) owns the clock and injects `nowSeconds`.
 *
 * Stripe scheme: the `Stripe-Signature` header is `t=<ts>,v1=<hmacHex>[,v1=…]`.
 * The signed payload is `${t}.${rawBody}`; the expected signature is
 * HMAC-SHA256(signedPayload) keyed by the endpoint's signing secret (the whole
 * `whsec_…` string, used verbatim — unlike Svix/Resend, Stripe does not decode
 * it), hex-encoded. A timestamp tolerance (default 300s) defends against replay.
 */

export interface VerifyStripeSignatureOptions {
  /** Replay tolerance in seconds. Default 300 (Stripe's recommendation). */
  readonly toleranceSeconds?: number;
  /**
   * Current unix time in SECONDS. Injected so this function stays pure and
   * testable; the webhook edge boundary passes `Math.floor(Date.now()/1000)`.
   * Defaults to now when omitted (mirrors @kelo/comms).
   */
  readonly nowSeconds?: number;
}

interface ParsedSignatureHeader {
  timestamp?: number;
  readonly v1: string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader {
  const parsed: ParsedSignatureHeader = { v1: [] };
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const numeric = Number(value);
      if (Number.isInteger(numeric)) parsed.timestamp = numeric;
    } else if (key === "v1" && value !== "") {
      parsed.v1.push(value);
    }
  }
  return parsed;
}

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function hmacSha256Hex(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)));
}

/** Length-independent, value-constant-time string compare. */
function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
  options: VerifyStripeSignatureOptions = {},
): Promise<boolean> {
  if (secret === "" || sigHeader === "") return false;
  const { timestamp, v1 } = parseSignatureHeader(sigHeader);
  if (timestamp === undefined || v1.length === 0) return false;

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return v1.some((candidate) => constantTimeEqual(candidate, expected));
}
