// sample: docs/glofox/samples/members.get.limit2.json (style A)
// sample: docs/glofox/samples/bookings.get.limit3.json (style B)
// sample: docs/glofox/samples/analytics.report.30d.json (style C)
import { z } from "zod";

/**
 * The three Glofox response envelope styles (docs/glofox/README.md §2, verified
 * live). The API is inconsistent across endpoint generations; the shared client
 * owns the per-endpoint strategy. Pagination is page-based and 1-indexed.
 */

/** Style A (2.0 lists): members, memberships, credits, branch events. */
export function glofoxEnvelopeA<S extends z.ZodTypeAny>(item: S) {
  return z.object({
    object: z.literal("list"),
    page: z.number().int(),
    limit: z.number().int(),
    has_more: z.boolean(),
    total_count: z.number().int(),
    data: z.array(item),
  });
}

/**
 * Style B (2.2 lists): bookings. Page math uses `meta.totalCount` (no
 * `has_more`). NOTE: `success` stays a plain boolean here because the shared
 * client MUST throw when it is not `true` BEFORE `data` is parsed
 * (docs/glofox/README.md §3 trap 1 — see client-contract.ts).
 */
export function glofoxEnvelopeB<S extends z.ZodTypeAny>(item: S) {
  return z.object({
    data: z.array(item),
    success: z.boolean(),
    meta: z.object({
      totalCount: z.number().int(),
      page: z.number().int(),
      limit: z.number().int(),
    }),
  });
}

/**
 * Style C (Analytics): the bare report object keyed by report model name — e.g.
 * `{ TransactionsList: { header, details } }`. NO `data`, NO `success`, NO
 * pagination: the full window is returned, so callers keep windows small.
 */
export function glofoxEnvelopeC<M extends z.ZodRawShape>(models: M) {
  return z.object(models);
}
