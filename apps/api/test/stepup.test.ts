import { describe, expect, it } from "vitest";
import {
  hashStepUpPin,
  isValidStepUpPin,
  issueStepUpGrant,
  STEP_UP_GRANT_TTL_SECONDS,
  validateStepUpGrant,
  verifyStepUpPin,
} from "../src/auth/stepup.js";

const SECRET = "test-step-up-secret-is-at-least-32-bytes-long";

describe("step-up PIN scrypt", () => {
  it("round-trips with the fixed slow-KDF format and a per-PIN salt", () => {
    const first = hashStepUpPin("1234");
    const second = hashStepUpPin("1234");
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(second).not.toBe(first);
    expect(verifyStepUpPin("1234", first)).toBe(true);
    expect(verifyStepUpPin("0000", first)).toBe(false);
  });

  it("fails closed for tampered and malformed hashes while retaining fixed-size comparison", () => {
    const hash = hashStepUpPin("567890");
    const tampered = `${hash.slice(0, -1)}${hash.endsWith("A") ? "B" : "A"}`;
    expect(verifyStepUpPin("567890", tampered)).toBe(false);
    expect(verifyStepUpPin("567890", "sha256$not-accepted")).toBe(false);
    expect(verifyStepUpPin("567890", null)).toBe(false);
  });

  it("accepts only 4–6 decimal digits", () => {
    expect(isValidStepUpPin("1234")).toBe(true);
    expect(isValidStepUpPin("123456")).toBe(true);
    for (const invalid of ["123", "1234567", "12a4", " 1234", "１２３４"]) {
      expect(isValidStepUpPin(invalid)).toBe(false);
      expect(() => hashStepUpPin(invalid)).toThrow(TypeError);
    }
  });
});

describe("step-up grant HMAC", () => {
  it("issues an exp-bounded, context-scoped five-minute assertion", () => {
    const now = Date.UTC(2026, 6, 18, 12);
    const token = issueStepUpGrant(
      { sub: "user-1", tenant: "tenant-1", context: "refund_over_threshold" },
      SECRET,
      now,
    );
    const grant = validateStepUpGrant(token, SECRET, now);
    expect(grant).toMatchObject({
      sub: "user-1",
      tenant: "tenant-1",
      context: "refund_over_threshold",
    });
    expect((grant?.exp ?? 0) - (grant?.iat ?? 0)).toBe(STEP_UP_GRANT_TTL_SECONDS);
    expect(validateStepUpGrant(token, SECRET, now, { context: "manual_grant" })).toBeNull();
  });

  it("rejects tampering, expiry, and assertions with a widened lifetime", () => {
    const now = Date.UTC(2026, 6, 18, 12);
    const token = issueStepUpGrant(
      { sub: "user-1", tenant: "tenant-1", context: "manual_grant" },
      SECRET,
      now,
    );
    expect(validateStepUpGrant(`${token.slice(0, -1)}x`, SECRET, now)).toBeNull();
    expect(validateStepUpGrant(token, SECRET, now + 301_000)).toBeNull();

    const [header, encodedPayload] = token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as {
      exp: number;
    };
    payload.exp += 60;
    const widened = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.invalid`;
    expect(validateStepUpGrant(widened, SECRET, now)).toBeNull();
  });
});
