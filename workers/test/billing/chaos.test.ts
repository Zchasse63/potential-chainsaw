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
 * NOTE ON THE OUTBOX COMMAND SHAPE (scenario 4): the outbox processor dispatches
 * on command.kind === 'payment_intent' with payload {amount, currency}; the
 * harness seeds exactly that contract so the REAL delivery+link path runs. (The
 * create_payment_intent RPC in migration 0034 currently emits a different kind
 * and payload — flagged separately; verify_money's stuck-command check is the
 * production signal for that gap. It does not affect this gate.)
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

// --- SCENARIO 2: full permutation of the refund events -------------------------

describe("chaos · reorder — the monotonic guard keeps the final state 'refunded'", () => {
  const refundOrders = permutations(["p", "f"] as const);

  for (const order of refundOrders) {
    it(`succeeded then refunds in order [${order.join(", ")}] → refunded`, async () => {
      const intentId = "pi_reorder";
      const store = storeWithLinkedPayment(intentId);
      const partial = refundEvent(intentId, "r_p", false, 2000);
      const full = refundEvent(intentId, "r_f", true, AMOUNT);
      const byKey = { p: partial, f: full } as const;

      // Succeeded must precede the refunds (the payment must be succeeded to
      // refund); the refund events themselves arrive in the permuted order.
      store.deliverEvent(succeededEvent(intentId, "r_s"));
      for (const key of order) store.deliverEvent(byKey[key]);

      await drainInbox(store);

      // Whether the full refund lands before or after the partial, 'refunded'
      // is terminal and never regresses to 'partially_refunded'.
      expect(store.paymentByIntent(intentId)?.status).toBe("refunded");
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
    // The RPC has recorded the intent: a pending command + an UNLINKED payment.
    store.addCommand({
      id: "c1",
      tenantId: TENANT,
      kind: "payment_intent",
      idempotencyKey: "idem-1",
      payload: { amount: AMOUNT, currency: "usd" },
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
