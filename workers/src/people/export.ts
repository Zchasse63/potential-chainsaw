import { z } from "zod";
import type { JobProcessor, JobRow, Queryable } from "../processors.js";

export const PERSON_EXPORT_KIND = "person.export";

const payloadSchema = z.object({
  export_id: z.string().uuid(),
  person_id: z.string().uuid(),
  actor_id: z.string().uuid().nullable().optional(),
});

const exportJobSchema = z.object({
  id: z.string().uuid(),
  subject_person_id: z.string().uuid(),
  status: z.enum(["queued", "running", "ready", "error", "expired"]),
});

function tenantOf(job: JobRow): string {
  if (job.tenant_id === null) throw new Error(`${job.kind} requires a tenant-scoped job`);
  return job.tenant_id;
}

async function rows(pool: Queryable, sql: string, values: readonly unknown[]): Promise<unknown[]> {
  return (await pool.query(sql, values)).rows;
}

/**
 * DSAR assembly boundary. This intentionally gathers the SUBJECT'S own PII;
 * it is invoked only by an owner/manager-created, tenant-scoped export job.
 */
export const processPersonExport: JobProcessor = async (job, ctx) => {
  const tenantId = tenantOf(job);
  const payload = payloadSchema.parse(job.payload);
  if (payload.person_id === "") throw new Error("person.export requires a subject person");

  try {
    const exportRows = await rows(
      ctx.pool,
      `update public.data_exports
       set status = 'running', error = null
       where id = $1::uuid and tenant_id = $2::uuid
         and subject_person_id = $3::uuid and status in ('queued', 'running', 'error')
       returning id, subject_person_id, status`,
      [payload.export_id, tenantId, payload.person_id],
    );
    let exportJob = exportJobSchema.safeParse(exportRows[0]);
    if (!exportJob.success) {
      // Crash-after-ready retry: the artifact is already durable, so the job
      // processor succeeds without reassembling or rewriting subject PII.
      const existing = await rows(
        ctx.pool,
        `select id, subject_person_id, status from public.data_exports
         where id = $1::uuid and tenant_id = $2::uuid and subject_person_id = $3::uuid`,
        [payload.export_id, tenantId, payload.person_id],
      );
      exportJob = exportJobSchema.safeParse(existing[0]);
      if (exportJob.success && exportJob.data.status === "ready") return;
      throw new Error("person export job not found, mismatched, or no longer runnable");
    }

    const personRows = await rows(
      ctx.pool,
      "select p.* from public.people p where p.tenant_id = $1::uuid and p.id = $2::uuid",
      [tenantId, payload.person_id],
    );
    const person = personRows[0] as Record<string, unknown> | undefined;
    if (person === undefined) throw new Error("DSAR subject person not found in tenant");

    const externalRef = typeof person["external_ref"] === "string" ? person["external_ref"] : null;
    const membership = {
      membership_type: person["membership_type"] ?? null,
      membership_status: person["membership_status"] ?? null,
      user_membership_id: person["user_membership_id"] ?? null,
      membership_started_at: person["membership_started_at"] ?? null,
    };
    const memberships = Object.values(membership).some((value) => value !== null)
      ? [membership]
      : [];

    const [bookings, transactions, creditLedger, creditBalance, commsLog, consents, segments, relationships] =
      await Promise.all([
        externalRef === null
          ? Promise.resolve([])
          : rows(
              ctx.pool,
              `select b.* from public.glofox_bookings b
               where b.tenant_id = $1::uuid and b.person_external_ref = $2
               order by b.time_start, b.created_at`,
              [tenantId, externalRef],
            ),
        externalRef === null
          ? Promise.resolve([])
          : rows(
              ctx.pool,
              `select t.* from public.glofox_transactions t
               where t.tenant_id = $1::uuid and t.person_external_ref = $2
               order by t.transaction_created_at, t.created_at`,
              [tenantId, externalRef],
            ),
        rows(
          ctx.pool,
          `select cl.* from public.credit_ledger cl
           where cl.tenant_id = $1::uuid and cl.person_id = $2::uuid
           order by cl.created_at, cl.id`,
          [tenantId, payload.person_id],
        ),
        rows(
          ctx.pool,
          `select coalesce(sum(cl.delta), 0)::int as balance,
                  min(cl.expires_at) filter (where cl.entry_type = 'grant' and cl.expires_at > now()) as next_expiry
           from public.credit_ledger cl
           where cl.tenant_id = $1::uuid and cl.person_id = $2::uuid`,
          [tenantId, payload.person_id],
        ),
        rows(
          ctx.pool,
          `select c.* from public.comms_log c
           where c.tenant_id = $1::uuid and c.person_id = $2::uuid
           order by c.created_at, c.id`,
          [tenantId, payload.person_id],
        ),
        rows(
          ctx.pool,
          `select cc.* from public.communication_consents cc
           where cc.tenant_id = $1::uuid and cc.person_id = $2::uuid
           order by cc.occurred_at, cc.created_at, cc.id`,
          [tenantId, payload.person_id],
        ),
        rows(
          ctx.pool,
          `select sa.* from public.segment_assignments sa
           where sa.tenant_id = $1::uuid and sa.person_id = $2::uuid
             and sa.run_id = (
               select sr.id from public.segment_runs sr
               where sr.tenant_id = $1::uuid and sr.status = 'success'
               order by sr.finished_at desc nulls last, sr.created_at desc limit 1
             )
           order by sa.segment_key`,
          [tenantId, payload.person_id],
        ),
        rows(
          ctx.pool,
          `select prl.* from public.person_relationship_log prl
           where prl.tenant_id = $1::uuid and prl.person_id = $2::uuid
           order by prl.changed_at, prl.id`,
          [tenantId, payload.person_id],
        ),
      ]);

    const bundle = {
      export_type: "person_dsar",
      subject_person_id: payload.person_id,
      people: person,
      memberships,
      bookings,
      transactions,
      credit_ledger: creditLedger,
      credit_balance: creditBalance[0] ?? { balance: 0, next_expiry: null },
      comms_log: commsLog,
      communication_consents: consents,
      segment_assignments: segments,
      person_relationship_log: relationships,
    };
    const rowCounts = {
      people: 1,
      memberships: memberships.length,
      bookings: bookings.length,
      transactions: transactions.length,
      credit_ledger: creditLedger.length,
      credit_balance: creditBalance.length,
      comms_log: commsLog.length,
      communication_consents: consents.length,
      segment_assignments: segments.length,
      person_relationship_log: relationships.length,
    };

    await ctx.pool.query(
      `update public.data_exports
       set status = 'ready', artifact = $3::jsonb, row_counts = $4::jsonb,
           expires_at = now() + interval '7 days', error = null
       where id = $1::uuid and tenant_id = $2::uuid and status = 'running'`,
      [payload.export_id, tenantId, JSON.stringify(bundle), JSON.stringify(rowCounts)],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.pool.query(
      `update public.data_exports
       set status = 'error', error = $3
       where id = $1::uuid and tenant_id = $2::uuid and status = 'running'`,
      [payload.export_id, tenantId, message.slice(0, 2000)],
    );
    throw error;
  }
};
