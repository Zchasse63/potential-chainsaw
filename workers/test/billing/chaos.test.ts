import { describe, expect, it } from "vitest";
import { createMockStripe } from "@kelo/stripe";
import { runInbox } from "../../src/billing/inbox.js";
import { runOutbox } from "../../src/billing/outbox.js";
import { ChaosStore, type DeliverEventInput } from "./chaos-store.js";

/**
 * THE WEBHOOK CHAOS HARNESS (Phase 5 · unit 5.5) — the §6 phase-5 gate
 * artifact: "webhook chaos harness (dupes, reorder, replay, delay) passes".
 *
 * A canonical HAPPY sequence — intent → succeeded → partial refund → full
 * refund → final state 'refunded' — is fired at the REAL inbox/outbox processor
 * code (against the stateful ChaosStore, no DB, no network) under adversarial
 * delivery SCHEDULES. Every scenario asserts the FINAL STATE INVARIANT (each
 * payment's status + refunded outcome), never the path taken. Deterministic:
 * a seeded PRNG drives every shuffle, and the inbox clock is a fixed instant —
 * no wall clock, no Math.random.
 *
 * OUTBOX COMMAND SHAPE (scenario 4): the harness seeds the REAL RPC contract
 * migration 0034 emits — kind 'create_payment_intent' with payload
 * {amount_cents, currency, customer_id} — and the outbox resolves the customer's
 * stripe_customer_id from public.customers, exactly as production does (F2). A
 * drift-tripwire test (outbox-rpc-contract.test.ts) parses 0034 and asserts the
 * outbox's expected kinds/keys match, so the two sides can never diverge again.
 *
 * REFUND ORDERING (scenario 2): the full event set is permuted, INCLUDING
 * refund-before-succeeded orderings. An early refund cannot land while the
 * payment is still requires_payment/processing, so it RETRIES across drains
 * (F1 — never silently marked 'processed' and lost) and converges once
 * succeeded arrives. Every permutation reaches the canonical final 'refunded'.
 */

const NOW = new Date("2026-07-19T00:00:00.000Z");
const AMOUNT = 5000;
const TENANT = "t1";
const ACCOUNT = "acct_1";

// --- deterministic randomness (injected seeds; never Math.random) --------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

// --- the canonical event vocabulary --------------------------------------------

function succeededEvent(intentId: string, eventId: string): DeliverEventInput {
  return {
    id: `row_${eventId}`,
    eventId,
    accountId: ACCOUNT,
    payload: { id: eventId, type: "payment_intent.succeeded", data: { object: { id: intentId } } },
  };
}

function refundEvent(
  intentId: string,
  eventId: string,
  refunded: boolean,
  amountRefunded: number,
): DeliverEventInput {
  return {
    id: `row_${eventId}`,
    eventId,
    accountId: ACCOUNT,
    payload: {
      id: eventId,
      type: "charge.refunded",
      data: {
        object: { id: `ch_${eventId}`, payment_intent: intentId, amount_refunded: amountRefunded, refunded },
      },
    },
  };
}

/** The three canonical events for one payment (intent id + a unique prefix). */
function canonicalEvents(intentId: string, prefix: string): DeliverEventInput[] {
  return [
    succeededEvent(intentId, `${prefix}_s`),
    refundEvent(intentId, `${prefix}_p`, false, 2000),
    refundEvent(intentId, `${prefix}_f`, true, AMOUNT),
  ];
}

// --- harness helpers -----------------------------------------------------------

/** A store with one already-linked, funded-but-processing payment. */
function storeWithLinkedPayment(intentId: string, paymentId = "pay_1"): ChaosStore {
  const store = new ChaosStore();
  store.addAccount(TENANT, ACCOUNT);
  store.addPayment({
    id: paymentId,
    tenantId: TENANT,
    commandId: null,
    intentId,
    amountCents: AMOUNT,
    status: "processing",
  });
  return store;
}

async function drainInbox(store: ChaosStore): Promise<void> {
  await runInbox(store, { now: () => NOW });
}

// --- SCENARIO 1: exact duplicates of every event -------------------------------

describe("chaos · dupes — unique(event_id) dedupe makes the net effect identical", () => {
  it("delivering every event twice yields the same 'refunded' outcome, each applied once", async () => {
    const intentId = "pi_dupe";
    const store = storeWithLinkedPayment(intentId);
    const events = canonicalEvents(intentId, "d");

    for (const e of events) {
      expect(store.deliverEvent(e)).toBe(true); // first delivery enters the inbox
      expect(store.deliverEvent(e)).toBe(false); // the exact duplicate is dropped
    }
    // Exactly three rows entered the inbox despite six deliveries.
    expect(store.events).toHaveLength(3);

    await drainInbox(store);

    expect(store.paymentByIntent(intentId)?.status).toBe("refunded");
    // Every event processed exactly once; none stranded.
    for (const e of events) {
      expect(store.eventByEventId(e.eventId)?.status).toBe("processed");
    }
  });
});

// --- SCENARIO 2: FULL permutation of ALL THREE events (incl. refund-first) -----

describe("chaos · reorder — every ordering of {succeeded, partial, full} converges to 'refunded'", () => {
  // The whole event set is permuted, including orderings where a refund is
  // DELIVERED before succeeded. Such a refund cannot land on a
  // requires_payment/processing payment: the guarded UPDATE matches 0 rows and
  // the inbox THROWS → the event stays 'received' and RETRIES on a later drain
  // (F1 — the refund is never silently marked 'processed' and lost). Draining
  // repeatedly must converge every permutation to the canonical final state.
  const orders = permutations(["s", "p", "f"] as const);

  for (const order of orders) {
    it(`delivery order [${order.join(", ")}] → refunded, every event processed`, async () => {
      const intentId = "pi_reorder";
      const store = storeWithLinkedPayment(intentId);
      const byKey = {
        s: succeededEvent(intentId, "r_s"),
        p: refundEvent(intentId, "r_p", false, 2000),
        f: refundEvent(intentId, "r_f", true, AMOUNT),
      } as const;

      for (const key of order) store.deliverEvent(byKey[key]);

      // Re-drain until the inbox reaches a fixed point (a refund-before-succeeded
      // retries once, then lands after succeeded is applied). Bounded well under
      // the dead-letter attempt cap.
      for (let pass = 0; pass < 5; pass += 1) {
        await drainInbox(store);
        if (store.events.every((e) => e.status !== "received")) break;
      }

      // Final-state invariant: 'refunded' regardless of the delivery schedule,
      // and no event stranded — all three converged to 'processed'.
      expect(store.paymentByIntent(intentId)?.status).toBe("refunded");
      for (const key of order) {
        expect(store.eventByEventId(byKey[key].eventId)?.status).toBe("processed");
      }
    });
  }
});

// --- SCENARIO 3: replay of the whole sequence after completion -----------------

describe("chaos · replay — re-firing the completed sequence changes nothing", () => {
  it("redelivering every event after completion is a no-op (dedupe drops them)", async () => {
    const intentId = "pi_replay";
    const store = storeWithLinkedPayment(intentId);
    const events = canonicalEvents(intentId, "rp");

    for (const e of events) store.deliverEvent(e);
    await drainInbox(store);
    expect(store.paymentByIntent(intentId)?.status).toBe("refunded");

    // Replay the whole sequence: same event_ids → all dropped by the dedupe.
    for (const e of events) expect(store.deliverEvent(e)).toBe(false);
    await drainInbox(store);

    expect(store.paymentByIntent(intentId)?.status).toBe("refunded");
    // No event was re-opened; all remain terminal 'processed'.
    for (const e of events) {
      expect(store.eventByEventId(e.eventId)?.status).toBe("processed");
    }
  });
});

// --- SCENARIO 4: delay — succeeded arrives before the outbox links the payment --

describe("chaos · delay — bounded-retry heals once the outbox links the payment", () => {
  it("first drain RETRIES the early succeeded; after the outbox links, a later drain lands it", async () => {
    // MockStripe (dry-run) mints deterministic ids: the first createPaymentIntent
    // returns 'dry_pi_1' — the intent id the webhook references.
    const mock = createMockStripe({ seed: 0 });
    const intentId = "dry_pi_1";

    const store = new ChaosStore();
    store.addAccount(TENANT, ACCOUNT);
    // A customer with a Stripe id on file (F2: the outbox resolves customer_id →
    // stripe_customer_id from public.customers).
    store.addCustomer(TENANT, "cust_1", "cus_stripe_1");
    // The RPC (migration 0034) has recorded the intent with its REAL contract: a
    // pending create_payment_intent command {amount_cents, currency, customer_id}
    // + an UNLINKED payment. This is the exact shape 0034 emits (F2).
    store.addCommand({
      id: "c1",
      tenantId: TENANT,
      kind: "create_payment_intent",
      idempotencyKey: "idem-1",
      payload: { amount_cents: AMOUNT, currency: "usd", customer_id: "cust_1" },
    });
    store.addPayment({
      id: "pay_1",
      tenantId: TENANT,
      commandId: "c1",
      intentId: null,
      amountCents: AMOUNT,
      status: "requires_payment",
    });

    // The succeeded webhook arrives EARLY — before the outbox has linked pay_1.
    store.deliverEvent(succeededEvent(intentId, "e_s"));

    // Drain #1: the inbox can't find a payment for dry_pi_1 yet → RETRY (the
    // event stays 'received', attempts bumped, no dead-letter).
    await drainInbox(store);
    expect(store.paymentById("pay_1")?.status).toBe("requires_payment");
    const afterFirst = store.eventByEventId("e_s");
    expect(afterFirst?.status).toBe("received");
    expect(afterFirst?.attempts).toBe(1);

    // The outbox now delivers the command and LINKS the intent id to pay_1.
    await runOutbox(store, { makeClient: () => mock.client });
    expect(store.paymentById("pay_1")?.stripe_payment_intent_id).toBe(intentId);

    // Drain #2: the retried event now finds its payment and LANDS ('processed').
    await drainInbox(store);
    expect(store.paymentByIntent(intentId)?.status).toBe("succeeded");
    expect(store.eventByEventId("e_s")?.status).toBe("processed");

    // The rest of the canonical sequence now completes normally.
    store.deliverEvent(refundEvent(intentId, "e_p", false, 2000));
    store.deliverEvent(refundEvent(intentId, "e_f", true, AMOUNT));
    await drainInbox(store);
    expect(store.paymentByIntent(intentId)?.status).toBe("refunded");
  });
});

// --- SCENARIO 5: interleaved cross-payment traffic -----------------------------

describe("chaos · interleave — two payments' events shuffled together, no cross-talk", () => {
  const seeds = [1, 7, 42, 1337, 99999];

  for (const seed of seeds) {
    it(`shuffle seed ${seed}: each payment reaches its own 'refunded' outcome`, async () => {
      const store = new ChaosStore();
      store.addAccount(TENANT, ACCOUNT);
      store.addPayment({
        id: "pay_a",
        tenantId: TENANT,
        commandId: null,
        intentId: "pi_a",
        amountCents: AMOUNT,
        status: "processing",
      });
      store.addPayment({
        id: "pay_b",
        tenantId: TENANT,
        commandId: null,
        intentId: "pi_b",
        amountCents: AMOUNT,
        status: "processing",
      });

      // Shuffle all six events together, but preserve each payment's internal
      // causal order (succeeded → partial → full) — the guarantee under test is
      // cross-payment isolation, not that a refund can precede its own success.
      const a = canonicalEvents("pi_a", "a");
      const b = canonicalEvents("pi_b", "b");
      const rnd = mulberry32(seed);
      const interleaving = shuffled([...a.map((_, i) => ["a", i] as const), ...b.map((_, i) => ["b", i] as const)], rnd)
        // Stable-sort each stream back into causal order while keeping the
        // interleave: assign each stream's next event as slots are consumed.
        .reduce<{ order: DeliverEventInput[]; ai: number; bi: number }>(
          (acc, [stream]) => {
            if (stream === "a") {
              acc.order.push(a[acc.ai]!);
              acc.ai += 1;
            } else {
              acc.order.push(b[acc.bi]!);
              acc.bi += 1;
            }
            return acc;
          },
          { order: [], ai: 0, bi: 0 },
        ).order;

      for (const e of interleaving) store.deliverEvent(e);
      await drainInbox(store);

      expect(store.paymentByIntent("pi_a")?.status).toBe("refunded");
      expect(store.paymentByIntent("pi_b")?.status).toBe("refunded");
    });
  }
});
