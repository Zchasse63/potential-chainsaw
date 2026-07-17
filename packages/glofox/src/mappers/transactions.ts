// sample: docs/glofox/samples/analytics.report.30d.json
/**
 * Phase 1 · unit 3 — analytics report row ({StripeCharge: {...}} wrapper) →
 * public.glofox_transactions row (migration 0009). The money facts:
 * reconciliation source and the pre-cutover FAILED-PAYMENT queue
 * (transaction_status='ERROR' rows, plan-final §4 negative branch).
 *
 * Quarantine-NOT-guess rules (invariant #8, README §5):
 *  - wrapper key !== 'StripeCharge'      → quarantine, NO row (alert on
 *                                          unknown wrappers; only StripeCharge
 *                                          observed live)
 *  - transaction_status outside the      → quarantine, NO row (it would fail
 *    [LIVE] PAID/ERROR/REFUNDED set         the CHECK; never silently into
 *                                          revenue, plan-final §4 facts table)
 *  - glofox_event classifies 'unknown'   → row emitted AS 'unknown' (VISIBLE)
 *                                          AND a quarantine row (REVIEWABLE)
 *  - amount missing/non-finite           → quarantine, NO row (nonsense money
 *                                          is never projected). NEGATIVE
 *                                          amounts are NOT nonsense: REFUNDED
 *                                          rows carry them (verified in the
 *                                          pinned 30d sample) — the sign is
 *                                          the refund direction, kept verbatim.
 * `created` is an ISO-ish branch-local wall-time string on this endpoint
 * generation (README §1) — converted with ctx.timezone like bookings.
 */
import {
  classifyGlofoxEvent,
  glofoxStripeChargeSchema,
  glofoxTransactionStatusSchema,
} from "@kelo/contracts";
import {
  blankToNull,
  branchWallTimeToUtc,
  MAPPER_VERSION,
  quarantine,
  type GlofoxTransactionRow,
  type MapperContext,
  type MapperResult,
  type QuarantineRow,
} from "./facts-types.js";

export { MAPPER_VERSION };

const ENTITY = "glofox_transactions";

/** The one wrapper key observed live (README §5); anything else alerts. */
const KNOWN_PROVIDER = "StripeCharge";

/**
 * @param detail the provider-wrapped report row. Typed `unknown` on purpose:
 * unknown-wrapper detection is this mapper's job, so it must accept rows the
 * contracts envelope type ({StripeCharge: …}) would not admit. Field shapes
 * of a StripeCharge payload are as parsed at the Zod boundary upstream.
 */
export function mapTransactionRow(
  detail: unknown,
  ctx: MapperContext,
): MapperResult<GlofoxTransactionRow> {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return {
      row: null,
      quarantine: [quarantine(ENTITY, null, "transaction row is not an object", detail)],
    };
  }
  const keys = Object.keys(detail);
  const provider = keys[0];
  if (keys.length !== 1 || provider !== KNOWN_PROVIDER) {
    return {
      row: null,
      quarantine: [
        quarantine(
          ENTITY,
          null,
          `unknown transaction provider: ${keys.join(", ") || "(empty wrapper)"}`,
          detail,
        ),
      ],
    };
  }
  const charge = (detail as Record<string, unknown>)[provider];
  // PER-ROW SALVAGE (invariant #8): the report envelope leaves rows unknown so
  // one malformed row can't fail the page; the STRICT contract parse happens
  // HERE, per row, and a failure quarantines this row only.
  const parsed = glofoxStripeChargeSchema.safeParse(charge);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      row: null,
      quarantine: [
        quarantine(
          ENTITY,
          null,
          `StripeCharge failed contract parse: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"}`,
          detail,
        ),
      ],
    };
  }
  const stripeCharge = parsed.data;

  const externalRef = blankToNull(stripeCharge._id);
  if (externalRef === null) {
    return { row: null, quarantine: [quarantine(ENTITY, null, "missing transaction _id", detail)] };
  }

  const status = glofoxTransactionStatusSchema.safeParse(stripeCharge.transaction_status);
  if (!status.success) {
    return {
      row: null,
      quarantine: [
        quarantine(
          ENTITY,
          externalRef,
          `unknown transaction_status: ${String(stripeCharge.transaction_status)}`,
          detail,
        ),
      ],
    };
  }

  const amount = stripeCharge.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return {
      row: null,
      quarantine: [
        quarantine(ENTITY, externalRef, `invalid transaction amount: ${String(amount)}`, detail),
      ],
    };
  }

  const currency = blankToNull(stripeCharge.currency);
  if (currency === null) {
    return {
      row: null,
      quarantine: [quarantine(ENTITY, externalRef, "missing transaction currency", detail)],
    };
  }

  const quarantines: QuarantineRow[] = [];

  // The classifier (contracts) owns the vocabulary; 'unknown' stays visible
  // in the projection AND goes to quarantine — never reclassified by hand.
  const rawEvent: unknown = stripeCharge.metadata?.glofox_event;
  const eventClass = classifyGlofoxEvent(rawEvent);
  if (eventClass === "unknown") {
    quarantines.push(
      quarantine(
        ENTITY,
        externalRef,
        rawEvent == null
          ? "unknown glofox_event: (missing)"
          : `unknown glofox_event: ${String(rawEvent)}`,
        detail,
      ),
    );
  }

  const createdRaw = stripeCharge.created;
  let transactionCreatedAt: Date | null = null;
  if (typeof createdRaw === "string" && createdRaw.trim() !== "") {
    transactionCreatedAt = branchWallTimeToUtc(createdRaw, ctx.timezone);
    if (transactionCreatedAt === null) {
      quarantines.push(
        quarantine(
          ENTITY,
          externalRef,
          `unparseable transaction created: ${JSON.stringify(createdRaw)}`,
          detail,
        ),
      );
    }
  }

  const metadata = stripeCharge.metadata;
  return {
    row: {
      tenant_id: ctx.tenantId,
      external_ref: externalRef,
      provider,
      transaction_status: status.data,
      amount,
      currency,
      amount_refunded:
        typeof stripeCharge.amount_refunded === "number" ? stripeCharge.amount_refunded : null,
      glofox_event: typeof rawEvent === "string" ? blankToNull(rawEvent) : null,
      glofox_event_class: eventClass,
      person_external_ref: blankToNull(metadata?.user_id),
      plan_code: blankToNull(metadata?.plan_code),
      stripe_subscription_id: blankToNull(metadata?.stripe_subscription_id),
      payment_method: blankToNull(metadata?.payment_method),
      invoice_external_ref: blankToNull(stripeCharge.invoice_id),
      // book_class rows carry the event ref in metadata; some rows also have a
      // top-level event_id — metadata wins (it is the documented carrier).
      event_external_ref: blankToNull(metadata?.event_id) ?? blankToNull(stripeCharge.event_id),
      transaction_created_at: transactionCreatedAt,
      raw: detail,
    },
    quarantine: quarantines,
  };
}
