import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { bookSeat, createMemberApiClient, fetchAccount, joinWaitlist } from "@kelo/member-core";
import type { MemberScheduleItem } from "@kelo/contracts";
import { EmptyState } from "@kelo/ui/react";
import { BookingPanel } from "../components/booking-panel.jsx";
import { toAccountLoad, toBookOutcome, toWaitlistOutcome } from "../lib/booking-outcome.js";

/**
 * `/book/$sessionId` — the Book → Confirmed stage (plan-member-app §3H).
 *
 * Split-authority by design: the SSR loader looks the session up in the PUBLIC
 * schedule (anonymous, no member cookie needed, deep-link-safe on hard reload)
 * and returns only its display + live-availability facts. The BOOKING itself is
 * client-side and session-scoped — account/book/waitlist ride the host-only
 * cookie through the same-origin `/api/*` proxy, so the person is the session's
 * person, never anything this route sends.
 *
 * Thin-server rule (plan §2): the server fn reads public env + calls the Hono
 * API; no secrets, no DB, no Supabase material.
 */

const WINDOW_DAYS = 14;

type SessionLoad =
  | { ok: true; session: MemberScheduleItem; timeZone: string }
  | { ok: false; kind: "not_found" | "config" | "error"; message: string };

const getBookableSession = createServerFn({ method: "GET" })
  .validator((sessionId: string): string => sessionId)
  .handler(async ({ data: sessionId }): Promise<SessionLoad> => {
    const origin = process.env.KELO_API_ORIGIN;
    const tenant = process.env.KELO_TENANT_ID;
    if (origin === undefined || tenant === undefined) {
      return { ok: false, kind: "config", message: "The studio's booking system isn't configured yet." };
    }

    const now = new Date();
    const result = await createMemberApiClient().fetchSchedule({
      origin,
      tenant,
      from: now.toISOString(),
      to: new Date(now.getTime() + WINDOW_DAYS * 86_400_000).toISOString(),
    });
    if (!result.ok) {
      return { ok: false, kind: "error", message: "We couldn't load the schedule. Please try again." };
    }

    const session = result.sessions.find((s) => s.session_id === sessionId);
    if (session === undefined) {
      // Not in the bookable window (or gone) — you book what you can see.
      return {
        ok: false,
        kind: "not_found",
        message: "This session isn't open for booking. It may have started, filled, or been removed.",
      };
    }

    return { ok: true, session, timeZone: process.env.KELO_TENANT_TIMEZONE ?? "UTC" };
  });

export const Route = createFileRoute("/book/$sessionId")({
  loader: ({ params }) => getBookableSession({ data: params.sessionId }),
  component: BookRoute,
});

function BookRoute() {
  const load = Route.useLoaderData();
  const router = useRouter();

  if (!load.ok) {
    return (
      <main className="mx-auto max-w-sm p-4">
        <EmptyState title="Can't book this session" body={load.message} />
      </main>
    );
  }

  const { session, timeZone } = load;
  const sessionId = session.session_id;

  return (
    <main>
      <BookingPanel
        session={session}
        formatWhen={(startsAt, endsAt) => formatWhen(startsAt, endsAt, timeZone)}
        // The classifiers (../lib/booking-outcome) own the status/code → outcome
        // mapping — pure and unit-tested. Same-origin ("") rides the /api proxy
        // so the host-only session cookie scopes every call to its own person.
        loadAccount={() => fetchAccount({ origin: "" }).then(toAccountLoad)}
        onBook={(idempotencyKey) =>
          bookSeat({ origin: "", sessionId, idempotencyKey, platform: "web" }).then(toBookOutcome)
        }
        onJoinWaitlist={(idempotencyKey) =>
          joinWaitlist({ origin: "", sessionId, idempotencyKey, platform: "web" }).then(toWaitlistOutcome)
        }
        onRequireSignIn={() => void router.navigate({ to: "/signin" })}
        makeIdempotencyKey={() => crypto.randomUUID()}
      />
    </main>
  );
}

/** Compact, explicit-tz session range so SSR and hydration match (plan §H). */
function formatWhen(startsAt: string, endsAt: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(startsAt));
  const t = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(
      new Date(iso),
    );
  return `${day} · ${t(startsAt)} – ${t(endsAt)}`;
}
