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
        external_ref: null,
        reason:
          `row failed contract parse: ` +
          (issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"),
        payload: rawRow,
      },
    ],
  };
}

/** Date → timestamptz param (null passes through). */
export function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}
