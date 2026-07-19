import { describe, expect, it } from "vitest";
import { mapStripeEvent } from "../src/index.js";

describe("mapStripeEvent — classify the Phase-5 types", () => {
  it("classifies payment_intent.succeeded", () => {
    expect(
      mapStripeEvent({
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_1", amount: 2500, currency: "usd", status: "succeeded" } },
      }),
    ).toEqual({
      kind: "payment_succeeded",
      eventId: "evt_1",
      paymentIntentId: "pi_1",
      amount: 2500,
      currency: "usd",
      status: "succeeded",
    });
  });

  it("classifies payment_intent.payment_failed with the failure reason", () => {
    expect(
      mapStripeEvent({
        id: "evt_2",
        type: "payment_intent.payment_failed",
        data: {
          object: {
            id: "pi_2",
            last_payment_error: { code: "card_declined", message: "Your card was declined." },
          },
        },
      }),
    ).toEqual({
      kind: "payment_failed",
      eventId: "evt_2",
      paymentIntentId: "pi_2",
      failureCode: "card_declined",
      failureMessage: "Your card was declined.",
    });
  });

  it("classifies charge.refunded", () => {
    expect(
      mapStripeEvent({
        id: "evt_3",
        type: "charge.refunded",
        data: {
          object: { id: "ch_1", payment_intent: "pi_3", amount_refunded: 2500, refunded: true },
        },
      }),
    ).toEqual({
      kind: "charge_refunded",
      eventId: "evt_3",
      chargeId: "ch_1",
      paymentIntentId: "pi_3",
      amountRefunded: 2500,
      refunded: true,
    });
  });

  it("classifies customer.subscription.updated", () => {
    expect(
      mapStripeEvent({
        id: "evt_4",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_1", status: "past_due", customer: "cus_1" } },
      }),
    ).toEqual({
      kind: "subscription_updated",
      eventId: "evt_4",
      subscriptionId: "sub_1",
      status: "past_due",
      customerId: "cus_1",
    });
  });

  it("classifies invoice.payment_failed", () => {
    expect(
      mapStripeEvent({
        id: "evt_5",
        type: "invoice.payment_failed",
        data: {
          object: { id: "in_1", subscription: "sub_1", customer: "cus_1", attempt_count: 2 },
        },
      }),
    ).toEqual({
      kind: "invoice_payment_failed",
      eventId: "evt_5",
      invoiceId: "in_1",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      attemptCount: 2,
    });
  });
});

describe("mapStripeEvent — widen-then-classify (quarantine-by-ignore, never throw)", () => {
  it("maps an unknown event type to ignored with its rawType", () => {
    expect(
      mapStripeEvent({ id: "evt_x", type: "checkout.session.completed", data: { object: {} } }),
    ).toEqual({ kind: "ignored", eventId: "evt_x", rawType: "checkout.session.completed" });
  });

  it("ignores an event missing id, data.object, or the object id — without throwing", () => {
    expect(mapStripeEvent({ type: "payment_intent.succeeded", data: { object: { id: "pi" } } })).toEqual(
      { kind: "ignored", eventId: undefined, rawType: "payment_intent.succeeded" },
    );
    expect(mapStripeEvent({ id: "evt", type: "payment_intent.succeeded" })).toEqual({
      kind: "ignored",
      eventId: "evt",
      rawType: "payment_intent.succeeded",
    });
    expect(
      mapStripeEvent({ id: "evt", type: "payment_intent.succeeded", data: { object: {} } }),
    ).toEqual({ kind: "ignored", eventId: "evt", rawType: "payment_intent.succeeded" });
  });

  it("does not throw on junk input", () => {
    expect(mapStripeEvent(null)).toEqual({ kind: "ignored", eventId: undefined, rawType: "" });
    expect(mapStripeEvent("nonsense")).toEqual({ kind: "ignored", eventId: undefined, rawType: "" });
    expect(mapStripeEvent(42)).toEqual({ kind: "ignored", eventId: undefined, rawType: "" });
  });
});
