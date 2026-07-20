import type { ReactNode } from "react";
import type { Envelope, MemberScheduleItem, MemberScheduleResponse } from "@kelo/contracts";
import { DataBoundary, EmptyState, Skeleton, type BoundaryQuery } from "@kelo/ui/react";

/**
 * The public session list (unit 8.1d) — the Choose stage's read-only core
 * (plan-ux §H: real availability first, honest waitlist). Phone-first, one
 * column, no booking actions: Identify/Waiver/Pay land in later units
 * (W8-2/W8-3 — see routes/index.tsx).
 *
 * Rendering goes through the DEFAULT shared DataBoundary — the provenance
 * contract governs member screens identically (invariant #3). The member
 * "quiet-copy staleness" variant (plan-member-app §6.4) is deliberately NOT
 * built here; it's a later polish unit (invariant #9), so the operator-grade
 * stale banner is what shows until then.
 */

/** What the SSR loader returns (JSON-serializable — it crosses the wire). */
export type ScheduleLoadResult =
  | {
      ok: true;
      /** The raw freshness envelope — DataBoundary re-inspects it on render. */
      envelope: Envelope<MemberScheduleResponse>;
      /** IANA tz the studio runs in; display-only, never secret. */
      timeZone: string;
    }
  | { ok: false; error: { kind: string; message: string; status?: number } };

function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function SessionRow({ session, timeZone }: { session: MemberScheduleItem; timeZone: string }) {
  const full = session.available === 0;
  // The Choose → Book link (plan-ux §H). A plain anchor (not a router Link) so
  // this shared presentational row stays router-agnostic and unit-testable
  // without a RouterProvider; TanStack Start SSRs the /book target on nav. Full
  // sessions link too — the booking screen offers the honest waitlist there.
  const href = `/book/${encodeURIComponent(session.session_id)}`;
  const label = full
    ? `Join the waitlist for ${session.offering_name}`
    : `Book ${session.offering_name}`;
  return (
    <li>
      <a
        href={href}
        aria-label={label}
        className="block rounded-3 border border-hairline bg-surface-card p-4 shadow-1 transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-body font-medium text-ink">{session.offering_name}</p>
            <p className="mt-0.5 text-body text-ink-secondary">
              {timeLabel(session.starts_at, timeZone)} – {timeLabel(session.ends_at, timeZone)}
            </p>
          </div>
          <p className="shrink-0 text-body text-ink-muted">
            {session.credit_cost} {session.credit_cost === 1 ? "credit" : "credits"}
          </p>
        </div>
        <p className="mt-2 flex items-center justify-between gap-3 text-body">
          {full ? (
            // Honest waitlist (plan-ux §H): a full session says so plainly and
            // the tap goes to the waitlist-join on the booking screen.
            <span className="font-medium text-ink-secondary">Full — waitlist available</span>
          ) : (
            <span className="text-ink-secondary">
              {session.available} of {session.capacity}{" "}
              {session.available === 1 ? "spot" : "spots"} left
            </span>
          )}
          <span aria-hidden="true" className="shrink-0 font-medium text-brand-600">
            {full ? "Join waitlist →" : "Book →"}
          </span>
        </p>
      </a>
    </li>
  );
}

function SessionList({ sessions, timeZone }: { sessions: MemberScheduleResponse; timeZone: string }) {
  const sorted = [...sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const rows: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const session of sorted) {
    const day = dayLabel(session.starts_at, timeZone);
    if (day !== lastDay) {
      lastDay = day;
      rows.push(
        <li key={`day-${day}`} aria-hidden="false" className="pt-4 first:pt-0">
          <h2 className="font-mono text-micro uppercase tracking-wide text-ink-muted">{day}</h2>
        </li>,
      );
    }
    rows.push(<SessionRow key={session.session_id} session={session} timeZone={timeZone} />);
  }
  return <ul className="space-y-3">{rows}</ul>;
}

export function SchedulePage({
  result,
  onRefresh,
}: {
  result: ScheduleLoadResult;
  onRefresh: () => void;
}) {
  // Adapt the SSR loader result into the BoundaryQuery shape — the same
  // provenance contract apps/web feeds from TanStack Query (invariant #3).
  const query: BoundaryQuery = result.ok
    ? { status: "success", data: result.envelope, refetch: onRefresh }
    : { status: "error", error: new Error(result.error.message), refetch: onRefresh };

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 pb-12 pt-6">
      <header className="pb-6">
        <h1 className="text-title font-medium text-ink">Upcoming sessions</h1>
        <p className="mt-1 text-body text-ink-muted">
          Real availability, straight from the studio&apos;s book.
        </p>
      </header>
      <DataBoundary<MemberScheduleResponse>
        name="member-schedule"
        query={query}
        skeleton={
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-24 w-full rounded-3" />
            <Skeleton className="h-24 w-full rounded-3" />
            <Skeleton className="h-24 w-full rounded-3" />
          </div>
        }
        errorConsequence="The session list didn't load, so you can't see which sessions have space right now. Nothing was booked or changed."
        isEmpty={(sessions) => sessions.length === 0}
        emptyState={
          <EmptyState
            title="No sessions in the next two weeks"
            body="This is the studio's live book — nothing is published for this window yet. New sessions appear here the moment the studio publishes them."
          />
        }
      >
        {(sessions) =>
          result.ok ? <SessionList sessions={sessions} timeZone={result.timeZone} /> : null
        }
      </DataBoundary>
    </main>
  );
}
