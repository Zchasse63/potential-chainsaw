import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * PINs have only 4–6 decimal digits, so fast hashes are unsafe. We use scrypt
 * with a fresh 16-byte salt per PIN: N=32768, r=8, p=1, 32-byte output, and a
 * 64 MiB memory ceiling. The serialized contract is:
 *   scrypt$32768$8$1$<base64url salt>$<base64url derived key>
 */
export const SCRYPT_N = 32_768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SALT_LENGTH = 16;
const PIN_PATTERN = /^\d{4,6}$/;
const HASH_PATTERN = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export function isValidStepUpPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

function derive(pin: string, salt: Buffer): Buffer {
  return scryptSync(pin, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

export function hashStepUpPin(pin: string): string {
  if (!isValidStepUpPin(pin)) {
    throw new TypeError("step-up PIN must contain 4 to 6 digits");
  }
  const salt = randomBytes(SALT_LENGTH);
  const hash = derive(pin, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/**
 * Always performs one fixed-cost derivation, including for a malformed stored
 * value. The fixed-size result is compared with timingSafeEqual. No PIN or
 * serialized hash is logged or included in an error.
 */
export function verifyStepUpPin(pin: string, serialized: string | null): boolean {
  const match = serialized?.match(HASH_PATTERN) ?? null;
  const decodedSalt = match === null ? null : Buffer.from(match[1]!, "base64url");
  const decodedHash = match === null ? null : Buffer.from(match[2]!, "base64url");
  const canonical =
    match !== null &&
    decodedSalt?.toString("base64url") === match[1] &&
    decodedHash?.toString("base64url") === match[2];
  const salt = canonical && decodedSalt !== null ? decodedSalt : Buffer.alloc(SALT_LENGTH);
  const expected =
    canonical && decodedHash !== null ? decodedHash : Buffer.alloc(SCRYPT_KEY_LENGTH);
  const actual = derive(pin, salt);
  return canonical && timingSafeEqual(actual, expected);
}

export const STEP_UP_GRANT_TTL_SECONDS = 5 * 60;
const MAX_CLOCK_SKEW_SECONDS = 30;
const CONTEXT_PATTERN = /^[a-z][a-z0-9_:-]{0,99}$/;
const TOKEN_HEADER = { alg: "HS256", typ: "KSG", v: 1 } as const;

export interface StepUpGrant {
  sub: string;
  tenant: string;
  context: string;
  iat: number;
  exp: number;
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("STEP_UP_SECRET must contain at least 32 bytes");
  }
}

function signature(unsigned: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(unsigned).digest();
}

export function issueStepUpGrant(
  input: Pick<StepUpGrant, "sub" | "tenant" | "context">,
  secret: string,
  nowMs = Date.now(),
): string {
  assertSecret(secret);
  if (!CONTEXT_PATTERN.test(input.context)) {
    throw new TypeError("invalid step-up action context");
  }
  const iat = Math.floor(nowMs / 1000);
  const payload: StepUpGrant = {
    ...input,
    iat,
    exp: iat + STEP_UP_GRANT_TTL_SECONDS,
  };
  const encodedHeader = Buffer.from(JSON.stringify(TOKEN_HEADER)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  return `${unsigned}.${signature(unsigned, secret).toString("base64url")}`;
}

function isGrant(value: unknown): value is StepUpGrant {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Partial<StepUpGrant>;
  return (
    typeof grant.sub === "string" &&
    grant.sub.length > 0 &&
    typeof grant.tenant === "string" &&
    grant.tenant.length > 0 &&
    typeof grant.context === "string" &&
    CONTEXT_PATTERN.test(grant.context) &&
    typeof grant.iat === "number" &&
    Number.isInteger(grant.iat) &&
    typeof grant.exp === "number" &&
    Number.isInteger(grant.exp)
  );
}

/** Returns the verified, unexpired context-scoped assertion, or null. */
export function validateStepUpGrant(
  token: string,
  secret: string,
  nowMs = Date.now(),
  expectedClaims?: Partial<Pick<StepUpGrant, "sub" | "tenant" | "context">>,
): StepUpGrant | null {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const supplied = Buffer.from(encodedSignature, "base64url");
  const expected = signature(unsigned, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown;
    if (
      typeof header !== "object" ||
      header === null ||
      (header as Partial<typeof TOKEN_HEADER>).alg !== TOKEN_HEADER.alg ||
      (header as Partial<typeof TOKEN_HEADER>).typ !== TOKEN_HEADER.typ ||
      (header as Partial<typeof TOKEN_HEADER>).v !== TOKEN_HEADER.v
    ) {
      return null;
    }
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as unknown;
    if (!isGrant(payload)) return null;
    const now = Math.floor(nowMs / 1000);
    if (payload.iat > now + MAX_CLOCK_SKEW_SECONDS) return null;
    if (payload.exp <= now) return null;
    if (payload.exp - payload.iat !== STEP_UP_GRANT_TTL_SECONDS) return null;
    if (expectedClaims?.sub !== undefined && payload.sub !== expectedClaims.sub) return null;
    if (expectedClaims?.tenant !== undefined && payload.tenant !== expectedClaims.tenant)
      return null;
    if (expectedClaims?.context !== undefined && payload.context !== expectedClaims.context)
      return null;
    return payload;
  } catch {
    return null;
  }
}

/** Privacy-preserving audit value; the raw forwarded address is never stored. */
export function hashAuditIp(ip: string | undefined, secret: string): string | null {
  if (ip === undefined || ip.trim() === "") return null;
  assertSecret(secret);
  return createHmac("sha256", secret)
    .update("step-up-ip\0")
    .update(ip.split(",")[0]!.trim())
    .digest("base64url");
}
