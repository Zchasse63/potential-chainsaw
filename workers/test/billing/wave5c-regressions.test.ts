import { describe, expect, it } from "vitest";
import { mapStripeEvent } from "@kelo/stripe";
import { nextAllowedSendAt } from "@kelo/comms";
import {
  recordStage,
  resolveDunningGraceDays,
  syncSubscriptionStatus,
} from "../../src/billing/dunning.js";
import { callsMatching, createBillingPool } from "./helpers.js";

/**
 * WAVE-5C RE-REVIEW REGRESSIONS (F5/F6/F7). Each of these fails against the
 * pre-fix code: F5's deferral would enqueue at now() and the reminder would be
 * terminally quiet-hours-skipped (incl. the DST fall-back hole); F6's sync had
 * no event-time gate (and then a same-second lost-cancellation hazard); F7's
 * grace was hardcoded 14. NO network, NO DB.
 */

const SUB = { id: "sub-1", tenantId: "ten-1" };

// ---------------------------------------------------------------------------
describe("F5 — nextAllowedSendAt defers into the true studio-local window", () => {
  it("passes through unchanged outside quiet hours", () => {
    // 2026-07-15T16:00Z = 12:00 EDT — open hours.
    const now = new Date("2026-07-15T16:00:00.000Z");
    expect(nextAllowedSendAt(now, "America/New_York").toISOString()).toBe(now.toISOString());
  });

  it("defers a quiet-hours instant to quietEnd studio-local", () => {
    // 2026-07-15T06:00Z = 02:00 EDT (quiet) → 09:00 EDT = 13:00Z.
    const now = new Date("2026-07-15T06:00:00.000Z");
    expect(nextAllowedSendAt(now, "America/New_York").toISOString()).toBe(
      "2026-07-15T13:00:00.000Z",
    );
  });

  it("DST fall-back: the deferred instant is re-checked, never landing at 08:00 local", () => {
    // 2025-11-02 is the US fall-back. 05:00Z = 01:00 EDT (quiet). A constant-
    // offset +480min lands at 13:00Z = 08:00 EST — STILL quiet (the hole).
    // The bounded re-check must walk forward to 09:00 EST = 14:00Z.
    const now = new Date("2025-11-02T05:00:00.000Z");
    const deferred = nextAllowedSendAt(now, "America/New_York");
    expect(deferred.toISOString()).toBe("2025-11-02T14:00:00.000Z");
  });

  it("recordStage passes the DEFERRED run_at as param 8 for a comms-bearing stage", async () => {
    // Studio tz America/New_York; a grace_started recorded at 06:00Z (02:00 EDT,
    // quiet) must enqueue its comms job at 13:00Z (09:00 EDT), not at now.
    const pool = createBillingPool((text) => {
      if (text.includes("from public.tenants") && text.includes("timezone")) {
        return { rows: [{ timezone: "America/New_York", settings: null }] };
      }
      if (text.includes("from public.locations")) {
        return { rows: [{ timezone: "America/New_York" }] };
      }
      return undefined;
    });
    const now = new Date("2026-07-15T06:00:00.000Z");
    await recordStage(pool, {
      tenantId: SUB.tenantId,
      subscriptionId: SUB.id,
      stage: "grace_started",
      now,
      graceExpiresAt: new Date("2026-07-29T06:00:00.000Z"),
    });
    const call = callsMatching(pool.calls, "app.record_dunning_stage")[0];
    expect(call).toBeDefined();
    const runAt = String((call?.values ?? [])[7]);
    expect(runAt).toBe("2026-07-15T13:00:00.000Z"); // deferred, not `now`
    expect((call?.values ?? [])[4]).toBe(now.toISOString()); // occurred_at stays truthful
  });

  it("recordStage does NOT defer a non-comms stage (past_due records at now)", async () => {
    const pool = createBillingPool(() => undefined);
    const now = new Date("2026-07-15T06:00:00.000Z");
    await recordStage(pool, {
      tenantId: SUB.tenantId,
      subscriptionId: SUB.id,
      stage: "past_due",
      now,
    });
    const call = callsMatching(pool.calls, "app.record_dunning_stage")[0];
    expect(String((call?.values ?? [])[7])).toBe(now.toISOString());
  });
});

// ---------------------------------------------------------------------------
describe("F6 — subscription event-time monotonicity", () => {
  it("mapStripeEvent exposes the event envelope's created as eventCreatedAt", () => {
    const action = mapStripeEvent({
      id: "evt_s1",
      type: "customer.subscription.updated",
      created: 1_760_000_123,
      data: { object: { id: "sub_stripe_1", status: "active" } },
    });
    expect(action.kind).toBe("subscription_updated");
    if (action.kind === "subscription_updated") {
      expect(action.eventCreatedAt).toBe(1_760_000_123);
    }
  });

  it("a non-terminal update is gated with strict < on last_event_at", async () => {
    const pool = createBillingPool(() => undefined);
    await syncSubscriptionStatus(pool, {
      sub: SUB,
      status: "active",
      eventCreatedAt: 1_760_000_100,
    });
    const call = callsMatching(pool.calls, "update public.subscriptions")[0];
    expect(call).toBeDefined();
    // $6 (isTerminal) is false → the strict `<` branch of the CASE gates it.
    expect((call?.values ?? [])[5]).toBe(false);
    expect(call?.text).toContain("s.last_event_at < to_timestamp($5::double precision)");
  });

  it("a terminal cancellation uses <= so a same-second deleted event is never dropped", async () => {
    // Stripe `created` is 1-second granular: updated + deleted in the SAME
    // second must both apply when deleted lands second. The terminal target
    // takes the `<=` branch ($6 true); 'cancelled' is already monotone.
    const pool = createBillingPool(() => undefined);
    await syncSubscriptionStatus(pool, {
      sub: SUB,
      status: "canceled",
      deleted: true,
      eventCreatedAt: 1_760_000_100,
    });
    const call = callsMatching(pool.calls, "update public.subscriptions")[0];
    expect((call?.values ?? [])[2]).toBe("cancelled");
    expect((call?.values ?? [])[5]).toBe(true); // isTerminal → `<=` branch
    expect(call?.text).toContain("s.last_event_at <= to_timestamp($5::double precision)");
  });
});

// ---------------------------------------------------------------------------
describe("F7 — tenant-configured dunning grace window", () => {
  it("honors a custom tenants.settings.dunning_grace_days via the SQL path", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("grace_days")) return { rows: [{ grace_days: 7 }] };
      return undefined;
    });
    await expect(resolveDunningGraceDays(pool, SUB.tenantId)).resolves.toBe(7);
    // The SQL is digit-guarded: a malformed value can never raise mid-event.
    const call = callsMatching(pool.calls, "grace_days")[0];
    expect(call?.text).toContain("~ '^[0-9]{1,4}$'");
    expect((call?.values ?? [])[1]).toBe(14); // the default rides as the param
  });

  it("falls back to 14 when the setting is absent or the row is malformed", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("grace_days")) return { rows: [{ grace_days: null }] };
      return undefined;
    });
    await expect(resolveDunningGraceDays(pool, SUB.tenantId)).resolves.toBe(14);
  });
});
