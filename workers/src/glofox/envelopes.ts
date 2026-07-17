import { z } from "zod";
import { glofoxEnvelopeA, glofoxEnvelopeB, glofoxTransactionsReportSchema } from "@kelo/contracts";

/**
 * LENIENT envelope parsers for the sync path (per-row salvage, invariant #8).
 * The envelope STRUCTURE is validated (Style A `data` / Style B `data` / Style
 * C `TransactionsList.details`) but each row stays `unknown` — one malformed
 * row can never fail the page. Rows are strict-parsed individually downstream;
 * row failures quarantine, envelope failures fail the run (schema-invalid →
 * the watermark law blocks committed advancement).
 *
 * Built from the contracts factories with z.unknown() so the envelope shape is
 * still declared exactly once (CLAUDE.md: contracts is the shape source of
 * truth). The typed endpoint wrappers in @kelo/glofox keep their strict
 * whole-page parsing for probes/tools.
 */

const envelopeALenient = glofoxEnvelopeA(z.unknown());
const envelopeBLenient = glofoxEnvelopeB(z.unknown());

/** Style A page → rows. Throws ZodError on envelope-level failure. */
export function extractStyleARows(payload: unknown): unknown[] {
  return envelopeALenient.parse(payload).data;
}

/** Style B page → rows. Throws ZodError on envelope-level failure. */
export function extractStyleBRows(payload: unknown): unknown[] {
  return envelopeBLenient.parse(payload).data;
}

/** Style C report window → detail rows (still provider-wrapped, still unknown
 * to the mapper — mapTransactionRow owns wrapper + strict row parse). */
export function extractTransactionsRows(payload: unknown): unknown[] {
  return glofoxTransactionsReportSchema.parse(payload).TransactionsList.details;
}

/** Style A pagination cursor: follow has_more, with the empty-data guard
 * against a buggy has_more-forever vendor response. */
export function styleAHasNextPage(parsed: unknown): boolean {
  const env = envelopeALenient.parse(parsed);
  return env.has_more && env.data.length > 0;
}

/** Style B pagination cursor: page math over meta.totalCount (no has_more). */
export function styleBNextPage(
  parsed: unknown,
  currentPage: number,
  firstPage: number,
): number | null {
  const env = envelopeBLenient.parse(parsed);
  const lastPage = Math.max(firstPage, Math.ceil(env.meta.totalCount / env.meta.limit));
  if (currentPage >= lastPage || env.data.length === 0) return null;
  return currentPage + 1;
}

/** Query-string builder for client.fetch paths (the contracts GlofoxFetch
 * takes the query in the path; the client's URL builder preserves it). */
export function withQuery(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

/** Watermark params travel as integer unix SECONDS (README §1). */
export function toUnixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
