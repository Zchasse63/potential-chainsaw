import { describe, expect, it } from "vitest";
import { canSend } from "@kelo/comms";
import {
  cancelDunning,
  mapSubscriptionStatus,
  nextTimedTransitions,
  recoverDunning,
  runDunning,
  startDunning,
  syncSubscriptionStatus,
  type DunningStage,
  type DunningState,
} from "../../src/billing/dunning.js";
import { classifyMessageKind } from "../../src/comms/send.js";
import { callsMatching, createBillingPool, type QueryCall } from "./helpers.js";

/**
 * THE DUNNING STATE MACHINE (Phase 5 · unit 5.6). Two clocks share one writer
 * (app.record_dunning_stage): the inbox is EVENT-driven (start/recover/cancel),
 * the billing.dunning processor is TIME-driven (reminder → final → past_due).
 * NO network, NO DB — a recording fake pool + the pure decision function.
 */

const SUB = { id: "sub-1", tenantId: "ten-1" };

/** Read the positional args of a `select app.record_dunning_stage(...)` call. */
function stageCall(call: QueryCall) {
  const v = call.values ?? [];
  return { tenant: v[0], subscription: v[1], stage: v[2] as DunningStage, now: v[3], graceExpires: v[5] };
}

function stageCalls(calls: readonly QueryCall[]): ReturnType<typeof stageCall>[] {
  return callsMatching(calls, "app.record_dunning_stage").map(stageCall);
}

/** A fake pool whose "latest stage" read returns `latest` (or none). */
function poolWithLatestStage(latest: DunningStage | null, subRow: Record<string, unknown> | null = { id: SUB.id, tenant_id: SUB.tenantId }) {
  return createBillingPool((text) => {
    if (text.includes("from public.subscriptions where stripe_subscription_id")) {
      return { rows: subRow === null ? [] : [subRow] };
    }
    if (text.includes("from public.dunning_states") && text.includes("order by")) {
      return { rows: latest === null ? [] : [{ stage: latest }] };
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
describe("nextTimedTransitions — the pure time-driven decision", () => {
  const graceStartedAt = new Date("2026-07-01T00:00:00.000Z");
  const graceExpiresAt = new Date("2026-07-15T00:00:00.000Z"); // +14d

  function state(latestStage: DunningStage): DunningState {
    return { subscriptionId: SUB.id, tenantId: SUB.tenantId, latestStage, graceStartedAt, graceExpiresAt };
  }

  it("does nothing before the reminder is due", () => {
    const now = new Date("2026-07-05T00:00:00.000Z"); // +4d
    expect(nextTimedTransitions(state("grace_started"), now, { reminderAfterDays: 7 })).toEqual([]);
  });

  it("emits reminder_sent once +7d has passed and grace has not expired", () => {
    const now = new Date("2026-07-09T00:00:00.000Z"); // +8d
    expect(nextTimedTransitions(state("grace_started"), now, { reminderAfterDays: 7 })).toEqual([
      "reminder_sent",
    ]);
  });

  it("does not re-emit the reminder once it is the latest stage", () => {
    const now = new Date("2026-07-09T00:00:00.000Z");
    expect(nextTimedTransitions(state("reminder_sent"), now, { reminderAfterDays: 7 })).toEqual([]);
  });

  it("emits final_notice → past_due at grace expiry (from grace_started or reminder_sent)", () => {
    const now = new Date("2026-07-16T00:00:00.000Z"); // > expiry
    expect(nextTimedTransitions(state("grace_started"), now, { reminderAfterDays: 7 })).toEqual([
      "final_notice",
      "past_due",
    ]);
    expect(nextTimedTransitions(state("reminder_sent"), now, { reminderAfterDays: 7 })).toEqual([
      "final_notice",
      "past_due",
    ]);
  });

  it("finishes a crash-left final_notice by emitting past_due", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    expect(nextTimedTransitions(state("final_notice"), now, { reminderAfterDays: 7 })).toEqual([
      "past_due",
    ]);
  });

  it("is terminal at past_due for the time clock (only an event recovers/cancels)", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    expect(nextTimedTransitions(state("past_due"), now, { reminderAfterDays: 7 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the full state-machine walk: fail → grace → reminder → final → past_due", () => {
  const graceExpiresAt = "2026-07-15T00:00:00.000Z";
  const graceStartedAt = "2026-07-01T00:00:00.000Z";

  /** A time-driven claim pool returning one open cycle at `latest`. */
  function claimPool(latest: DunningStage) {
    return createBillingPool((text) => {
      if (text.includes("from public.subscriptions") && text.includes("latest.stage")) {
        return {
          rows: [
            {
              subscription_id: SUB.id,
              tenant_id: SUB.tenantId,
              grace_expires_at: graceExpiresAt,
              latest_stage: latest,
              grace_started_at: graceStartedAt,
            },
          ],
        };
      }
      return undefined;
    });
  }

  it("startDunning opens the grace cycle exactly once (idempotent across retries)", async () => {
    // First failure: no prior stage → grace_started with a +14d expiry.
    const open = poolWithLatestStage(null);
    const started = await startDunning(open, { sub: SUB, now: new Date("2026-07-01T00:00:00.000Z"), graceWindowDays: 14 });
    expect(started).toBe(true);
    const [call] = stageCalls(open.calls);
    expect(call?.stage).toBe("grace_started");
    expect(call?.graceExpires).toBe("2026-07-15T00:00:00.000Z");

    // A later retry's payment_failed while already in grace → no new cycle.
    const retry = poolWithLatestStage("grace_started");
    const again = await startDunning(retry, { sub: SUB, now: new Date("2026-07-03T00:00:00.000Z"), graceWindowDays: 14 });
    expect(again).toBe(false);
    expect(stageCalls(retry.calls)).toHaveLength(0);
  });

  it("the reminder fires at +7d", async () => {
    const pool = claimPool("grace_started");
    const outcomes = await runDunning(pool, { now: () => new Date("2026-07-09T00:00:00.000Z"), reminderAfterDays: 7 });
    expect(outcomes).toEqual([{ subscriptionId: SUB.id, appended: ["reminder_sent"] }]);
    expect(stageCalls(pool.calls).map((c) => c.stage)).toEqual(["reminder_sent"]);
  });

  it("grace expiry drives final_notice then past_due", async () => {
    const pool = claimPool("reminder_sent");
    const outcomes = await runDunning(pool, { now: () => new Date("2026-07-16T00:00:00.000Z") });
    expect(outcomes).toEqual([{ subscriptionId: SUB.id, appended: ["final_notice", "past_due"] }]);
    expect(stageCalls(pool.calls).map((c) => c.stage)).toEqual(["final_notice", "past_due"]);
  });
});

// ---------------------------------------------------------------------------
describe("idempotent re-runs — no duplicate stages or comms", () => {
  it("a re-run before the reminder is due appends nothing", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("from public.subscriptions") && text.includes("latest.stage")) {
        return {
          rows: [
            {
              subscription_id: SUB.id,
              tenant_id: SUB.tenantId,
              grace_expires_at: "2026-07-15T00:00:00.000Z",
              latest_stage: "grace_started",
              grace_started_at: "2026-07-01T00:00:00.000Z",
            },
          ],
        };
      }
      return undefined;
    });
    const outcomes = await runDunning(pool, { now: () => new Date("2026-07-03T00:00:00.000Z"), reminderAfterDays: 7 });
    expect(outcomes).toEqual([]);
    expect(stageCalls(pool.calls)).toHaveLength(0);
  });

  it("a past_due subscription is not re-claimed by the time-driven scan", () => {
    // The claim query filters latest.stage to the still-advancing set — past_due,
    // recovered and cancelled never re-enter the scan.
    const pool = createBillingPool(() => undefined);
    return runDunning(pool, { now: () => new Date("2026-08-01T00:00:00.000Z") }).then(() => {
      const claim = callsMatching(pool.calls, "from public.subscriptions")[0];
      expect(claim?.text).toContain("latest.stage in ('grace_started', 'reminder_sent', 'final_notice')");
    });
  });
});

// ---------------------------------------------------------------------------
describe("recovery at each open stage returns to active + appends 'recovered'", () => {
  for (const stage of ["grace_started", "reminder_sent", "final_notice", "past_due"] as const) {
    it(`recovers from ${stage}`, async () => {
      const pool = poolWithLatestStage(stage);
      const recovered = await recoverDunning(pool, { sub: SUB, now: new Date("2026-07-20T00:00:00.000Z") });
      expect(recovered).toBe(true);
      expect(stageCalls(pool.calls).map((c) => c.stage)).toEqual(["recovered"]);
    });
  }

  it("does NOT recover a subscription that was never in dunning", async () => {
    const pool = poolWithLatestStage(null);
    const recovered = await recoverDunning(pool, { sub: SUB, now: new Date() });
    expect(recovered).toBe(false);
    expect(stageCalls(pool.calls)).toHaveLength(0);
  });

  it("does NOT recover an already-recovered/cancelled cycle", async () => {
    for (const closed of ["recovered", "cancelled"] as const) {
      const pool = poolWithLatestStage(closed);
      expect(await recoverDunning(pool, { sub: SUB, now: new Date() })).toBe(false);
      expect(stageCalls(pool.calls)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe("cancellation — mirrors Stripe, never auto-cancels", () => {
  it("closes an open cycle with 'cancelled'", async () => {
    const pool = poolWithLatestStage("past_due");
    expect(await cancelDunning(pool, { sub: SUB, now: new Date() })).toBe(true);
    expect(stageCalls(pool.calls).map((c) => c.stage)).toEqual(["cancelled"]);
  });

  it("leaves the ledger untouched for a subscription not in dunning", async () => {
    const pool = poolWithLatestStage(null);
    expect(await cancelDunning(pool, { sub: SUB, now: new Date() })).toBe(false);
    expect(stageCalls(pool.calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("mapSubscriptionStatus — widen-then-classify the Stripe status", () => {
  it("classifies the known statuses", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("paused")).toBe("paused");
    expect(mapSubscriptionStatus("canceled")).toBe("cancelled");
    expect(mapSubscriptionStatus("unpaid")).toBe("cancelled");
    expect(mapSubscriptionStatus("incomplete")).toBe("incomplete");
  });

  it("returns null for an unknown status (never throws)", () => {
    expect(mapSubscriptionStatus("some_future_status")).toBeNull();
    expect(mapSubscriptionStatus(undefined)).toBeNull();
  });
});

describe("syncSubscriptionStatus — monotonic terminal, unknown-status widening", () => {
  function syncPool() {
    return createBillingPool(() => undefined);
  }

  it("syncs a mapped status + current_period_end", async () => {
    const pool = syncPool();
    await syncSubscriptionStatus(pool, { sub: SUB, status: "active", currentPeriodEnd: 1_800_000_000 });
    const call = callsMatching(pool.calls, "update public.subscriptions")[0];
    expect(call?.values?.[2]).toBe("active");
    expect(call?.values?.[3]).toBe(new Date(1_800_000_000 * 1_000).toISOString());
  });

  it("passes a null target for an unknown status (the SQL leaves status untouched)", async () => {
    const pool = syncPool();
    await syncSubscriptionStatus(pool, { sub: SUB, status: "some_future_status" });
    const call = callsMatching(pool.calls, "update public.subscriptions")[0];
    expect(call?.values?.[2]).toBeNull();
    // The guarded UPDATE never leaves 'cancelled' and no-ops a null target.
    expect(call?.text).toContain("when s.status = 'cancelled' then s.status");
    expect(call?.text).toContain("when $3::text is null then s.status");
  });

  it("forces 'cancelled' for a deletion regardless of the reported status", async () => {
    const pool = syncPool();
    await syncSubscriptionStatus(pool, { sub: SUB, status: "active", deleted: true });
    expect(callsMatching(pool.calls, "update public.subscriptions")[0]?.values?.[2]).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
describe("dunning comms are kind 'transactional_quiet' — quiet-hours-blocked, consent-exempt", () => {
  const dunningRow = { campaign_key: null, template_key: "dunning_reminder" };

  it("classifies the dunning template as transactional_quiet", () => {
    expect(classifyMessageKind(dunningRow)).toBe("transactional_quiet");
  });

  const base = {
    channel: "email" as const,
    person: { consents: { email: null }, imported: false },
    timezone: "America/New_York",
    quietStart: "21:00",
    quietEnd: "09:00",
  };

  it("is BLOCKED during quiet hours (unlike a plain transactional message)", () => {
    const midnight = new Date("2026-07-19T04:00:00.000Z"); // 00:00 ET
    expect(
      canSend({ ...base, kind: "transactional_quiet", suppressed: false, now: midnight }),
    ).toEqual({ allowed: false, reason: "quiet_hours" });
    // A plain transactional message is exempt from quiet hours — proves the kind matters.
    expect(
      canSend({ ...base, kind: "transactional", suppressed: false, now: midnight }),
    ).toEqual({ allowed: true });
  });

  it("is consent-exempt but suppression-respecting", () => {
    const daytime = new Date("2026-07-19T16:00:00.000Z"); // 12:00 ET
    // No consent on file → still allowed (dunning is transactional).
    expect(
      canSend({ ...base, kind: "transactional_quiet", suppressed: false, now: daytime }),
    ).toEqual({ allowed: true });
    // A hard-bounce suppression still blocks it.
    expect(
      canSend({
        ...base,
        kind: "transactional_quiet",
        suppressed: true,
        suppressionReason: "hard_bounce",
        now: daytime,
      }),
    ).toEqual({ allowed: false, reason: "suppressed" });
  });
});
