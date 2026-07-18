import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
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
 * the rail shows exactly what exists — Today, Ask, Import review (with an open-
 * exception count badge), and Health (with its quiet status dot). The top
 * chrome carries the freshness indicator
 * (worst-of-sources) plus the signed-in actor.
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

/** Inbox-tray glyph for the Import review rail item (currentColor, no raw hex). */
function ImportNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-4 w-4 text-icon-inactive"
    >
      <path d="M2 9.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V9.5" />
      <path d="M2 9.5h3.2l1.3 2h3l1.3-2H14L11.6 3.6a1.5 1.5 0 0 0-1.4-1.1H5.8a1.5 1.5 0 0 0-1.4 1.1L2 9.5Z" />
    </svg>
  );
}

/** Calibrated gauge glyph for the morning review. */
function TodayNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-4 w-4 text-icon-inactive"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function AskNavIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 text-icon-inactive">
      <path d="M3 3.5h10v7H8l-3 2v-2H3v-7Z" />
      <path d="M6.4 6.2a1.7 1.7 0 1 1 2.5 1.5c-.6.3-.9.6-.9 1" />
    </svg>
  );
}

/**
 * Open-exception count badge (design guide §8 count badges), read from the
 * /health envelope's quarantine summary — no extra fetch. Quiet when the
 * count is zero or unknown: zero open exceptions is not a thing to wave.
 */
function ImportNavBadge() {
  const auth = useAuth();
  const query = useHealthQuery(auth.accessToken ?? undefined);
  if (query.status !== "success") {
    return null;
  }
  const inspection = inspectEnvelope<HealthReport>(query.data);
  if (!inspection.ok) {
    return null;
  }
  const count = inspection.data.quarantine.open_count;
  if (count === 0) {
    return null;
  }
  return (
    <span className="ml-auto rounded-full border border-warning-border bg-warning-tint px-2 py-0.5 font-mono text-micro text-warning-on-tint">
      {count}
    </span>
  );
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

const NAV_LINK_BASE = "flex items-center gap-2 rounded-2 px-3 py-2 text-body text-ink-secondary";
const NAV_LINK_ACTIVE = "bg-selected-bg font-medium text-ink";

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const screenLabel = pathname.startsWith("/import")
    ? "Import review"
    : pathname.startsWith("/ask")
      ? "Ask"
      : pathname.startsWith("/schedule")
        ? "Schedule"
        : pathname.startsWith("/briefing/archive")
          ? "Briefing archive"
    : pathname.startsWith("/health")
      ? "Health"
      : "Today";
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
          <ul className="space-y-1">
            <li>
              <Link
                to="/"
                className={NAV_LINK_BASE}
                activeOptions={{ exact: true }}
                activeProps={{ className: NAV_LINK_ACTIVE }}
              >
                <TodayNavIcon />
                Today
              </Link>
            </li>
            <li>
              <Link to="/ask" className={NAV_LINK_BASE} activeProps={{ className: NAV_LINK_ACTIVE }}>
                <AskNavIcon />
                Ask
              </Link>
            </li>
            <li>
              <Link
                to="/import"
                className={NAV_LINK_BASE}
                activeProps={{ className: NAV_LINK_ACTIVE }}
              >
                <ImportNavIcon />
                Import review
                <ImportNavBadge />
              </Link>
            </li>
            <li>
              <Link
                to="/health"
                className={NAV_LINK_BASE}
                activeProps={{ className: NAV_LINK_ACTIVE }}
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
          <span className="text-chrome text-ink-muted">{screenLabel}</span>
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
