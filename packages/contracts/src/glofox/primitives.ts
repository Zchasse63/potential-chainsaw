// sample: docs/glofox/samples/analytics.report.30d.json (glofox_event vocabulary, string unix timestamps)
// sample: docs/glofox/samples/members.get.limit2.json (integer unix timestamps)
import { z } from "zod";

/**
 * Glofox timestamps arrive as unix epoch SECONDS — integers on some endpoints,
 * numeric strings on others (docs/glofox/README.md §1 and §8: "mixed int/string
 * by endpoint generation"). Parse defensively AT THE ZOD BOUNDARY (CLAUDE.md
 * invariant #8) so the rest of the codebase only ever sees `Date`.
 */
export const glofoxUnixTimestamp = z
  .union([z.number().int(), z.string().regex(/^\d+$/, "unix epoch seconds as a numeric string")])
  .transform((seconds) => new Date(Number(seconds) * 1000));
/** Transformed output type: `Date`. */
export type GlofoxUnixTimestamp = z.infer<typeof glofoxUnixTimestamp>;

/**
 * `metadata.glofox_event` vocabulary observed LIVE in the 30-day transactions
 * report (docs/glofox/README.md §5). `book_class` was undocumented by the
 * vendor; treat this enum as the complete known set, not a suggestion.
 */
export const glofoxEvent = z.enum([
  "subscription_payment",
  "invoice_payment",
  "book_class",
  // LIVE-discovered 2026-07-18 (full backfill): failed recurring charges — the
  // pre-cutover dunning signal alongside transaction_status ERROR.
  "subscription_payment_failed",
  // LIVE-discovered 2026-07-18 (3 open quarantines): rare manual/one-off charges.
  "custom_charge",
]);
export type GlofoxEvent = z.infer<typeof glofoxEvent>;

/**
 * Classification result — note `| "unknown"`. Unknown `glofox_event` values
 * QUARANTINE; they are never classified blindly (CLAUDE.md invariant #8).
 * Callers must route `unknown` rows to the quarantine path and alert, not guess.
 */
export type ClassifiedGlofoxEvent = GlofoxEvent | "unknown";

export function classifyGlofoxEvent(value: unknown): ClassifiedGlofoxEvent {
  const parsed = glofoxEvent.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}
