import { z } from "zod";

/**
 * Kelo API response envelope (plan-final §3; CLAUDE.md invariant #3).
 *
 * EVERY API response is `{ data, meta }` — a screen cannot render data without
 * provenance. Combined reports inherit the OLDEST input's freshness: stale
 * revenue is labeled stale, never silently mixed with fresh bookings.
 */

export const envelopeSourceSchema = z.enum(["native", "glofox", "stripe", "mixed"]);
export type EnvelopeSource = z.infer<typeof envelopeSourceSchema>;

export const envelopeMetaSchema = z.object({
  /** ISO 8601 datetime of the newest input that produced `data`. */
  as_of: z.string().datetime({ offset: true }),
  source: envelopeSourceSchema,
  stale: z.boolean(),
  /** Version of the metric/report definition that produced `data`; null for plain reads. */
  definition_version: z.string().nullable(),
  correlation_id: z.string().min(1),
});
export type EnvelopeMeta = z.infer<typeof envelopeMetaSchema>;

export interface Envelope<T> {
  data: T;
  meta: EnvelopeMeta;
}

/** Build the Zod schema for an envelope whose `data` is described by `schema`. */
export function envelope<S extends z.ZodTypeAny>(schema: S) {
  return z.object({ data: schema, meta: envelopeMetaSchema });
}

/**
 * Structured error body (plan-final §3). Errors are NEVER represented as a 200
 * success with a failure flag — that is Glofox's own trap (docs/glofox/README.md
 * §3 trap 1) and Kelo does not repeat it. Error responses use this shape with a
 * non-2xx HTTP status; the freshness envelope is for successes only.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    correlation_id: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * The provenance contract, client side (UX plan §4 / CLAUDE.md invariant #3):
 * a payload is renderable ONLY if it carries a schema-valid `meta`
 * ({ as_of, source, stale, definition_version, correlation_id }). Anything
 * less is a defect — DataBoundary refuses the render and reports it.
 *
 * Lives in contracts (Wave 8.1b) so every client surface — apps/web today,
 * the member app later — inspects envelopes through ONE implementation.
 */
export type EnvelopeInspection<T> = { ok: true; data: T; meta: EnvelopeMeta } | { ok: false };

export function inspectEnvelope<T>(payload: unknown): EnvelopeInspection<T> {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false };
  }
  const meta = envelopeMetaSchema.safeParse((payload as { meta?: unknown }).meta);
  if (!meta.success) {
    return { ok: false };
  }
  return { ok: true, data: (payload as { data: T }).data, meta: meta.data };
}
