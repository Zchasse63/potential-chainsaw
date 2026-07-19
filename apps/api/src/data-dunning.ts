import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";

/**
 * Data access for the dunning queue (unit 5.6) — the owner/manager surface that
 * lists subscriptions in an open dunning cycle. ALWAYS through the user-scoped
 * client: public.dunning_queue is SECURITY INVOKER, so subscriptions RLS scopes
 * rows to the caller's tenant (invariant #7). Every row is Zod-validated at the
 * boundary; a shape mismatch is a server defect.
 */

interface QueryError {
  message: string;
}
interface QueryResult {
  data: unknown;
  error: QueryError | null;
}
interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

const uuid = z.string().uuid();

export const dunningStageSchema = z.enum([
  "grace_started",
  "reminder_sent",
  "final_notice",
  "past_due",
]);
export type DunningStage = z.infer<typeof dunningStageSchema>;

export const dunningQueueRowSchema = z.object({
  subscription_id: uuid,
  customer_id: uuid,
  person_id: uuid,
  person_name: z.string().nullable(),
  plan_id: uuid,
  status: z.string(),
  stage: dunningStageSchema,
  grace_expires_at: z.string().nullable(),
  current_period_end: z.string().nullable(),
  occurred_at: z.string(),
});
export type DunningQueueRow = z.infer<typeof dunningQueueRowSchema>;

/** The dunning queue for a tenant: subscriptions in grace/past_due with the
 * current stage + member name (RLS-scoped). */
export async function fetchDunningQueue(
  client: KeloSupabaseClient,
  tenantId: string,
): Promise<DunningQueueRow[]> {
  const { data, error } = await (client as unknown as RpcClient).rpc("dunning_queue", {
    p_tenant: tenantId,
  });
  if (error !== null) throw new Error(`fetchDunningQueue query failed: ${error.message}`);
  const parsed = z.array(dunningQueueRowSchema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(`fetchDunningQueue: unexpected DB row shape (${parsed.error.message})`);
  }
  return parsed.data;
}
