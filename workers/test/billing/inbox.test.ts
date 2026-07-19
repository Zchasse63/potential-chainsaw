import { describe, expect, it } from "vitest";
import { runInbox } from "../../src/billing/inbox.js";
import { callsMatching, createBillingPool, type QueryCall } from "./helpers.js";

/**
 * THE STRIPE INBOX PROCESSOR (Phase 5 · unit 5.3) — the confirmation engine.
 * The webhook is the ONLY writer of a terminal money state: this processor
 * consumes the stripe_events TABLE and flips payments. Idempotent, error-
 * isolated, quarantine-by-ignore. NO network, NO DB.
 */

const NOW = new Date("2026-07-18T12:00:00.000Z");

/** A stripe_events row as claimed (id, event_id, payload). */
function eventRow(
  id: string,
  eventId: string,
  payload: unknown,
  opts: { attempts?: number; accountId?: string | null } = {},
) {
  return {
    id,
    event_id: eventId,
    payload,
    attempts: opts.attempts ?? 0,
    stripe_account_id: opts.accountId ?? null,
  };
}

function paymentEvent(eventId: string, intentId: string, type: string): unknown {
  return { id: eventId, type, data: { object: { id: intentId } } };
}

/** Read the positional args of the payments UPDATE (status, intentId, allowed). */
function paymentUpdate(call: QueryCall) {
  const v = call.values ?? [];
  return { target: v[0], intentId: v[1], allowedPrior: v[2] };
}

/** Read the stripe_events finalize UPDATE (status, processedAt, error, id). */
function eventUpdate(call: QueryCall) {
  const v = call.values ?? [];
  return { status: v[0], processedAt: v[1], error: v[2], id: v[3] };
}

describe("payment_intent.succeeded", () => {
  it("flips the payment to 'succeeded' and marks the event processed", async () => {
    const pool = createBillingPool((text, values) => {
      if (text.includes("from public.stripe_events")) {
        return {
          rows: [
            eventRow("e1", "evt_1", paymentEvent("evt_1", "pi_1", "payment_intent.succeeded")),
          ],
        };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_1") {
        return { rows: [{ status: "processing", amount_cents: 5000 }] };
      }
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toEqual([{ eventId: "evt_1", status: "processed", transition: "succeeded" }]);
    const update = paymentUpdate(callsMatching(pool.calls, "update public.payments")[0]!);
    expect(update.target).toBe("succeeded");
    expect(update.intentId).toBe("pi_1");
    // 'failed' is an allowed prior (a retried intent), but never a refunded one.
    expect(update.allowedPrior).toContain("failed");
    expect(update.allowedPrior).not.toContain("refunded");

    const finalize = eventUpdate(callsMatching(pool.calls, "update public.stripe_events")[0]!);
    expect(finalize.status).toBe("processed");
    expect(finalize.error).toBeNull();
    expect(finalize.processedAt).toBe(NOW.toISOString());
    expect(finalize.id).toBe("e1");
  });

  it("is idempotent: re-applying to an already-succeeded payment stays a no-op", async () => {
    const pool = createBillingPool((text, values) => {
      if (text.includes("from public.stripe_events")) {
        return {
          rows: [
            eventRow("e1", "evt_1", paymentEvent("evt_1", "pi_1", "payment_intent.succeeded")),
          ],
        };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_1") {
        return { rows: [{ status: "succeeded", amount_cents: 5000 }] };
      }
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes[0]?.status).toBe("processed");
    // The guarded UPDATE re-sets succeeded→succeeded (allowed prior includes the
    // target), so the transition itself is safe to replay.
    const update = paymentUpdate(callsMatching(pool.calls, "update public.payments")[0]!);
    expect(update.target).toBe("succeeded");
    expect(update.allowedPrior).toContain("succeeded");
  });

  it("claims only 'received' events — an empty inbox does nothing", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("from public.stripe_events")) return { rows: [] };
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toEqual([]);
    expect(callsMatching(pool.calls, "update public.payments")).toHaveLength(0);
    expect(callsMatching(pool.calls, "update public.stripe_events")).toHaveLength(0);
    // The claim filters on the received status.
    expect(callsMatching(pool.calls, "where status = 'received'")).toHaveLength(1);
  });
});

describe("payment_intent.payment_failed", () => {
  it("flips the payment to 'failed' without regressing a success", async () => {
    const pool = createBillingPool((text, values) => {
      if (text.includes("from public.stripe_events")) {
        return {
          rows: [
            eventRow("e1", "evt_1", paymentEvent("evt_1", "pi_1", "payment_intent.payment_failed")),
          ],
        };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_1") {
        return { rows: [{ status: "processing", amount_cents: 5000 }] };
      }
      return undefined;
    });

    await runInbox(pool, { now: () => NOW });

    const update = paymentUpdate(callsMatching(pool.calls, "update public.payments")[0]!);
    expect(update.target).toBe("failed");
    expect(update.allowedPrior).not.toContain("succeeded");
    expect(update.allowedPrior).not.toContain("refunded");
  });
});

describe("charge.refunded — full vs partial by amount", () => {
  function refundEvent(refunded: boolean, amountRefunded: number): unknown {
    return {
      id: "evt_r",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          amount_refunded: amountRefunded,
          refunded,
        },
      },
    };
  }

  function poolFor(event: unknown) {
    return createBillingPool((text, values) => {
      if (text.includes("from public.stripe_events")) {
        return { rows: [eventRow("e1", "evt_r", event)] };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_1") {
        return { rows: [{ status: "succeeded", amount_cents: 5000 }] };
      }
      return undefined;
    });
  }

  it("a full refund maps to 'refunded' (idempotent from an already-refunded prior)", async () => {
    const pool = poolFor(refundEvent(true, 5000));
    const outcomes = await runInbox(pool, { now: () => NOW });
    expect(outcomes[0]).toEqual({ eventId: "evt_r", status: "processed", transition: "refunded" });
    const update = paymentUpdate(callsMatching(pool.calls, "update public.payments")[0]!);
    expect(update.target).toBe("refunded");
    // A full refund is idempotent — replaying it from 'refunded' is a no-op.
    expect(update.allowedPrior).toContain("refunded");
  });

  it("a partial refund maps to 'partially_refunded' and NEVER regresses a full refund", async () => {
    const pool = poolFor(refundEvent(false, 2000));
    const outcomes = await runInbox(pool, { now: () => NOW });
    expect(outcomes[0]?.transition).toBe("partially_refunded");
    const update = paymentUpdate(callsMatching(pool.calls, "update public.payments")[0]!);
    expect(update.target).toBe("partially_refunded");
    expect(update.allowedPrior).toContain("succeeded");
    // THE MONOTONIC GUARD (review fix): a late partial-refund event must NOT be
    // allowed to regress an already-'refunded' payment when Stripe delivers the
    // completing event first. 'refunded' is terminal and absent from the
    // allowed priors for a partial target.
    expect(update.allowedPrior).not.toContain("refunded");
  });
});

describe("unknown / unhandled kinds", () => {
  it("marks an unknown event 'ignored' and writes NO payment", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("from public.stripe_events")) {
        return {
          rows: [
            eventRow("e1", "evt_x", {
              id: "evt_x",
              type: "charge.dispute.created",
              data: { object: { id: "dp_1" } },
            }),
          ],
        };
      }
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toEqual([{ eventId: "evt_x", status: "ignored" }]);
    expect(callsMatching(pool.calls, "update public.payments")).toHaveLength(0);
    expect(eventUpdate(callsMatching(pool.calls, "update public.stripe_events")[0]!).status).toBe(
      "ignored",
    );
  });
});

describe("error isolation — one bad event never blinds the others", () => {
  it("records 'error' for an event whose payment is missing; the next event still processes", async () => {
    const pool = createBillingPool((text, values) => {
      if (text.includes("from public.stripe_events")) {
        return {
          rows: [
            eventRow(
              "e1",
              "evt_miss",
              paymentEvent("evt_miss", "pi_missing", "payment_intent.succeeded"),
            ),
            eventRow("e2", "evt_ok", paymentEvent("evt_ok", "pi_ok", "payment_intent.succeeded")),
          ],
        };
      }
      if (text.includes("from public.payments") && values?.[0] === "pi_ok") {
        return { rows: [{ status: "processing", amount_cents: 5000 }] };
      }
      // pi_missing → no payment row.
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toHaveLength(2);
    // A missing payment is TRANSIENT (the outbox may not have linked it yet) —
    // the first attempt RETRIES (event stays 'received'), it does NOT dead-letter.
    expect(outcomes[0]).toMatchObject({ eventId: "evt_miss", status: "retrying" });
    expect(outcomes[1]).toEqual({
      eventId: "evt_ok",
      status: "processed",
      transition: "succeeded",
    });

    // e1's update bumped attempts + recorded the error but did NOT set status.
    const retryUpdate = callsMatching(
      pool.calls,
      "update public.stripe_events\n       set attempts",
    ).find((call) => (call.values ?? [])[2] === "e1");
    expect(retryUpdate).toBeDefined();
    expect((retryUpdate?.values ?? [])[0]).toBe(1); // attempts → 1
    expect(String((retryUpdate?.values ?? [])[1])).toContain("no payment for payment_intent pi_missing");
    // No dead-letter alert on the first attempt.
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);

    // The second event's money transition still ran (error isolation preserved).
    const okUpdate = callsMatching(pool.calls, "update public.payments").find(
      (call) => (call.values ?? [])[1] === "pi_ok",
    );
    expect(okUpdate).toBeDefined();
  });

  it("dead-letters to 'error' + a critical alert after the max attempts", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("from public.stripe_events")) {
        return {
          rows: [
            // Already retried 4×; this 5th failure hits maxAttempts (default 5).
            eventRow("e9", "evt_dead", paymentEvent("evt_dead", "pi_gone", "payment_intent.succeeded"), {
              attempts: 4,
              accountId: "acct_123",
            }),
          ],
        };
      }
      // pi_gone → still no payment row (truly stranded).
      return undefined;
    });

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes[0]).toMatchObject({ eventId: "evt_dead", status: "error" });
    // Terminal 'error' set on the event.
    const deadUpdate = callsMatching(pool.calls, "set status = 'error'").find(
      (call) => (call.values ?? [])[3] === "e9",
    );
    expect(deadUpdate).toBeDefined();
    expect((deadUpdate?.values ?? [])[0]).toBe(5); // attempts → 5
    // A critical operator alert is raised (tenant resolved via the account).
    const alert = callsMatching(pool.calls, "insert into public.alerts")[0];
    expect(alert).toBeDefined();
    expect((alert?.values ?? [])[0]).toBe("acct_123"); // resolved via stripe_accounts
  });
});
