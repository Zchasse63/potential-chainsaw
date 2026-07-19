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

describe("toE164US — NANP structural validation (0029)", () => {
  it.each([
    "0000000000", // the live +10000000000 junk placeholder (36 people)
    "10000000000",
    "0135551234", // area code starts 0
    "1135551234", // area code starts 1
    "8130551234", // exchange starts 0
    "8131551234", // exchange starts 1
    "2110000000", // 211 area (N11 service-ish) — exchange 000 → invalid anyway
  ])("rejects the structurally-invalid US number %j", (raw) => {
    expect(toE164US(raw)).toBeNull();
  });

  it.each([
    ["8135551234", "+18135551234"], // area 8, exchange 5 — valid
    ["2025550143", "+12025550143"], // area 2, exchange 5 — valid
    ["9195550100", "+19195550100"], // area 9, exchange 5 — valid
  ])("still accepts the valid NANP number %j → %s", (raw, expected) => {
    expect(toE164US(raw)).toBe(expected);
  });
});

describe("phoneDigits", () => {
  it("strips every non-digit character", () => {
    expect(phoneDigits(" +1 (813).555-1234 ")).toBe("18135551234");
  });
});
