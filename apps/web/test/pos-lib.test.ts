import { describe, expect, it, vi } from "vitest";

/**
 * Re-review blocker B1: the POS lib must unwrap the routes' NESTED envelope
 * payloads (c.var.ok({ checkout }) / c.var.ok({ redemption })) — returning the
 * envelope data verbatim rendered 'Order undefined' and silently DROPPED the
 * one-time gift-card codes (unrecoverable: the server stores only hashes).
 * These tests feed the REAL route response shape through the lib.
 */

vi.mock("../src/lib/api.js", () => ({
  postEnvelope: vi.fn(),
}));

import { postEnvelope } from "../src/lib/api.js";
import { checkout, redeemGiftCard } from "../src/lib/pos.js";

const envelope = (data: unknown) => ({
  data,
  meta: {
    as_of: "2026-07-19T12:00:00.000Z",
    source: "native",
    stale: false,
    definition_version: null,
    correlation_id: "test-corr-1",
  },
});

describe("pos lib — envelope unwrapping matches the real route shapes (B1)", () => {
  it("checkout() unwraps { checkout: … } and surfaces the one-time gift-card codes", async () => {
    vi.mocked(postEnvelope).mockResolvedValueOnce(
      envelope({
        checkout: {
          payment_id: "pay-1",
          order_id: "ord-1",
          gift_card_codes: [{ card_id: "gc-1", code: "ABCD-EFGH-JKMN-PQRS" }],
        },
      }),
    );
    const result = await checkout(
      "token",
      { person_id: null, tender: "cash", lines: [{ kind: "gift_card", ref_id: "gp-1", qty: 1 }] },
      "intent-key-1",
    );
    expect(result.order_id).toBe("ord-1");
    expect(result.gift_card_codes?.[0]?.code).toBe("ABCD-EFGH-JKMN-PQRS");
  });

  it("redeemGiftCard() unwraps { redemption: … } and surfaces the balance", async () => {
    vi.mocked(postEnvelope).mockResolvedValueOnce(
      envelope({
        redemption: { gift_card_id: "gc-1", redeemed_cents: 2000, balance_cents: 3000 },
      }),
    );
    const result = await redeemGiftCard("token", "ABCD-EFGH", 2000, "intent-key-2");
    expect(result.redeemed_cents).toBe(2000);
    expect(result.balance_cents).toBe(3000);
  });
});
