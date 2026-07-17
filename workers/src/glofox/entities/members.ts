import { glofoxMemberSchema } from "@kelo/contracts";
import {
  isPersonExternalRefRow,
  mapMember,
  PERSON_MAPPER_VERSION,
  type PersonExternalRefRow,
  type PersonRow,
} from "@kelo/glofox";
import type { Queryable } from "../../processors.js";
import { extractStyleARows, styleAHasNextPage, toUnixSeconds, withQuery } from "../envelopes.js";
import type { EntitySpec, SyncQuarantineRow, SyncRunContext, SyncWindow } from "../types.js";
import { iso, strictRow } from "./shared.js";

/**
 * Members sync — INCREMENTAL (README §7.1: `utc_modified_start_date` is the
 * watermark param). Window = [committed − 5-minute overlap guard, now]; the
 * overlap absorbs vendor-side modified-clock skew (upserts are idempotent, so
 * re-fetched rows are cheap). A null committed watermark = full backfill (no
 * start param at all). Style A pagination.
 *
 * plausible_zero = FALSE: an empty members window is how the 10-week silent
 * freeze looked — it must trip the alarm, never quietly advance.
 *
 * Duplicate-email conflicts (the partial unique people_tenant_email_key —
 * shared family emails are REAL, migration 0008) are caught PER ROW under a
 * savepoint: the row quarantines for merge review and the batch continues.
 */

const OVERLAP_GUARD_MS = 5 * 60 * 1000; // 5 minutes (spec)
const PAGE_LIMIT = 100;

const ENTITY = "members";

type MemberRow = PersonRow | PersonExternalRefRow;

/** pg unique_violation on the email partial unique index specifically. */
function isDuplicateEmailViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505" &&
    String((err as { constraint?: unknown }).constraint ?? "").includes("people_tenant_email")
  );
}

async function upsertPerson(
  tx: Queryable,
  person: PersonRow,
  ctx: SyncRunContext,
  quarantine: SyncQuarantineRow[],
): Promise<string | null> {
  // SAVEPOINT per row: a duplicate-email 23505 aborts only this statement —
  // quarantine for merge review (the DESIGN, migration 0008) and continue.
  await tx.query("savepoint person_row");
  try {
    const result = await tx.query(
      `insert into public.people (
         tenant_id, email, phone, first_name, last_name, source, external_ref, active,
         source_created_at, first_activity_at, cohort_anchor_basis, date_quality,
         lead_status, next_action, pipeline_owner, consent_email, consent_sms, consent_push
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (tenant_id, external_ref) where external_ref is not null
       do update set
         email = excluded.email,
         phone = excluded.phone,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         active = excluded.active,
         source_created_at = excluded.source_created_at,
         consent_email = excluded.consent_email,
         consent_sms = excluded.consent_sms,
         consent_push = excluded.consent_push
       -- The NATIVE pipeline surface (lead_status, next_action, pipeline_owner,
       -- first_activity_at, cohort_anchor_basis) and date_quality (the phase-1
       -- validation study's upgrade) are NOT import-owned: never clobbered.
       returning id`,
      [
        ctx.tenantId,
        person.email,
        person.phone,
        person.first_name,
        person.last_name,
        person.source,
        person.external_ref,
        person.active,
        iso(person.source_created_at),
        iso(person.first_activity_at),
        person.cohort_anchor_basis,
        person.date_quality,
        person.lead_status,
        person.next_action,
        person.pipeline_owner,
        person.consent_email,
        person.consent_sms,
        person.consent_push,
      ],
    );
    await tx.query("release savepoint person_row");
    return (result.rows[0] as { id?: string } | undefined)?.id ?? null;
  } catch (err) {
    await tx.query("rollback to savepoint person_row");
    await tx.query("release savepoint person_row");
    if (isDuplicateEmailViolation(err)) {
      quarantine.push({
        entity: ENTITY,
        external_ref: person.external_ref,
        reason: "duplicate email — merge review",
        payload: person,
      });
      return null;
    }
    throw err;
  }
}

export const membersSpec: EntitySpec<MemberRow> = {
  entity: ENTITY,
  mapperVersion: PERSON_MAPPER_VERSION,
  defaults: { plausibleZero: false, emptyAlarmThreshold: 3 },
  fullListEveryRun: false,
  needsTimezone: false,

  windows: (state, ctx) => {
    const end = ctx.now();
    const committed =
      state.committed_watermark === null ? null : new Date(state.committed_watermark);
    return [
      {
        start: committed === null ? null : new Date(committed.getTime() - OVERLAP_GUARD_MS),
        end,
      },
    ];
  },

  pages: async function* (_pool, client, window) {
    let page = 1;
    for (;;) {
      const query: Record<string, string | number | boolean> = {
        page,
        limit: PAGE_LIMIT,
        utc_modified_end_date: toUnixSeconds(window.end),
      };
      if (window.start !== null) query["utc_modified_start_date"] = toUnixSeconds(window.start);
      const payload = await client.fetch(withQuery("/2.0/members", query));
      yield {
        endpoint: "/2.0/members",
        requestMeta: { method: "GET", path: "/2.0/members", query, page },
        payload,
      };
      if (!styleAHasNextPage(payload)) return;
      page += 1;
    }
  },

  extractRows: extractStyleARows,

  mapRow: (rawRow, mapCtx) => {
    const { parsed, quarantine } = strictRow(glofoxMemberSchema, ENTITY, rawRow);
    if (parsed === null) return { rows: [], quarantine: [...quarantine] };
    const result = mapMember(parsed, { tenantId: mapCtx.tenantId });
    return { rows: [...result.rows], quarantine: [...result.quarantine] };
  },

  upsertBatch: async (tx, rows, ctx) => {
    let upserted = 0;
    const quarantine: SyncQuarantineRow[] = [];
    // mapMember emits [person, ref] per member; person first so the ref gets
    // the resolved people.id. A person lost to the duplicate-email quarantine
    // drops its ref too (no dangling identity).
    let lastPersonId: string | null = null;
    for (const row of rows) {
      if (isPersonExternalRefRow(row)) {
        if (lastPersonId === null) continue;
        await tx.query(
          `insert into public.person_external_refs (tenant_id, person_id, system, external_ref)
           values ($1, $2, $3, $4)
           on conflict (tenant_id, system, external_ref) do nothing`,
          [ctx.tenantId, lastPersonId, row.system, row.external_ref],
        );
        upserted += 1;
      } else {
        lastPersonId = await upsertPerson(tx, row, ctx, quarantine);
        if (lastPersonId !== null) upserted += 1;
      }
    }
    return { upserted, quarantine };
  },

  candidateFor: (window: SyncWindow) => window.end,
};
