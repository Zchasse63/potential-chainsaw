import { describe, expect, it } from "vitest";
import { runVerifyMoney } from "../../src/billing/verify.js";
import { callsMatching, createBillingPool, type Responder } from "./helpers.js";

/**
 * VERIFY_MONEY (Phase 5 · unit 5.5) — the nightly cross-ledger invariant sweep.
 * Each check is a pure SELECT; a breach becomes a violation entry + a deduped
 * alert; the run is recorded in verify_runs. The load-bearing property: it NEVER
 * mutates the ledgers it checks (read-only by construction). NO network, NO DB.
 */

const NOW = new Date("2026-07-19T00:00:00.000Z");

/** A responder that returns empty for every check (a clean, all-green run). */
const CLEAN: Responder = () => undefined;

/** Assert verify touched NONE of the ledgers — only verify_runs + alerts. */
function assertReadOnly(calls: readonly { text: string }[]): void {
  const forbidden = [
    "update public.payments",
    "insert into public.payments",
    "delete from public.payments",
    "update public.stripe_commands",
    "insert into public.stripe_commands",
    "delete from public.stripe_commands",
    "update public.stripe_events",
    "insert into public.stripe_events",
    "delete from public.stripe_events",
  ];
  for (const needle of forbidden) {
    expect(callsMatching(calls, needle)).toHaveLength(0);
  }
}

describe("verify_money · a clean spine", () => {
  it("records an ok run with no violations and no alerts", async () => {
    const pool = createBillingPool(CLEAN);

    const outcome = await runVerifyMoney(pool, { now: () => NOW });

    expect(outcome.ok).toBe(true);
    expect(outcome.violations).toEqual([]);

    // Exactly one verify_runs row, global (tenant null), ok true, empty array.
    const run = callsMatching(pool.calls, "insert into public.verify_runs")[0];
    expect(run).toBeDefined();
    const v = run?.values ?? [];
    expect(v[2]).toBe(true); // ok
    expect(v[3]).toBe("[]"); // violations
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
    assertReadOnly(pool.calls);
  });
});

describe("verify_money · invariant breaches", () => {
  it("flags a terminal-paid payment with no intent id (critical) and alerts the tenant", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("stripe_payment_intent_id is null")) {
        return { rows: [{ id: "pay_1", tenant_id: "t1", status: "succeeded" }] };
      }
      return undefined;
    });

    const outcome = await runVerifyMoney(pool, { now: () => NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0]).toMatchObject({
      check: "terminal_paid_without_intent",
      severity: "critical",
      tenantId: "t1",
    });

    // A verify_money alert is opened for the offending tenant, deduped by check.
    const alert = callsMatching(pool.calls, "insert into public.alerts")[0];
    expect(alert).toBeDefined();
    const av = alert?.values ?? [];
    expect(av[0]).toBe("t1"); // tenant_id
    expect(av[4]).toBe("terminal_paid_without_intent"); // dedupe_key
    // The alert upserts (open/refresh), never spams.
    expect(alert?.text).toContain("on conflict");
    expect(alert?.text).toContain("do update");
    assertReadOnly(pool.calls);
  });

  it("flags an over-refund (critical): total refunded exceeds the amount", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("kind = 'create_refund'") && text.includes("having")) {
        return {
          rows: [{ id: "pay_2", tenant_id: "t1", amount_cents: 5000, refunded: 6000 }],
        };
      }
      return undefined;
    });

    const outcome = await runVerifyMoney(pool, { now: () => NOW });

    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0]).toMatchObject({
      check: "over_refund",
      severity: "critical",
      tenantId: "t1",
      detail: { payment_id: "pay_2", amount_cents: 5000, refunded_cents: 6000 },
    });
    assertReadOnly(pool.calls);
  });

  it("flags a stuck pending command past the SLA (warning) using the injected clock", async () => {
    const seen: unknown[] = [];
    const pool = createBillingPool((text, values) => {
      if (text.includes("status = 'pending' and created_at < $1")) {
        seen.push(values?.[0]);
        return { rows: [{ id: "c1", tenant_id: "t1", kind: "create_payment_intent", created_at: "old" }] };
      }
      return undefined;
    });

    const outcome = await runVerifyMoney(pool, { now: () => NOW, staleAfterMinutes: 30 });

    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0]).toMatchObject({
      check: "stuck_outbox_command",
      severity: "warning",
      tenantId: "t1",
    });
    // The SLA cutoff is 30 minutes before the injected now (no wall clock).
    expect(seen[0]).toBe(new Date(NOW.getTime() - 30 * 60 * 1000).toISOString());
    assertReadOnly(pool.calls);
  });

  it("flags a dead-lettered (failed) command as CRITICAL and alerts the tenant (F3)", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("from public.stripe_commands") && text.includes("where status = 'failed'")) {
        return {
          rows: [
            {
              id: "cmd_dead",
              tenant_id: "t1",
              kind: "create_payment_intent",
              last_error: "card_declined",
            },
          ],
        };
      }
      return undefined;
    });

    const outcome = await runVerifyMoney(pool, { now: () => NOW });

    expect(outcome.ok).toBe(false);
    const dead = outcome.violations.find((v) => v.check === "dead_lettered_command");
    expect(dead).toMatchObject({
      check: "dead_lettered_command",
      severity: "critical",
      tenantId: "t1",
      detail: { command_id: "cmd_dead", kind: "create_payment_intent" },
    });
    // A tenant-scoped, deduped verify_money alert is opened for the dead command.
    const alert = callsMatching(pool.calls, "insert into public.alerts")[0];
    expect(alert).toBeDefined();
    expect(alert?.values?.[0]).toBe("t1"); // tenant_id
    expect(alert?.values?.[4]).toBe("dead_lettered_command"); // dedupe_key
    // A dead command is a stuck money mutation — verify never mutates the ledgers.
    assertReadOnly(pool.calls);
  });

  it("surfaces dead-lettered events as a global (null-tenant) violation, no alert", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("status = 'error'")) return { rows: [{ n: 3 }] };
      return undefined;
    });

    const outcome = await runVerifyMoney(pool, { now: () => NOW });

    const dead = outcome.violations.find((viol) => viol.check === "dead_lettered_events");
    expect(dead).toMatchObject({ severity: "warning", tenantId: null, detail: { count: 3 } });
    // A null-tenant violation is surfaced only in the run record — never as a
    // client-invisible, un-dedupable null-tenant alert.
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(0);
    assertReadOnly(pool.calls);
  });

  it("collapses many breaches of one check for one tenant into a single deduped alert", async () => {
    const pool = createBillingPool((text) => {
      if (text.includes("stripe_payment_intent_id is null")) {
        return {
          rows: [
            { id: "pay_1", tenant_id: "t1", status: "succeeded" },
            { id: "pay_2", tenant_id: "t1", status: "refunded" },
          ],
        };
      }
      return undefined;
    });

    const outcome = await runVerifyMoney(pool, { now: () => NOW });

    expect(outcome.violations).toHaveLength(2);
    // Two offenders, ONE alert (grouped by tenant+check).
    expect(callsMatching(pool.calls, "insert into public.alerts")).toHaveLength(1);
  });
});
