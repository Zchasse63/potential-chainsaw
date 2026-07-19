import { describe, expect, it } from "vitest";
import { runInbox } from "../../src/billing/inbox.js";
import { callsMatching, createBillingPool } from "./helpers.js";

/**
 * POS gift-card issuance seam (Phase 5 · unit 5.7). A stripe-tender pos_checkout
 * defers gift-card issuance to payment success: when payment_intent.succeeded
 * flips the payment to 'succeeded', the inbox locates the POS order behind that
 * intent and issues its un-issued gift-card lines through
 * app.issue_order_gift_cards — GATED on the order's payment being succeeded and
 * IDEMPOTENT (issued_at is null + FOR UPDATE), so at-least-once redelivery issues
 * each card exactly once. A non-POS payment matches no order and is a no-op.
 * NO network, NO DB.
 */

const NOW = new Date("2026-07-19T12:00:00.000Z");

function paymentEvent(eventId: string, intentId: string, type: string): unknown {
  return { id: eventId, type, data: { object: { id: intentId } } };
}

function succeededEvent(intentId: string) {
  return {
    id: "e1",
    event_id: "evt_1",
    payload: paymentEvent("evt_1", intentId, "payment_intent.succeeded"),
    attempts: 0,
    stripe_account_id: "acct_1",
  };
}

describe("inbox · POS gift-card issuance on payment success", () => {
  it("issues the order's gift cards once via app.issue_order_gift_cards", async () => {
    const pool = createBillingPool((text, values) => {
      if (text.includes("update public.payments") && text.includes("returning id")) {
        return { rows: [{ id: "pay_match" }] };
      }
      if (text.includes("from public.stripe_events")) {
        return { rows: [succeededEvent("pi_1")] };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_1") {
        return { rows: [{ status: "processing", amount_cents: 2500 }] };
      }
      // The POS-order lookup behind this intent.
      if (text.includes("from public.pos_orders o") && values?.[0] === "pi_1") {
        return { rows: [{ tenant_id: "t1", id: "order_1" }] };
      }
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toEqual([{ eventId: "evt_1", status: "processed", transition: "succeeded" }]);
    const issue = callsMatching(pool.calls, "app.issue_order_gift_cards")[0];
    expect(issue).toBeDefined();
    expect(issue?.values).toEqual(["t1", "order_1"]);
  });

  it("is a no-op for a non-POS payment (no order behind the intent)", async () => {
    const pool = createBillingPool((text, values) => {
      if (text.includes("update public.payments") && text.includes("returning id")) {
        return { rows: [{ id: "pay_match" }] };
      }
      if (text.includes("from public.stripe_events")) {
        return { rows: [succeededEvent("pi_solo")] };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_solo") {
        return { rows: [{ status: "processing", amount_cents: 9900 }] };
      }
      // No pos_orders row for this intent → issuance must not be attempted.
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toEqual([{ eventId: "evt_1", status: "processed", transition: "succeeded" }]);
    expect(callsMatching(pool.calls, "app.issue_order_gift_cards")).toHaveLength(0);
  });
});
