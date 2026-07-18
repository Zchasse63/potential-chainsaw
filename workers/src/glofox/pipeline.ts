import { GlofoxAuthError, rawPageEnvelope } from "@kelo/glofox";
import type { Queryable } from "../processors.js";
import type {
  EntitySpec,
  PooledQueryable,
  RawFetch,
  SyncGlofoxClient,
  SyncOutcome,
  SyncQuarantineRow,
  SyncRunContext,
  SyncStateRow,
} from "./types.js";

/**
 * Phase 1 · unit 4 — THE PIPELINE (plan-final §4 steps 1–6) and THE WATERMARK
 * LAW. The historical killer was a silent import freeze, so the tripwires are
 * the product:
 *
 *   RAW BEFORE PARSE (step 1): every fetched page is inserted into glofox_raw
 *   (hash-deduped) BEFORE its envelope is parsed. The raw zone always has the
 *   evidence; a parse failure never loses the page.
 *
 *   PER-ROW SALVAGE (step 2): envelope structure parses leniently (rows stay
 *   unknown[]), then each row is strict-parsed + mapped individually. A bad
 *   row goes to import_quarantine; it NEVER kills the page or blocks the
 *   watermark. An ENVELOPE-level failure is schema-invalid → the run errors.
 *
 *   CANDIDATE IN THE SAME TXN (step 3): each batch commits BEGIN → upserts →
 *   quarantine inserts → sync_state.candidate_watermark → COMMIT. A crash can
 *   never desync the upserts from the candidate.
 *
 *   WATERMARK LAW (tripwire 1): committed_watermark advances ONLY at the
 *   successful end of a schema-valid run, to the candidate. Row-level
 *   quarantines do NOT block advancement (they are visible + reviewable).
 *   ZERO-ROW runs advance only when sync_state.plausible_zero (tripwire 2);
 *   otherwise the run is recorded 'empty_suspect', consecutive_empty
 *   increments, and crossing empty_alarm_threshold opens a critical
 *   'sync_empty_suspect' alert (tripwire 3). Non-empty successes reset
 *   consecutive_empty. Tripwire 4: a full/backfill run below
 *   expected_min_records alerts 'sync_below_expected_min' (warning) but still
 *   records and advances (only ever to the candidate, never past it).
 *
 *   ERRORS (step 6): any thrown error finalizes sync_runs as 'error', sets
 *   health_state 'error' (or 'paused_auth_failed' + paused=true + a critical
 *   'glofox_auth_failed' alert on GlofoxAuthError), opens a 'sync_failed'
 *   warning alert (deduped per tenant+entity), and RETHROWS so the job
 *   layer's fail/backoff applies. No watermark advances on error — completed
 *   batches keep their committed candidates, so a retry resumes from the
 *   committed watermark and re-upserts idempotently.
 *
 *   PAUSED: sync_state.paused=true no-ops BEFORE any fetch or sync_runs row
 *   (the auth-failure circuit breaker; a human unpauses after re-credentialling).
 */

// --- sync_state / sync_runs / alerts / raw zone SQL ------------------------------
// The workers hold the service role and write these tables directly over the
// pool — plain SQL, no new app.* functions (migration 0010).

async function ensureSyncState<TRow>(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  spec: EntitySpec<TRow>,
): Promise<SyncStateRow> {
  await pool.query(
    `insert into public.sync_state (tenant_id, entity, plausible_zero, empty_alarm_threshold)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, entity) do nothing`,
    [
      ctx.tenantId,
      spec.entity,
      spec.defaults.plausibleZero,
      spec.defaults.emptyAlarmThreshold ?? 3,
    ],
  );
  const result = await pool.query(
    `select * from public.sync_state where tenant_id = $1 and entity = $2`,
    [ctx.tenantId, spec.entity],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error(`sync_state row missing for ${ctx.tenantId}/${spec.entity} after ensure`);
  }
  return {
    ...(row as unknown as SyncStateRow),
    committed_watermark: toIso(row["committed_watermark"]),
    candidate_watermark: toIso(row["candidate_watermark"]),
  };
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function openSyncRun<TRow>(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  spec: EntitySpec<TRow>,
  windowStart: Date | null,
  windowEnd: Date | null,
): Promise<string> {
  const result = await pool.query(
    `insert into public.sync_runs (tenant_id, entity, job_id, status, window_start, window_end)
     values ($1, $2, $3, 'running', $4, $5)
     returning id`,
    [
      ctx.tenantId,
      spec.entity,
      ctx.jobId,
      windowStart?.toISOString() ?? null,
      windowEnd?.toISOString() ?? null,
    ],
  );
  const id = (result.rows[0] as { id?: string } | undefined)?.id;
  if (typeof id !== "string") throw new Error("sync_runs insert returned no id");
  return id;
}

async function closeSyncRun(
  pool: PooledQueryable,
  syncRunId: string,
  status: "success" | "error" | "empty_suspect",
  totals: { fetched: number; upserted: number; quarantined: number },
  error: string | null,
): Promise<void> {
  await pool.query(
    `update public.sync_runs
     set finished_at = now(), status = $2, rows_fetched = $3, rows_upserted = $4,
         rows_quarantined = $5, error = $6
     where id = $1`,
    [syncRunId, status, totals.fetched, totals.upserted, totals.quarantined, error],
  );
}

/** Step 1 — the raw zone FIRST, hash-deduped. Append-only; never mutated after. */
async function insertRawPage<TRow>(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  spec: EntitySpec<TRow>,
  syncRunId: string,
  fetched: RawFetch,
): Promise<void> {
  const page = rawPageEnvelope(fetched.endpoint, fetched.requestMeta, fetched.payload);
  await pool.query(
    `insert into public.glofox_raw (tenant_id, endpoint, request_meta, payload, payload_hash, sync_run_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, endpoint, payload_hash) do nothing`,
    [
      ctx.tenantId,
      page.endpoint,
      // mapper_version rides in request_meta: sync_runs has no column for it
      // (migration 0006), and the mapper contract asks the sync layer to record it.
      JSON.stringify({ ...page.request_meta, mapper_version: spec.mapperVersion }),
      JSON.stringify(page.payload),
      page.payload_hash,
      syncRunId,
    ],
  );
}

async function insertQuarantineRows(
  tx: Queryable,
  ctx: SyncRunContext,
  syncRunId: string,
  rows: readonly SyncQuarantineRow[],
): Promise<void> {
  for (const row of rows) {
    await tx.query(
      `insert into public.import_quarantine (tenant_id, entity, external_ref, payload, reason, sync_run_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        ctx.tenantId,
        row.entity,
        row.external_ref,
        JSON.stringify(row.payload ?? null),
        row.reason,
        syncRunId,
      ],
    );
  }
}

/** Exported for the reconcile/deletion units (1.5) — THE alert writer. */
export async function openAlert(
  pool: PooledQueryable,
  ctx: SyncRunContext,
  entity: string,
  alert: { kind: string; severity: "info" | "warning" | "critical"; title: string; body: string },
): Promise<void> {
  // The partial unique index (tenant_id, kind, dedupe_key) where status='open'
  // dedupes a recurring failure; dedupe_key is the entity for entity-scoped kinds.
  await pool.query(
    `insert into public.alerts (tenant_id, kind, severity, title, body, dedupe_key, context)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, kind, dedupe_key) where status = 'open' do nothing`,
    [
      ctx.tenantId,
      alert.kind,
      alert.severity,
      alert.title,
      alert.body,
      entity,
      JSON.stringify({ entity }),
    ],
  );
}

/** One client transaction per batch (step 3). A real pg Pool takes a dedicated
 * client; the recording fake in unit tests has no connect() and runs the same
 * statements on itself (single-threaded test drivers only).
 * Exported for the reconcile/deletion units (1.5). */
export async function withTransaction<T>(
  pool: PooledQueryable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (pool.connect !== undefined) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.query("begin");
  try {
    const result = await fn(pool);
    await pool.query("commit");
    return result;
  } catch (err) {
    await pool.query("rollback").catch(() => undefined);
    throw err;
  }
}

// --- branch timezone (the facts mappers need it for wall-time strings) -----------

async function resolveTimezone(
  pool: PooledQueryable,
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
): Promise<string> {
  // The per-tenant mapping: Glofox branch id == locations.external_ref
  // (plan-final §5 facts table). Single-branch tenants map to the sole location.
  let timezone: string | undefined;
  if (ctx.branchId !== undefined) {
    const byRef = await pool.query(
      `select timezone from public.locations where tenant_id = $1 and external_ref = $2`,
      [ctx.tenantId, ctx.branchId],
    );
    timezone = (byRef.rows[0] as { timezone?: string } | undefined)?.timezone;
  }
  if (timezone === undefined) {
    const sole = await pool.query(
      `select timezone from public.locations where tenant_id = $1 limit 2`,
      [ctx.tenantId],
    );
    if (sole.rows.length === 1) {
      timezone = (sole.rows[0] as { timezone?: string }).timezone;
    }
  }
  if (timezone === undefined) {
    // Fallback: ask Glofox for the branch and log the gap (locations seeding
    // is incomplete — the run must still import correctly).
    console.warn(
      `[glofox.sync] no locations row for tenant ${ctx.tenantId} branch ${ctx.branchId ?? "?"}; ` +
        "falling back to branch.get() for the timezone",
    );
    if (client.branchGet === undefined) {
      throw new Error("timezone unresolvable: no locations row and no branchGet fallback");
    }
    const branch = await client.branchGet();
    timezone = branch.address.timezone_id;
  }
  // A bogus zone is a CONFIG DEFECT, not data: fail loudly here, never
  // quarantine every row (Intl throws RangeError on an unknown zone).
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  return timezone;
}

// --- the pipeline ------------------------------------------------------------------

export async function runEntitySync<TRow>(
  pool: PooledQueryable,
  client: SyncGlofoxClient,
  ctx: SyncRunContext,
  spec: EntitySpec<TRow>,
): Promise<SyncOutcome> {
  const state = await ensureSyncState(pool, ctx, spec);

  // Circuit breaker: paused entities no-op BEFORE any fetch, sync_runs row, or
  // watermark touch. Set by the auth-failure path (or an operator); cleared by
  // a human. Documented behavior — a paused run writes nothing.
  if (state.paused) {
    console.info(`[glofox.sync] ${spec.entity} paused for tenant ${ctx.tenantId} — no-op`);
    return {
      status: "paused",
      syncRunId: null,
      rowsFetched: 0,
      rowsUpserted: 0,
      rowsQuarantined: 0,
    };
  }

  const windows = spec.windows(state, ctx);
  const windowStart = windows.map((w) => w.start).find((d) => d !== null) ?? null;
  const windowEnd = windows.length > 0 ? windows[windows.length - 1]!.end : null;
  const syncRunId = await openSyncRun(pool, ctx, spec, windowStart, windowEnd);

  const totals = { fetched: 0, upserted: 0, quarantined: 0 };
  let lastCandidate: Date | null = null;

  try {
    const timezone = spec.needsTimezone ? await resolveTimezone(pool, client, ctx) : "UTC";

    for (const window of windows) {
      for await (const fetched of spec.pages(pool, client, window, ctx)) {
        // STEP 1: raw BEFORE parse — always.
        await insertRawPage(pool, ctx, spec, syncRunId, fetched);

        // STEP 2: lenient envelope (a throw = schema-invalid run) + per-row salvage.
        const rawRows = spec.extractRows(fetched.payload);
        totals.fetched += rawRows.length;
        const mapped: TRow[] = [];
        const quarantined: SyncQuarantineRow[] = [];
        for (const rawRow of rawRows) {
          const result = spec.mapRow(rawRow, { tenantId: ctx.tenantId, timezone });
          mapped.push(...result.rows);
          quarantined.push(...result.quarantine);
        }

        // STEP 3: one transaction — upserts + quarantine + candidate watermark.
        const candidate = spec.candidateFor(window, ctx);
        await withTransaction(pool, async (tx) => {
          const { upserted, quarantine: dbQuarantine } = await spec.upsertBatch(tx, mapped, ctx);
          await insertQuarantineRows(tx, ctx, syncRunId, [...quarantined, ...dbQuarantine]);
          await tx.query(
            `update public.sync_state set candidate_watermark = $3 where tenant_id = $1 and entity = $2`,
            [ctx.tenantId, spec.entity, candidate.toISOString()],
          );
          totals.upserted += upserted;
          totals.quarantined += quarantined.length + dbQuarantine.length;
        });
        lastCandidate = candidate;
      }
    }

    // STEP 4: THE WATERMARK LAW.
    const candidate = lastCandidate ?? ctx.now();
    const fullRun = spec.fullListEveryRun || state.committed_watermark === null;

    if (totals.fetched === 0 && !state.plausible_zero) {
      // Tripwires 2+3: suspect-empty NEVER advances; the alarm counts up.
      const updated = await pool.query(
        `update public.sync_state
         set consecutive_empty = consecutive_empty + 1, last_run_at = $3
         where tenant_id = $1 and entity = $2
         returning consecutive_empty`,
        [ctx.tenantId, spec.entity, ctx.now().toISOString()],
      );
      const consecutive = (updated.rows[0] as { consecutive_empty?: number } | undefined)
        ?.consecutive_empty;
      if (typeof consecutive === "number" && consecutive >= state.empty_alarm_threshold) {
        await openAlert(pool, ctx, spec.entity, {
          kind: "sync_empty_suspect",
          severity: "critical",
          title: `${spec.entity} sync returned zero rows ${consecutive} runs in a row`,
          body:
            `The ${spec.entity} sync keeps fetching zero rows and plausible_zero is off — ` +
            `this is how the 10-week silent freeze looked. Watermark held at ` +
            `${state.committed_watermark ?? "(none)"}; investigate before trusting the data.`,
        });
      }
      await closeSyncRun(pool, syncRunId, "empty_suspect", totals, null);
      return {
        status: "empty_suspect",
        syncRunId,
        rowsFetched: 0,
        rowsUpserted: 0,
        rowsQuarantined: totals.quarantined,
      };
    }

    // Success (non-empty, or empty-but-plausible): committed = candidate. The
    // consecutive-empty counter resets ONLY on a non-empty success.
    const nonEmpty = totals.fetched > 0;
    await pool.query(
      `update public.sync_state
       set committed_watermark = $3, candidate_watermark = $3,
           consecutive_empty = case when $5 then 0 else consecutive_empty end,
           last_run_at = $4, last_success_at = $4, health_state = 'healthy'
       where tenant_id = $1 and entity = $2`,
      [ctx.tenantId, spec.entity, candidate.toISOString(), ctx.now().toISOString(), nonEmpty],
    );

    // Tripwire 4: full/backfill run below the expected floor — visible, but
    // the run still records and the watermark still advances (to candidate).
    if (
      fullRun &&
      state.expected_min_records !== null &&
      totals.fetched < state.expected_min_records
    ) {
      await openAlert(pool, ctx, spec.entity, {
        kind: "sync_below_expected_min",
        severity: "warning",
        title: `${spec.entity} full sync fetched ${totals.fetched} rows (expected ≥ ${state.expected_min_records})`,
        body:
          `A full ${spec.entity} run came in below the expected_min_records floor. ` +
          `The run was recorded and the watermark advanced to the candidate; verify the ` +
          `source before trusting downstream numbers.`,
      });
    }

    await closeSyncRun(pool, syncRunId, "success", totals, null);
    await spec.afterSuccess?.(pool, ctx);
    return {
      status: "success",
      syncRunId,
      rowsFetched: totals.fetched,
      rowsUpserted: totals.upserted,
      rowsQuarantined: totals.quarantined,
    };
  } catch (err) {
    // STEP 6: error path. NO watermark advances; completed batches keep their
    // candidates. Record, alert, rethrow (the job layer backs off/retries).
    const message = err instanceof Error ? err.message : String(err);
    await closeSyncRun(pool, syncRunId, "error", totals, message);
    if (err instanceof GlofoxAuthError) {
      // Dead credentials: stop hammering until a human re-enters them.
      await pool.query(
        `update public.sync_state
         set last_run_at = $3, health_state = 'paused_auth_failed', paused = true
         where tenant_id = $1 and entity = $2`,
        [ctx.tenantId, spec.entity, ctx.now().toISOString()],
      );
      await openAlert(pool, ctx, spec.entity, {
        kind: "glofox_auth_failed",
        severity: "critical",
        title: `Glofox credentials rejected — ${spec.entity} sync paused`,
        body: `${message}\n\nPaused automatically; re-enter credentials and unpause sync_state to resume.`,
      });
    } else {
      await pool.query(
        `update public.sync_state
         set last_run_at = $3, health_state = 'error'
         where tenant_id = $1 and entity = $2`,
        [ctx.tenantId, spec.entity, ctx.now().toISOString()],
      );
      await openAlert(pool, ctx, spec.entity, {
        kind: "sync_failed",
        severity: "warning",
        title: `${spec.entity} sync failed: ${message.slice(0, 120)}`,
        body: message,
      });
    }
    throw err;
  }
}
