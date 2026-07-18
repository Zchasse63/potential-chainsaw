import { z } from "zod";
import { openAlert, withTransaction } from "../pipeline.js";
import {
  extractStyleARows,
  extractStyleBRows,
  styleAHasNextPage,
  withQuery,
} from "../envelopes.js";
import type { PooledQueryable, SyncGlofoxClient, SyncRunContext } from "../types.js";

/**
 * Phase 1 · unit 5 — DELETION DETECTION (plan-final §4 step 6): periodic
 * full-window snapshots per entity; a record absent from TWO consecutive full
 * snapshots (never one) becomes a tombstone CANDIDATE surfaced in
 * deletion_candidates (+ a 'deletion_candidates' alert) for REVIEW.
 *
 * THE RULES THAT KEEP THIS SAFE:
 *   - A candidate NEVER purges a row. People/members remain review-only
 *     (README §6: members can be soft-deleted active:false and REACTIVATED).
 *     Nothing here ever deletes, updates, or deactivates a person row.
 *     Bookings are facts rather than evidence-class rows: after TWO misses a
 *     booking is marked deleted-in-source with deleted_at, but the row stays.
 *   - The snapshot fetches active='any' so soft-deleted members (still listed
 *     by the API) are NOT false positives — only true disappearance counts.
 *   - A snapshot page with ANY row lacking a readable string _id ABORTS the
 *     run for that entity (loud error, NO snapshot row, NO candidates): a
 *     dirty snapshot is not evidence of absence. Envelope-level parse failure
 *     throws the same way.
 *   - The snapshot row + the reappearance resolutions + the candidate upserts
 *     commit in ONE transaction (the pipeline's withTransaction): a crash can
 *     never desync the snapshot from its diff outcomes, so the NEXT run's
 *     "previous snapshot" is always consistent with the candidates on file.
 *   - One entity's failure never blinds the others: a per-entity error opens a
 *     'deletion_detection_error' warning alert and the run continues.
 *
 * DEFERRED: Glofox webhooks (MEMBER_UPDATED active:false) are the BETTER
 * deletion signal (README §6, Glofox's own recommended pattern) but there is
 * no webhook secret yet (BLOCKERS P0-7) — this snapshot method is the plan's
 * documented fallback and stays as the safety net even once webhooks land.
 *
 * Members and bookings support full branch lists. The bookings endpoint's
 * meta.totalCount is live-proven unreliable, so its snapshot paginates until
 * a short page rather than trusting the metadata.
 */

const PAGE_LIMIT = 100;

export const DELETION_ENTITIES = ["members", "bookings"] as const;

/** Per-entity contract: how to snapshot Glofox and read the Kelo slice refs. */
interface DeletionEntitySpec {
  readonly entity: string;
  /** The FULL current set of Glofox external_refs (paginates the full list). */
  readonly fetchAllRefs: (client: SyncGlofoxClient, ctx: SyncRunContext) => Promise<string[]>;
  /** The Kelo slice table's known refs (the population deletion applies to). */
  readonly keloRefs: (pool: PooledQueryable, tenantId: string) => Promise<string[]>;
  /** Entity-specific fact handling; people intentionally define no hook. */
  readonly markConfirmed?: (
    tx: PooledQueryable,
    tenantId: string,
    refs: readonly string[],
  ) => Promise<void>;
  readonly alertExplanation: string;
}

/** Identity-only row read — see the module header for the abort rule. */
const memberRefRowSchema = z.object({ _id: z.string() });

const membersDeletionSpec: DeletionEntitySpec = {
  entity: "members",
  alertExplanation:
    "REVIEW ONLY — people are never auto-deleted, updated, or deactivated by snapshot detection.",

  fetchAllRefs: async (client) => {
    const refs = new Set<string>();
    let page = 1;
    for (;;) {
      // active='any': soft-deleted members stay listed — only true
      // disappearance is deletion evidence (module header).
      const payload = await client.fetch(
        withQuery("/2.0/members", { page, limit: PAGE_LIMIT, active: "any" }),
      );
      const rows = extractStyleARows(payload);
      for (const row of rows) {
        const parsed = memberRefRowSchema.safeParse(row);
        if (!parsed.success) {
          throw new Error(
            `members page ${page}: a row has no readable string _id — aborting the ` +
              "snapshot (a dirty snapshot is not absence evidence)",
          );
        }
        refs.add(parsed.data._id);
      }
      if (!styleAHasNextPage(payload)) return [...refs];
      page += 1;
    }
  },

  keloRefs: async (pool, tenantId) => {
    const result = await pool.query(
      `select external_ref from public.people where tenant_id = $1 and external_ref is not null`,
      [tenantId],
    );
    return result.rows
      .map((row) => (row as { external_ref?: unknown }).external_ref)
      .filter((ref): ref is string => typeof ref === "string");
  },
};

const bookingRefRowSchema = z.object({ _id: z.string() });

const bookingsDeletionSpec: DeletionEntitySpec = {
  entity: "bookings",
  alertExplanation:
    "Confirmed booking misses are marked deleted-in-source with deleted_at. This is NOT a purge: the retained fact remains reviewable and is excluded only from active counts.",

  fetchAllRefs: async (client, ctx) => {
    if (ctx.branchId === undefined) {
      throw new Error("bookings deletion detection requires ctx.branchId");
    }
    const refs = new Set<string>();
    let page = 1;
    for (;;) {
      const payload = await client.fetch(
        withQuery(`/2.2/branches/${encodeURIComponent(ctx.branchId)}/bookings`, {
          page,
          limit: PAGE_LIMIT,
        }),
      );
      const rows = extractStyleBRows(payload);
      for (const row of rows) {
        const parsed = bookingRefRowSchema.safeParse(row);
        if (!parsed.success) {
          throw new Error(
            `bookings page ${page}: a row has no readable string _id — aborting the ` +
              "snapshot (a dirty snapshot is not absence evidence)",
          );
        }
        refs.add(parsed.data._id);
      }
      if (rows.length < PAGE_LIMIT) return [...refs];
      if (page >= 500) {
        throw new Error(
          "bookings snapshot exceeded 500 pages — refusing a possibly partial snapshot",
        );
      }
      page += 1;
    }
  },

  keloRefs: async (pool, tenantId) => {
    const result = await pool.query(
      `select external_ref from public.glofox_bookings where tenant_id = $1`,
      [tenantId],
    );
    return result.rows
      .map((row) => (row as { external_ref?: unknown }).external_ref)
      .filter((ref): ref is string => typeof ref === "string");
  },

  markConfirmed: async (tx, tenantId, refs) => {
    if (refs.length === 0) return;
    await tx.query(
      `update public.glofox_bookings
       set deleted_at = now()
       where tenant_id = $1 and external_ref = any($2::text[]) and deleted_at is null`,
      [tenantId, refs],
    );
  },
};

const DELETION_SPECS: Record<(typeof DELETION_ENTITIES)[number], DeletionEntitySpec> = {
  members: membersDeletionSpec,
  bookings: bookingsDeletionSpec,
};

/** How one entity's detection run ended — returned for tests + logging. */
export interface DeletionOutcome {
  readonly entity: string;
  readonly status: "ok" | "error";
  readonly snapshotRefs: number;
  /** Refs missing from the LATEST snapshot only (status 'candidate'). */
  readonly newCandidates: number;
  /** Refs missing from TWO consecutive snapshots (status 'confirmed'). */
  readonly confirmed: number;
  /** Open candidates auto-resolved because the ref REAPPEARED (reactivation). */
  readonly resolved: number;
  readonly error?: string;
}

interface PreviousSnapshot {
  readonly refs: ReadonlySet<string>;
  readonly snapshotAt: string | null;
}

async function readPreviousSnapshot(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  entity: string,
): Promise<PreviousSnapshot | null> {
  const result = await pool.query(
    `select external_refs, snapshot_at from public.import_snapshots
     where tenant_id = $1 and entity = $2
     order by snapshot_at desc limit 1`,
    [ctx.tenantId, entity],
  );
  const row = result.rows[0] as { external_refs?: unknown; snapshot_at?: unknown } | undefined;
  if (row === undefined || !Array.isArray(row.external_refs)) return null;
  return {
    refs: new Set(row.external_refs.filter((r): r is string => typeof r === "string")),
    snapshotAt:
      row.snapshot_at instanceof Date
        ? row.snapshot_at.toISOString()
        : String(row.snapshot_at ?? ""),
  };
}

async function detectEntityDeletions(
  pool: PooledQueryable,
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
  spec: DeletionEntitySpec,
): Promise<DeletionOutcome> {
  const refs = await spec.fetchAllRefs(client, ctx);
  const currentRefs = new Set(refs);
  const previous = await readPreviousSnapshot(pool, ctx, spec.entity);
  const keloRefs = await spec.keloRefs(pool, ctx.tenantId);
  const nowIso = ctx.now().toISOString();

  // The two-consecutive-miss law (plan §4 step 6): missing from the latest
  // snapshot only → 'candidate'; missing from BOTH → 'confirmed'. With no
  // previous snapshot every miss is a first miss (never confirm off one pass).
  const misses = keloRefs.filter((ref) => !currentRefs.has(ref));
  const candidates: string[] = [];
  const confirmed: string[] = [];
  for (const ref of misses) {
    if (previous !== null && !previous.refs.has(ref)) {
      confirmed.push(ref);
    } else {
      candidates.push(ref);
    }
  }

  // ONE transaction: snapshot row + reappearance resolutions + candidate
  // upserts commit together (module header).
  const resolved = await withTransaction(pool, async (tx) => {
    await tx.query(
      `insert into public.import_snapshots (tenant_id, entity, snapshot_at, external_refs, ref_count)
       values ($1, $2, $3, $4::text[], $5)`,
      [ctx.tenantId, spec.entity, nowIso, refs, refs.length],
    );

    // Reactivation (README §6): a ref present again resolves its own open
    // candidate — a deletion candidate is a REVIEW item, never a purge.
    const resolvedRows = await tx.query(
      `update public.deletion_candidates
       set status = 'resolved',
           detail = detail || $4::jsonb
       where tenant_id = $1 and entity = $2 and status in ('candidate', 'confirmed')
         and external_ref = any($3::text[])
       returning external_ref`,
      [
        ctx.tenantId,
        spec.entity,
        refs,
        JSON.stringify({ resolution_source: "snapshot_reappeared", resolved_snapshot_at: nowIso }),
      ],
    );
    // Upsert the misses. The partial unique (tenant_id, entity, external_ref)
    // where status in ('candidate','confirmed') keys the conflict; status is
    // the freshly computed truth (candidate→confirmed is monotonic), the first
    // miss timestamp is never rewritten, and detail merges (new keys win).
    for (const ref of candidates) {
      await tx.query(
        `insert into public.deletion_candidates
           (tenant_id, entity, external_ref, first_missing_at, status, detail)
         values ($1, $2, $3, $4, 'candidate', $5)
         on conflict (tenant_id, entity, external_ref) where status in ('candidate', 'confirmed')
         do update set status = excluded.status,
           detail = deletion_candidates.detail || excluded.detail`,
        [
          ctx.tenantId,
          spec.entity,
          ref,
          nowIso,
          JSON.stringify({ evidence: "absent from the latest full snapshot", snapshot_at: nowIso }),
        ],
      );
    }
    for (const ref of confirmed) {
      await tx.query(
        `insert into public.deletion_candidates
           (tenant_id, entity, external_ref, first_missing_at, confirmed_missing_at, status, detail)
         values ($1, $2, $3, $4, $5, 'confirmed', $6)
         on conflict (tenant_id, entity, external_ref) where status in ('candidate', 'confirmed')
         do update set status = excluded.status,
           confirmed_missing_at = coalesce(deletion_candidates.confirmed_missing_at,
                                           excluded.confirmed_missing_at),
           detail = deletion_candidates.detail || excluded.detail`,
        [
          ctx.tenantId,
          spec.entity,
          ref,
          nowIso,
          nowIso,
          JSON.stringify({
            evidence: "absent from TWO consecutive full snapshots",
            snapshot_at: nowIso,
            previous_snapshot_at: previous?.snapshotAt ?? null,
          }),
        ],
      );
    }
    await spec.markConfirmed?.(tx, ctx.tenantId, confirmed);
    return resolvedRows.rows.length;
  });

  if (candidates.length > 0 || confirmed.length > 0) {
    await openAlert(pool, ctx, spec.entity, {
      kind: "deletion_candidates",
      severity: "warning",
      title: `${spec.entity} deletion candidates: ${candidates.length} new, ${confirmed.length} confirmed`,
      body:
        `Full snapshot saw ${refs.length} ${spec.entity} refs; ${candidates.length} Kelo ref(s) ` +
        `missing from the latest snapshot (first miss) and ${confirmed.length} missing from TWO ` +
        `consecutive snapshots. ${spec.alertExplanation} Webhook-based member detection is ` +
        `deferred (no webhook secret yet, BLOCKERS P0-7); snapshots remain the plan's safety net.`,
    });
  }

  return {
    entity: spec.entity,
    status: "ok",
    snapshotRefs: refs.length,
    newCandidates: candidates.length,
    confirmed: confirmed.length,
    resolved,
  };
}

/**
 * Run deletion detection for the configured entities (payload.entities filters
 * DELETION_ENTITIES). Never throws for a per-entity failure — the alert + the
 * error outcome IS the failure surface. A throw means the DB itself is gone.
 */
export async function runDeletionDetection(
  pool: PooledQueryable,
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
): Promise<DeletionOutcome[]> {
  const rawEntities = ctx.payload["entities"];
  const entities = Array.isArray(rawEntities)
    ? DELETION_ENTITIES.filter((e) => rawEntities.includes(e))
    : DELETION_ENTITIES;

  const outcomes: DeletionOutcome[] = [];
  for (const entity of entities) {
    const spec = DELETION_SPECS[entity];
    try {
      outcomes.push(await detectEntityDeletions(pool, client, ctx, spec));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await openAlert(pool, ctx, entity, {
        kind: "deletion_detection_error",
        severity: "warning",
        title: `${entity} deletion detection failed: ${message.slice(0, 120)}`,
        body: message,
      });
      outcomes.push({
        entity,
        status: "error",
        snapshotRefs: 0,
        newCandidates: 0,
        confirmed: 0,
        resolved: 0,
        error: message,
      });
    }
  }
  return outcomes;
}
