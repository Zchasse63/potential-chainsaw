import type { Hono } from "hono";
import { AUTHORITY_MATRIX } from "../authority.js";
import {
  fetchOpenAlerts,
  fetchQuarantineCauses,
  fetchRecentSyncRuns,
  fetchReconciliations,
  fetchSyncStates,
} from "../data.js";
import { freshnessBucket, minutesSince } from "../freshness.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";

export function registerHealthRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // PUBLIC dead-man heartbeat + uptime target (plan-final §1 observability +
  // §3 "unauthenticated /health/ping for the heartbeat"). The ONE endpoint
  // exempt from auth AND from the freshness envelope by design.
  app.on(["GET", "HEAD"], "/health/ping", (c) =>
    c.json({ status: "ok", time: new Date().toISOString() }, 200),
  );

  // Operational truth for the resolved tenant (plan-final §1: "the Health
  // page renders from these tables"). Read via the user-scoped client (RLS).
  app.get("/health", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);

    const [states, runs, alerts, causes, reconciliation] = await Promise.all([
      fetchSyncStates(userClient, tenantId),
      fetchRecentSyncRuns(userClient, tenantId, 20),
      fetchOpenAlerts(userClient, tenantId),
      fetchQuarantineCauses(userClient, tenantId),
      fetchReconciliations(userClient, tenantId, { limit: 10 }),
    ]);

    const now = Date.now();
    const freshness = states.map((state) => {
      const minutesStale = minutesSince(state.last_success_at, now);
      return {
        entity: state.entity,
        health_state: state.health_state,
        last_success_at: state.last_success_at,
        minutes_stale: minutesStale,
        bucket: freshnessBucket(minutesStale),
      };
    });

    return c.json(
      c.var.ok(
        {
          freshness,
          sync_runs: runs,
          alerts,
          authority: AUTHORITY_MATRIX,
          // Compact quarantine summary (migration 0007) — the full review
          // queue lives at /import/quarantine.
          quarantine: {
            open_count: causes.reduce((total, cause) => total + cause.open_count, 0),
            by_cause: causes,
          },
          // Recent Kelo-vs-Glofox reconciliation (unit 1.5's table; pending
          // is the honest 42P01 bridge until it lands).
          reconciliation: {
            pending: reconciliation.pending,
            recent: reconciliation.rows,
          },
        },
        // The envelope must not claim freshness the data doesn't have: any
        // critically-stale entity marks the whole report stale.
        { stale: freshness.some((f) => f.bucket === "critical") },
      ),
      200,
    );
  });
}
