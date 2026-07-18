// sample: docs/glofox/samples/analytics.report.30d.json
import { z } from "zod";
import { glofoxEnvelopeC } from "./envelopes.js";

/**
 * Transactions report — `POST /Analytics/report` (docs/glofox/README.md §5).
 * Style C envelope (no data/success/pagination). Each row is wrapped in a
 * PROVIDER KEY — only `StripeCharge` observed live; the wrapper key is the
 * provider dimension, and unknown wrappers must alert. This report is the
 * payments source of truth until cutover (README §5: Stripe access is
 * Glofox-gated).
 */

/**
 * The KNOWN `transaction_status` vocabulary, verified live in the 30-day
 * window. A CLASSIFIER, not the boundary type (widen-then-classify, invariant
 * #8): the charge schema keeps the field a raw string so a novel status can't
 * fail a page parse; mappers safeParse against this set and QUARANTINE
 * unknowns — never silently into revenue.
 */
export const glofoxTransactionStatusSchema = z.enum(["PAID", "ERROR", "REFUNDED"]);
export type GlofoxTransactionStatus = z.infer<typeof glofoxTransactionStatusSchema>;

const transactionMetadataSchema = z.object({
  namespace: z.string(),
  branch_id: z.string(),
  /**
   * Kept as a raw string at the boundary on purpose: classify with
   * `classifyGlofoxEvent` (primitives.ts) and QUARANTINE anything 'unknown'
   * (CLAUDE.md invariant #8).
   */
  glofox_event: z.string(),
  user_id: z.string(),
  user_name: z.string(),
  /** Live values: credit_card, card, complimentary, cash. */
  payment_method: z.string(),
  balance: z.number(),
  environment: z.string().optional(),
  /** book_class rows: */
  event_id: z.string().optional(),
  total_bookings: z.number().int().optional(),
  booking_id: z.string().optional(),
  /** subscription_payment rows (recurring evidence chain): */
  stripe_subscription_id: z.string().optional(),
  membership_id: z.string().optional(),
  /** Joins to the memberships catalog plan `code`. */
  plan_code: z.string().optional(),
  resource_id: z.string().optional(),
  user_tax_id: z.string().optional(),
  is_payment_link: z.boolean().optional(),
  /** invoice_payment rows: */
  is_forgiven: z.boolean().optional(),
  already_paid: z.boolean().optional(),
});

const payoutSchema = z.object({
  id: z.string(),
  transaction_id: z.string(),
  gross_amount: z.number(),
  fee: z.number(),
  net_amount: z.number(),
  date: z.string(),
});

export const glofoxStripeChargeSchema = z.object({
  _id: z.string(),
  id: z.string(),
  /** RAW string at the boundary (see glofoxTransactionStatusSchema note). */
  transaction_status: z.string(),
  transaction_provider_id: z.string(),
  metadata: transactionMetadataSchema,
  amount: z.number(),
  currency: z.string(),
  paid: z.boolean(),
  invoice_id: z.string(),
  /** ISO-ish STRINGS on this endpoint generation ("2026-07-17 04:32:52"). */
  created: z.string(),
  modified: z.string(),
  description: z.string(),
  transaction_group_id: z.string(),
  status: z.string(),
  taxes: z.number().nullable(),
  amount_refunded: z.number().optional(),
  customer: z.string().optional(),
  event_id: z.string().optional(),
  sold_by_user_id: z.string().nullable().optional(),
  refunded: z.boolean().optional(),
  disputed: z.boolean().optional(),
  refunds: z.array(z.string()).optional(),
  failed_amount: z.number().optional(),
  payout: payoutSchema.optional(),
});
export type GlofoxStripeCharge = z.infer<typeof glofoxStripeChargeSchema>;

/**
 * The STRICT per-row schema — the shape a well-formed StripeCharge-wrapped row
 * must have. Only `StripeCharge` observed live; unknown wrapper keys must
 * alert (README §5). Used by the transactions MAPPER (per-row safeParse →
 * quarantine on failure) and by the pinned-sample drift test, NOT by the
 * report envelope below.
 */
export const glofoxTransactionRowSchema = z.object({
  StripeCharge: glofoxStripeChargeSchema,
});
export type GlofoxTransactionRow = z.infer<typeof glofoxTransactionRowSchema>;

/**
 * PER-ROW SALVAGE (invariant #8): the report ENVELOPE validates structure only
 * — each detail row stays an unknown record so one malformed/novel row can
 * never fail the whole page parse. The transform layer safeParses each row
 * with glofoxTransactionRowSchema and routes failures to import_quarantine.
 */
export const glofoxTransactionsReportSchema = glofoxEnvelopeC({
  TransactionsList: z.object({
    header: z.string(),
    details: z.array(z.record(z.string(), z.unknown())),
  }),
});
export type GlofoxTransactionsReport = z.infer<typeof glofoxTransactionsReportSchema>;
