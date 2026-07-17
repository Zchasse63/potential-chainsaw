import { z } from "zod";

/**
 * Mutation conventions (plan-final §3 — scaffold only; the API enforces these in
 * a later unit):
 * - EVERY mutation requires a client-generated `Idempotency-Key` header
 *   (invariant #5: money/booking mutations are Postgres RPCs keyed on it).
 * - Updates carry the entity version in `If-Match`.
 * - Long-running operations return 202 + an operation id.
 */

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IF_MATCH_HEADER = "If-Match";

/** Body of a `202 Accepted` response for a long-running operation. */
export const operationAcceptedSchema = z.object({
  operation_id: z.string().min(1),
});
export type OperationAccepted = z.infer<typeof operationAcceptedSchema>;
