import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "../auth/auth-context.jsx";
import { inspectEnvelope } from "../lib/envelope.js";
import { aggregateFreshness, useHealthQuery, type HealthReport } from "../lib/health.js";
import type { FreshnessBucket } from "../lib/freshness.js";
import { Button } from "./button.jsx";
import { FreshnessChip } from "./freshness-chip.jsx";
import { Skeleton } from "./skeleton.jsx";

/**
 * AppShell — owner-desktop frame (design guide §8): 232px left rail + top
 * chrome. UX ruling 9: a nav item appears ONLY when its feature ships, so
 * phase 0 shows exactly one item — Health, with a quiet status dot. The top
 * chrome carries the freshness indicator (worst-of-sources for the current
 * screen — and /health IS the only screen) plus the signed-in actor.
 */

const DOT_CLASS: Record<FreshnessBucket, string> = {
  live: "bg-success",
  synced: "bg-neutral-400",
  stale: "bg-warning",
  critical: "bg-danger",
  unknown: "bg-neutral-400",
};

function HealthNavDot() {
  const auth = useAuth();
  const query = useHealthQuery(auth.accessToken ?? undefined);
  if (query.status !== "success") {
    return <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-neutral-400" />;
  }
  const inspection = inspectEnvelope<HealthReport>(query.data);
  const bucket = inspection.ok ? aggregateFreshness(inspection.data.freshness).bucket : "unknown";
  return <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[bucket]}`} />;
}

function ChromeFreshness() {
  const auth = useAuth();
  const query = useHealthQuery(auth.accessToken ?? undefined);
  if (query.status === "pending") {
    return <Skeleton className="h-5 w-20" />;
  }
  if (query.status !== "success") {
    // The page region renders the error state; the chrome stays quiet rather
    // than double-reporting.
    return null;
  }
  const inspection = inspectEnvelope<HealthReport>(query.data);
  if (!inspection.ok) {
    return null;
  }
  const aggregate = aggregateFreshness(inspection.data.freshness);
  return <FreshnessChip bucket={aggregate.bucket} minutesStale={aggregate.minutesStale} />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return (
    <div className="flex min-h-screen bg-surface-app">
      <aside className="flex w-rail shrink-0 flex-col border-r border-hairline bg-surface-card">
        <div className="border-b border-hairline px-5 py-4">
          <span className="font-display text-title font-bold tracking-tight">kelo</span>
          <span className="ml-2 border-l border-hairline pl-2 font-mono text-micro uppercase tracking-wide text-ink-muted">
            Studio Operations
          </span>
        </div>
        <nav aria-label="Primary" className="flex-1 px-3 py-4">
          <ul>
            <li>
              <Link
                to="/health"
                className="flex items-center gap-2 rounded-2 bg-selected-bg px-3 py-2 text-body font-medium text-ink"
              >
                <HealthNavDot />
                Health
              </Link>
            </li>
          </ul>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-hairline bg-surface-card px-6">
          <span className="text-chrome text-ink-muted">Health</span>
          <div className="flex items-center gap-4">
            <ChromeFreshness />
            {auth.userEmail !== null && (
              <span className="text-chrome text-ink-secondary">{auth.userEmail}</span>
            )}
            <Button
              variant="ghost"
              className="h-9 px-2 text-chrome"
              onClick={() => void auth.client?.auth.signOut()}
            >
              Sign out
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
