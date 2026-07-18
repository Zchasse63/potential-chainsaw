import { z } from "zod";
import type { JobProcessor, JobRow } from "../processors.js";

export const PERSON_DELETE_KIND = "person.delete";

const payloadSchema = z.object({
  person_id: z.string().uuid(),
  actor_id: z.string().uuid(),
  reason: z.string().max(2000).nullable().optional(),
});

function tenantOf(job: JobRow): string {
  if (job.tenant_id === null) throw new Error(`${job.kind} requires a tenant-scoped job`);
  return job.tenant_id;
}

/** Async/bulk erasure path; the single-person API uses the same RPC directly. */
export const processPersonDelete: JobProcessor = async (job, ctx) => {
  const tenantId = tenantOf(job);
  const payload = payloadSchema.parse(job.payload);
  await ctx.pool.query(
    "select * from app.pseudonymize_person($1::uuid, $2::uuid, $3::uuid, $4::text)",
    [tenantId, payload.person_id, payload.actor_id, payload.reason ?? null],
  );
};
