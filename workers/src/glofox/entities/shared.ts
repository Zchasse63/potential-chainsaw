import type { z } from "zod";
import type { SyncQuarantineRow } from "../types.js";

/**
 * Per-row STRICT contract parse (per-row salvage): the row schema from
 * @kelo/contracts, safeParsed one row at a time. A failure quarantines THIS
 * row with 'row failed contract parse' and the page carries on — one bad row
 * never kills a page (invariant #8). The input type is decoupled (I) so
 * transform-bearing schemas (glofoxUnixTimestamp: string|number → Date) infer.
 */
export function strictRow<T, I>(
  schema: z.ZodType<T, z.ZodTypeDef, I>,
  entity: string,
  rawRow: unknown,
): { parsed: T; quarantine: [] } | { parsed: null; quarantine: [SyncQuarantineRow] } {
  const result = schema.safeParse(rawRow);
  if (result.success) return { parsed: result.data, quarantine: [] };
  const issue = result.error.issues[0];
  return {
    parsed: null,
    quarantine: [
      {
        entity,
        // ATTRIBUTION: a parse-failed quarantine row must still name the record
        // it represents, or a quarantine pile silently hides a derived-table
        // shortfall (the 2026-07-22 credit gap: 124 credit quarantine rows, ALL
        // external_ref NULL, masked a 41-member / 331-outstanding-credit ledger
        // shortfall — un-joinable to any member or balance). Every entity
        // through strictRow (members/bookings/events/credits/memberships) is a
        // Glofox Mongo doc keyed by _id; fall back to `id`, else null.
        external_ref: externalRefOf(rawRow),
        reason:
          `row failed contract parse: ` +
          (issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"),
        payload: rawRow,
      },
    ],
  };
}

/** Best-effort stable id for a row that FAILED parse (so it can't be validated). */
function externalRefOf(rawRow: unknown): string | null {
  if (rawRow !== null && typeof rawRow === "object") {
    const r = rawRow as Record<string, unknown>;
    if (typeof r._id === "string" && r._id !== "") return r._id;
    if (typeof r.id === "string" && r.id !== "") return r.id;
  }
  return null;
}

/** Date → timestamptz param (null passes through). */
export function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}
