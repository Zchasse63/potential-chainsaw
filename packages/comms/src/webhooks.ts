type HeaderSource = Headers | Record<string, string | undefined>;
export type TwilioParams = Record<string, string | readonly string[]>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function hmac(
  algorithm: "SHA-1" | "SHA-256",
  keyBytes: Uint8Array,
  content: string,
): Promise<string> {
  const keyData = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength,
  ) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  return encodeBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)));
}

/** Svix scheme used by Resend: HMAC-SHA256(secret, id.timestamp.rawBody). */
export async function verifyResendSignature(
  rawBody: string,
  headers: HeaderSource,
  secret: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const id = header(headers, "svix-id");
  const timestamp = header(headers, "svix-timestamp");
  const signatures = header(headers, "svix-signature");
  if (id === undefined || timestamp === undefined || signatures === undefined || secret === "") {
    return false;
  }
  const numericTimestamp = Number(timestamp);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isInteger(numericTimestamp) || Math.abs(nowSeconds - numericTimestamp) > tolerance) {
    return false;
  }

  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = decodeBase64(encodedSecret);
  if (secretBytes.length === 0) return false;
  const expected = await hmac("SHA-256", secretBytes, `${id}.${timestamp}.${rawBody}`);
  return signatures
    .split(/\s+/)
    .map((signature) => signature.split(",", 2))
    .some(
      ([version, value]) =>
        version === "v1" && value !== undefined && constantTimeEqual(value, expected),
    );
}

/** Twilio form scheme: HMAC-SHA1(authToken, URL + sorted name/value pairs). */
export async function verifyTwilioSignature(
  url: string,
  params: TwilioParams,
  headers: HeaderSource,
  authToken: string,
): Promise<boolean> {
  const supplied = header(headers, "x-twilio-signature");
  if (supplied === undefined || authToken === "") return false;
  let content = url;
  for (const name of Object.keys(params).sort()) {
    const rawValues = params[name];
    const values = typeof rawValues === "string" ? [rawValues] : [...(rawValues ?? [])].sort();
    for (const value of values) content += `${name}${value}`;
  }
  const expected = await hmac("SHA-1", new TextEncoder().encode(authToken), content);
  return constantTimeEqual(supplied, expected);
}
