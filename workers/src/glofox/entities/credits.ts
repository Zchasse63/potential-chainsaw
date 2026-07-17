import { glofoxCreditSchema, type GlofoxCredit } from "@kelo/contracts";
import { CREDITS_MAPPER_VERSION, mapCredit } from "@kelo/glofox";
import type { CreditLedgerRow } from "@kelo/glofox";
import { extractStyleARows, styleAHasNextPage, withQuery } from "../envelopes.js";
import { iso } from "./shared.js";
import { strictRow } from "./shared.js";
import type {
  EntitySpec,
  PooledQueryable,
  SyncQuarantineRow,
  SyncRunContext,
  SyncWindow,
} from "../types.js";

/**
 * Credits sync — O(members) per-user reads (README §7.3: there is NO
 * branch-wide credits endpoint). The run walks people in lexicographic
 * external_ref order, MEMBER_BATCH_SIZE per job; when the chunk is full the
 * processor re-enqueues ITSELF via app.enqueue_job with the next cursor in the
 * job payload (idempotency-keyed per cursor, so a retried chunk never
 * duplicates its successor). A crashed chunk simply restarts from scratch on
 * the next fan-out — every write below is idempotent.
 *
 * plausible_zero = TRUE: a 500-member chunk legitimately contains zero packs.
 *
 * CREDIT DEBIT DEDUPE — THE EXACT RULE (conservative + idempotent; debits have
 * no unique key by design — imported debits carry external_ref NULL):
 *   1. The grant row inserts ON CONFLICT (tenant_id, external_ref, entry_type)
 *      DO NOTHING (idempotent re-import); its id is then re-selected.
 *   2. A per-grant pg advisory xact lock (hashtext(tenant), hashtext(credit
 *      _id)) serializes concurrent credit chains on this grant inside the txn.
 *   3. coverage  = sum(−delta) over the grant's existing 'debit' rows.
 *      consumed  = sum(−delta) over the debit rows the mapper emitted NOW.
 *   4. coverage ≥ consumed → insert NOTHING (the normal re-import case).
 *   5. coverage = 0 → insert the mapper's debit rows VERBATIM (first observed
 *      consumption: exact per-booking rows, or the single aggregate row the
 *      mapper chose — its mismatch quarantine rides along).
 *   6. 0 < coverage < consumed → insert ONE top-up debit of −(consumed −
 *      coverage), booking_external_ref NULL, reason 'top-up debit: consumed
 *      rose {coverage} → {consumed} since first import; per-booking
 *      attribution of the delta unknown'. Never beyond the exact consumed
 *      total; the balance always converges and then rule 4 freezes it.
 *
 * KNOWN LIMIT (deferred): a grant whose num_sessions the vendor edits AFTER
 * import is not adjusted (the ledger is append-only; grants never update).
 * The raw zone keeps the evidence; reconciliation flags drift.
 */

const MEMBER_BATCH_SIZE = 500; // spec: bounded per-run member cap
const PAGE_LIMIT = 100;
const ENTITY = "credits";

/** The row type flowing through the pipeline: a parsed pack + its owner ref. */
interface CreditPacket {
  readonly personExternalRef: string;
  readonly pack: GlofoxCredit;
}

async function insertGrantAndDebits(
  tx: PooledQueryable,
  ctx: SyncRunContext,
  personId: string,
  rows: CreditLedgerRow[],
  quarantine: SyncQuarantineRow[],
): Promise<number> {
  const grant = rows.find((row) => row.entry_type === "grant");
  if (grant === undefined || grant.external_ref === null) return 0;
  const debits = rows.filter((row) => row.entry_type === "debit");

  // 1. The grant (idempotent).
  await tx.query(
    `insert into public.credit_ledger (
       tenant_id, person_id, entry_type, delta, grant_id, expires_at, source,
       external_ref, booking_external_ref, reason, actor_user_id
     ) values ($1,$2,'grant',$3,null,$4,'glofox',$5,null,null,null)
     on conflict (tenant_id, external_ref, entry_type) where external_ref is not null
     do nothing`,
    [ctx.tenantId, personId, grant.delta, iso(grant.expires_at), grant.external_ref],
  );
  const grantRow = await tx.query(
    `select id from public.credit_ledger
     where tenant_id = $1 and external_ref = $2 and entry_type = 'grant'`,
    [ctx.tenantId, grant.external_ref],
  );
  const grantId = (grantRow.rows[0] as { id?: string } | undefined)?.id;
  if (grantId === undefined) {
    quarantine.push({
      entity: ENTITY,
      external_ref: grant.external_ref,
      reason: "credit grant row missing after insert-on-conflict",
      payload: grant,
    });
    return 0;
  }
  let written = 1;
  if (debits.length === 0) return written;

  // 2. Serialize concurrent credit chains on THIS grant for the check-then-insert.
  await tx.query(`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    ctx.tenantId,
    grant.external_ref,
  ]);

  // 3–4. Coverage vs consumption.
  const coverageResult = await tx.query(
    `select coalesce(sum(-delta), 0)::int as coverage
     from public.credit_ledger
     where tenant_id = $1 and grant_id = $2 and entry_type = 'debit'`,
    [ctx.tenantId, grantId],
  );
  const coverage = (coverageResult.rows[0] as { coverage?: number } | undefined)?.coverage ?? 0;
  const consumed = debits.reduce((sum, debit) => sum + -debit.delta, 0);
  if (coverage >= consumed) return written;

  // 5–6. First-observation verbatim, otherwise the single top-up.
  const toInsert: CreditLedgerRow[] =
    coverage === 0
      ? debits
      : [
          {
            tenant_id: ctx.tenantId,
            person_id: personId,
            entry_type: "debit",
            delta: -(consumed - coverage),
            expires_at: null,
            source: "glofox",
            external_ref: null,
            booking_external_ref: null,
            reason:
              `top-up debit: consumed rose ${coverage} → ${consumed} since first import; ` +
              `per-booking attribution of the delta unknown`,
            actor_user_id: null,
          },
        ];
  for (const debit of toInsert) {
    await tx.query(
      `insert into public.credit_ledger (
         tenant_id, person_id, entry_type, delta, grant_id, expires_at, source,
         external_ref, booking_external_ref, reason, actor_user_id
       ) values ($1,$2,'debit',$3,$4,null,'glofox',null,$5,$6,null)`,
      [ctx.tenantId, personId, debit.delta, grantId, debit.booking_external_ref, debit.reason],
    );
    written += 1;
  }
  return written;
}

/** Fresh spec per run — the member chunk map + cursor live in the closure. */
export function createCreditsSpec(): EntitySpec<CreditPacket> {
  /** external_ref → people.id for the current chunk (filled by pages()). */
  const memberIds = new Map<string, string>();
  let lastMemberRef: string | null = null;
  let chunkWasFull = false;

  return {
    entity: ENTITY,
    mapperVersion: CREDITS_MAPPER_VERSION,
    defaults: { plausibleZero: true, emptyAlarmThreshold: 3 },
    fullListEveryRun: true,
    needsTimezone: false,

    windows: (_state, ctx) => [{ start: null, end: ctx.now() }],

    pages: async function* (pool, client, _window, ctx) {
      const cursor = ctx.payload["cursor"];
      const members = await pool.query(
        `select id, external_ref from public.people
         where tenant_id = $1 and external_ref is not null
           and ($2::text is null or external_ref > $2)
         order by external_ref asc
         limit $3`,
        [ctx.tenantId, typeof cursor === "string" ? cursor : null, MEMBER_BATCH_SIZE],
      );
      for (const member of members.rows as { id: string; external_ref: string }[]) {
        memberIds.set(member.external_ref, member.id);
        lastMemberRef = member.external_ref;
      }
      chunkWasFull = members.rows.length === MEMBER_BATCH_SIZE;

      for (const [externalRef] of memberIds) {
        let page = 1;
        for (;;) {
          const query = { user_id: externalRef, page, limit: PAGE_LIMIT };
          const payload = await client.fetch(withQuery("/2.0/credits", query));
          yield {
            endpoint: "/2.0/credits",
            requestMeta: { method: "GET", path: "/2.0/credits", query, page },
            payload,
          };
          if (!styleAHasNextPage(payload)) break;
          page += 1;
        }
      }
    },

    extractRows: extractStyleARows,

    mapRow: (rawRow) => {
      const { parsed, quarantine } = strictRow(glofoxCreditSchema, ENTITY, rawRow);
      if (parsed === null) return { rows: [], quarantine: [...quarantine] };
      return { rows: [{ personExternalRef: parsed.user_id, pack: parsed }], quarantine: [] };
    },

    upsertBatch: async (tx, rows, ctx) => {
      let upserted = 0;
      const quarantine: SyncQuarantineRow[] = [];
      for (const row of rows) {
        const personId = memberIds.get(row.personExternalRef);
        if (personId === undefined) {
          quarantine.push({
            entity: ENTITY,
            external_ref: row.pack._id ?? null,
            reason: "credit owner not in the people chunk being processed",
            payload: row.pack,
          });
          continue;
        }
        const result = mapCredit(row.pack, { tenantId: ctx.tenantId, personId });
        quarantine.push(...result.quarantine);
        upserted += await insertGrantAndDebits(tx, ctx, personId, [...result.rows], quarantine);
      }
      return { upserted, quarantine };
    },

    candidateFor: (window: SyncWindow) => window.end,

    // Re-enqueue the NEXT chunk; the idempotency key is scoped to the cursor,
    // so a retried chunk hands off exactly one successor.
    afterSuccess: async (pool, ctx) => {
      if (!chunkWasFull || lastMemberRef === null) return;
      await pool.query(`select app.enqueue_job($1, $2, $3, now(), 100, 5, $4)`, [
        "glofox.sync.credits",
        JSON.stringify({ cursor: lastMemberRef }),
        ctx.tenantId,
        `glofox.sync.credits:${ctx.tenantId}:after:${lastMemberRef}`,
      ]);
    },
  };
}
