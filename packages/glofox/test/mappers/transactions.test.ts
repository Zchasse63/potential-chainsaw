import { describe, expect, it } from "vitest";
import { glofoxTransactionsReportSchema, type GlofoxStripeCharge } from "@kelo/contracts";
import { MAPPER_VERSION, mapTransactionRow } from "../../src/mappers/transactions.js";
import type { MapperContext } from "../../src/mappers/facts-types.js";
import { loadSample } from "../helpers.js";

/**
 * Phase 1 · unit 3 — analytics report rows → glofox_transactions: the money
 * facts (reconciliation + the pre-cutover failed-payment queue). The pinned
 * 30d sample is parsed through the contracts envelope first, then EVERY row
 * is mapped — the live vocabulary must be fully classifiable (zero
 * quarantine) or the classifier has drifted. NO network.
 */
const ctx: MapperContext = { tenantId: "tenant-test", timezone: "America/New_York" };

function sampleDetails(): unknown[] {
  return glofoxTransactionsReportSchema.parse(loadSample("analytics.report.30d.json"))
    .TransactionsList.details;
}

function firstCharge(): {
  wrapper: { StripeCharge: GlofoxStripeCharge };
  charge: GlofoxStripeCharge;
} {
  const wrapper = sampleDetails()[0] as { StripeCharge: GlofoxStripeCharge };
  return { wrapper, charge: wrapper.StripeCharge };
}

/** Deep clone of a real parsed row with mutations applied — synthetic cases start from live truth. */
function mutatedCharge(mutate: (charge: GlofoxStripeCharge) => void): unknown {
  const wrapper = structuredClone(firstCharge().wrapper);
  mutate(wrapper.StripeCharge);
  return wrapper;
}

describe("mapTransactionRow (glofox_transactions)", () => {
  it("maps ALL 56 pinned rows with ZERO quarantine (the live vocabulary is complete)", () => {
    const details = sampleDetails();
    expect(details).toHaveLength(56);
    for (const detail of details) {
      const { row, quarantine } = mapTransactionRow(detail, ctx);
      expect(quarantine).toHaveLength(0);
      expect(row).not.toBeNull();
      expect(row?.provider).toBe("StripeCharge");
      expect(row?.tenant_id).toBe(ctx.tenantId);
    }
  });

  it("class distribution matches the README §5 [LIVE] vocabulary (16/10/30)", () => {
    const counts = new Map<string, number>();
    for (const detail of sampleDetails()) {
      const { row } = mapTransactionRow(detail, ctx);
      const key = row?.glofox_event_class ?? "(null row)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts).toEqual(
      new Map([
        ["subscription_payment", 16],
        ["invoice_payment", 10],
        ["book_class", 30],
      ]),
    );
  });

  it("ERROR and REFUNDED rows are first-class (the failed-payment source), negative refund amounts kept", () => {
    const rows = sampleDetails().map((detail) => mapTransactionRow(detail, ctx).row);
    const errors = rows.filter((row) => row?.transaction_status === "ERROR");
    const refunded = rows.filter((row) => row?.transaction_status === "REFUNDED");
    expect(errors).toHaveLength(1);
    expect(refunded).toHaveLength(1);
    expect(errors[0]?.external_ref).toBe("6a3febc2361cbd1663b6dad4");
    // The REFUNDED row carries amount −41.7 live: the sign is the refund direction.
    expect(refunded[0]?.amount).toBe(-41.7);
    expect(refunded[0]?.amount_refunded).toBe(41.7);
  });

  it("maps metadata refs, amounts, and branch-local created instants", () => {
    const { charge } = firstCharge();
    const { row } = mapTransactionRow({ StripeCharge: charge }, ctx);
    expect(row?.external_ref).toBe(charge._id);
    expect(row?.amount).toBe(207.46);
    expect(row?.currency).toBe("usd");
    expect(row?.person_external_ref).toBe(charge.metadata.user_id);
    expect(row?.plan_code).toBe(charge.metadata.plan_code ?? null);
    expect(row?.stripe_subscription_id).toBe(charge.metadata.stripe_subscription_id ?? null);
    expect(row?.payment_method).toBe(charge.metadata.payment_method);
    expect(row?.invoice_external_ref).toBe(charge.invoice_id);
    // "2026-07-17 04:32:52" in America/New_York (EDT, UTC−4 in July).
    expect(row?.transaction_created_at?.toISOString()).toBe("2026-07-17T08:32:52.000Z");
    expect(row?.raw).toEqual({ StripeCharge: charge });
  });

  it("book_class rows take the event ref from metadata.event_id", () => {
    const rows = sampleDetails().map((detail) => mapTransactionRow(detail, ctx).row);
    const bookClass = rows.filter((row) => row?.glofox_event_class === "book_class");
    expect(bookClass).toHaveLength(30);
    for (const row of bookClass) {
      expect(row?.event_external_ref).not.toBeNull();
    }
  });

  it("unknown wrapper key → quarantine, NO row (alert on unknown wrappers, README §5)", () => {
    const { row, quarantine } = mapTransactionRow({ PayPalCharge: { _id: "x" } }, ctx);
    expect(row).toBeNull();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.entity).toBe("glofox_transactions");
    expect(quarantine[0]?.reason).toBe("unknown transaction provider: PayPalCharge");
  });

  it("unknown transaction_status → quarantine, NO row (would fail the CHECK; never into revenue)", () => {
    const detail = mutatedCharge((charge) => {
      charge.transaction_status = "PENDING" as unknown as GlofoxStripeCharge["transaction_status"];
    });
    const { row, quarantine } = mapTransactionRow(detail, ctx);
    expect(row).toBeNull();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reason).toBe("unknown transaction_status: PENDING");
  });

  it("unknown glofox_event → row emitted AS 'unknown' AND a quarantine row (invariant #8)", () => {
    const detail = mutatedCharge((charge) => {
      charge.metadata.glofox_event = "gift_card_sale";
    });
    const { row, quarantine } = mapTransactionRow(detail, ctx);
    expect(row).not.toBeNull();
    expect(row?.glofox_event_class).toBe("unknown");
    expect(row?.glofox_event).toBe("gift_card_sale"); // raw value kept verbatim
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reason).toBe("unknown glofox_event: gift_card_sale");
  });

  it("missing _id → quarantine, no row", () => {
    const detail = mutatedCharge((charge) => {
      charge._id = "";
    });
    const { row, quarantine } = mapTransactionRow(detail, ctx);
    expect(row).toBeNull();
    expect(quarantine[0]?.reason).toContain("missing transaction _id");
  });

  it("nonsense amount (missing/non-finite) → quarantine, no row", () => {
    const detail = mutatedCharge((charge) => {
      charge.amount = Number.NaN;
    });
    const { row, quarantine } = mapTransactionRow(detail, ctx);
    expect(row).toBeNull();
    // The strict per-row contract parse catches it first (integration change:
    // per-row salvage) — the reason cites the exact contract path. The
    // mapper's own amount guard remains as the post-parse backstop.
    expect(quarantine[0]?.reason).toMatch(
      /StripeCharge failed contract parse: amount|invalid transaction amount/,
    );
  });

  it("is deterministic and versioned", () => {
    const [detail] = sampleDetails();
    expect(mapTransactionRow(detail, ctx)).toEqual(mapTransactionRow(detail, ctx));
    expect(MAPPER_VERSION).toBe(1);
  });
});
