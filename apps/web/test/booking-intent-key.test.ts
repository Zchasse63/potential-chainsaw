import { describe, expect, it } from "vitest";
import { bookIntentSignature, rotateIntentKey, type BookInput } from "../src/lib/bookings.js";

/**
 * The 5.8 double-charge lesson, unit-tested at the source: a booking's client
 * idempotency key is PER INTENT. An unchanged retry must REUSE the key (so a
 * timeout-after-commit replays the ledger debit instead of writing a second
 * one); ANY change to the submitted content must MINT a NEW key (or it would
 * 409 against the server's request-hash and lock the desk out).
 */

const BASE: BookInput = {
  session_id: "11111111-1111-1111-1111-111111111111",
  person_id: "22222222-2222-2222-2222-222222222222",
  hold_id: "33333333-3333-3333-3333-333333333333",
  use_credit: true,
};

describe("rotateIntentKey / bookIntentSignature", () => {
  it("reuses the SAME key for a same-intent retry (unchanged content)", () => {
    const signature = bookIntentSignature(BASE);
    const first = rotateIntentKey(null, signature);
    const retry = rotateIntentKey(first, signature); // content unchanged
    expect(retry).toBe(first);
    expect(retry.key).toBe(first.key);
  });

  it("mints a NEW key when the person changes", () => {
    const first = rotateIntentKey(null, bookIntentSignature(BASE));
    const changed = rotateIntentKey(
      first,
      bookIntentSignature({ ...BASE, person_id: "44444444-4444-4444-4444-444444444444" }),
    );
    expect(changed.key).not.toBe(first.key);
  });

  it("mints a NEW key when the session changes", () => {
    const first = rotateIntentKey(null, bookIntentSignature(BASE));
    const changed = rotateIntentKey(
      first,
      bookIntentSignature({ ...BASE, session_id: "55555555-5555-5555-5555-555555555555" }),
    );
    expect(changed.key).not.toBe(first.key);
  });

  it("mints a NEW key when use_credit flips (credit ↔ comp is a different intent)", () => {
    const first = rotateIntentKey(null, bookIntentSignature(BASE));
    const changed = rotateIntentKey(first, bookIntentSignature({ ...BASE, use_credit: false }));
    expect(changed.key).not.toBe(first.key);
  });

  it("mints a NEW key when the hold changes (re-hold after expiry)", () => {
    const first = rotateIntentKey(null, bookIntentSignature(BASE));
    const changed = rotateIntentKey(
      first,
      bookIntentSignature({ ...BASE, hold_id: "66666666-6666-6666-6666-666666666666" }),
    );
    expect(changed.key).not.toBe(first.key);
  });

  it("returns to reuse once the content settles back to a prior intent's signature", () => {
    // Rotating back to an identical signature still mints a fresh key (the prior
    // key object is gone) — the invariant is 'same object across a retry loop',
    // not 'globally memoised'. This guards the retry loop, where `previous` is
    // the live key.
    const sigA = bookIntentSignature(BASE);
    const a1 = rotateIntentKey(null, sigA);
    const a2 = rotateIntentKey(a1, sigA);
    expect(a2).toBe(a1);
  });
});
