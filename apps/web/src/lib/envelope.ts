import { envelopeMetaSchema, type EnvelopeMeta } from "@kelo/contracts";

/**
 * The provenance contract, client side (UX plan §4 / CLAUDE.md invariant #3):
 * a payload is renderable ONLY if it carries a schema-valid `meta`
 * ({ as_of, source, stale, definition_version, correlation_id }). Anything
 * less is a defect — DataBoundary refuses the render and reports it.
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
