import { describe, expect, it } from "vitest";
import { phoneDigits, toE164US } from "../src/phone.js";

describe("toE164US", () => {
  it.each([
    ["813-555-1234", "+18135551234"],
    ["(813) 555-1234", "+18135551234"],
    ["813 555 1234", "+18135551234"],
    ["+1 813 555 1234", "+18135551234"],
    ["1-813-555-1234", "+18135551234"],
    ["8135551234", "+18135551234"],
    ["+18135551234", "+18135551234"],
  ])("canonicalizes %j to %s", (raw, expected) => {
    expect(toE164US(raw)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "not a phone",
    "555-1234",
    "+44 20 7946 0958",
    "813-555-1234 ext. 5",
    "+1 813 555 1234 99",
    "2 813 555 1234",
  ])("returns null for an un-normalizable value (%j)", (raw) => {
    expect(toE164US(raw)).toBeNull();
  });

  it("is idempotent for canonical E.164", () => {
    const canonical = toE164US("+18135551234");
    expect(toE164US(canonical)).toBe(canonical);
  });
});

describe("phoneDigits", () => {
  it("strips every non-digit character", () => {
    expect(phoneDigits(" +1 (813).555-1234 ")).toBe("18135551234");
  });
});
