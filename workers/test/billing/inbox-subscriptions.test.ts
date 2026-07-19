import { describe, expect, it } from "vitest";
import { runInbox } from "../../src/billing/inbox.js";
import { callsMatching, createBillingPool, type QueryCall, type Responder } from "./helpers.js";

/**
 * THE INBOX'S SUBSCRIPTION + DUNNING TRANSITIONS (Phase 5 · unit 5.6). The
 * signed webhook is the AUTHORITY: only the inbox syncs a subscription's status
 * and opens/closes a dunning cycle. Monotonic, idempotent, quarantine-by-ignore.
 * NO network, NO DB.
 */

const NOW = new Date("2026-07-19T12:00:00.000Z");

function event(id: string, type: string, object: Record<string, unknown>): unknown {
  return { id, type, data: { object } };
}

function eventRow(id: string, eventId: string, payload: unknown) {
  return { id, event_id: eventId, payload, attempts: 0, stripe_account_id: "acct_1" };
}

/** Build a pool that returns one claimed event + a programmable extra responder. */
function inboxPool(payload: unknown, extra: Responder = () => undefined) {
  return createBillingPool((text, values, calls) => {
    if (text.includes("from public.stripe_events")) {
      return { rows: [eventRow("e1", "evt_1", payload)] };
    }
    return extra(text, values, calls);
  });
}

/** A subscription lookup responder returning a tracked sub (or none). */
function subLookup(found: boolean): Responder {
  return (text) =>
    text.includes("from public.subscriptions where stripe_subscription_id")
      ? { rows: found ? [{ id: "sub-1", tenant_id: "ten-1" }] : [] }
      : undefined;
}

function latestStage(stage: string | null): Responder {
  return (text) =>
    text.includes("from public.dunning_states") && text.includes("order by")
      ? { rows: stage === null ? [] : [{ stage }] }
      : undefined;
}

function chain(...responders: Responder[]): Responder {
  return (text, values, calls) => {
    for (const r of responders) {
      const out = r(text, values, calls);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}

function recordStageCalls(calls: readonly QueryCall[]) {
  return callsMatching(calls, "app.record_dunning_stage").map((c) => (c.values ?? [])[2]);
}

// ---------------------------------------------------------------------------
describe("customer.subscription.updated — status sync", () => {
  it("syncs status + current_period_end and marks the event processed", async () => {
    const pool = inboxPool(
      event("evt_1", "customer.subscription.updated", {
        id: "sub_stripe_1",
        status: "active",
        customer: "cus_1",
        current_period_end: 1_800_000_000,
      }),
      subLookup(true),
    );

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes).toEqual([
      { eventId: "evt_1", status: "processed", transition: "subscription_synced" },
    ]);
    const sync = callsMatching(pool.calls, "update public.subscriptions")[0];
    expect(sync?.values?.[2]).toBe("active");
  });

  it("ignores an update for a subscription we do not track (no dead-letter)", async () => {
    const pool = inboxPool(
      event("evt_1", "customer.subscription.updated", { id: "sub_unknown", status: "active" }),
      subLookup(false),
    );
    const outcomes = await runInbox(pool, { now: () => NOW });
    expect(outcomes).toEqual([{ eventId: "evt_1", status: "ignored" }]);
    expect(callsMatching(pool.calls, "update public.subscriptions")).toHaveLength(0);
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
  });

  it("widens an unknown Stripe status (null target) without throwing", async () => {
    const pool = inboxPool(
      event("evt_1", "customer.subscription.updated", { id: "sub_stripe_1", status: "a_new_stripe_status" }),
      subLookup(true),
    );
    const outcomes = await runInbox(pool, { now: () => NOW });
    expect(outcomes[0]?.status).toBe("processed");
    expect(callsMatching(pool.calls, "update public.subscriptions")[0]?.values?.[2]).toBeNull();
  });
});

describe("customer.subscription.deleted — mirror the cancellation", () => {
  it("forces status 'cancelled' and closes an open dunning cycle", async () => {
    const pool = inboxPool(
      event("evt_1", "customer.subscription.deleted", { id: "sub_stripe_1", status: "canceled" }),
      chain(subLookup(true), latestStage("past_due")),
    );

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes[0]).toEqual({
      eventId: "evt_1",
      status: "processed",
      transition: "subscription_cancelled",
    });
    expect(callsMatching(pool.calls, "update public.subscriptions")[0]?.values?.[2]).toBe("cancelled");
    expect(recordStageCalls(pool.calls)).toEqual(["cancelled"]);
  });
});

describe("invoice.payment_failed — the dunning trigger", () => {
  it("opens a grace cycle (grace_started) for a tracked subscription", async () => {
    const pool = inboxPool(
      event("evt_1", "invoice.payment_failed", { id: "in_1", subscription: "sub_stripe_1", attempt_count: 1 }),
      chain(subLookup(true), latestStage(null)),
    );

    const outcomes = await runInbox(pool, { now: () => NOW });

    expect(outcomes[0]).toEqual({
      eventId: "evt_1",
      status: "processed",
      transition: "dunning_grace_started",
    });
    const stage = callsMatching(pool.calls, "app.record_dunning_stage")[0];
    expect(stage?.values?.[2]).toBe("grace_started");
    // grace_expires_at = failure + 14d (default).
    expect(stage?.values?.[5]).toBe(new Date(NOW.getTime() + 14 * 86_400_000).toISOString());
  });

  it("is idempotent across retries: a failure while already in grace opens no new cycle", async () => {
    const pool = inboxPool(
      event("evt_1", "invoice.payment_failed", { id: "in_2", subscription: "sub_stripe_1" }),
      chain(subLookup(true), latestStage("grace_started")),
    );
    await runInbox(pool, { now: () => NOW });
    expect(callsMatching(pool.calls, "app.record_dunning_stage")).toHaveLength(0);
  });
});

describe("invoice.payment_succeeded — the recovery trigger", () => {
  it("recovers an open cycle back to active", async () => {
    const pool = inboxPool(
      event("evt_1", "invoice.payment_succeeded", { id: "in_3", subscription: "sub_stripe_1" }),
      chain(subLookup(true), latestStage("past_due")),
    );
    const outcomes = await runInbox(pool, { now: () => NOW });
    expect(outcomes[0]?.transition).toBe("dunning_recovered");
    expect(recordStageCalls(pool.calls)).toEqual(["recovered"]);
  });

  it("no-ops for a subscription not in dunning", async () => {
    const pool = inboxPool(
      event("evt_1", "invoice.payment_succeeded", { id: "in_4", subscription: "sub_stripe_1" }),
      chain(subLookup(true), latestStage(null)),
    );
    await runInbox(pool, { now: () => NOW });
    expect(callsMatching(pool.calls, "app.record_dunning_stage")).toHaveLength(0);
  });
});
