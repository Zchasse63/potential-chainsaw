import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.jsx";
import { fetchEnvelope } from "../lib/api.js";
import {
  acceptWaitlistOffer,
  bookSession,
  checkIn,
  declineWaitlistOffer,
  fetchAvailability,
  fetchRoster,
  freezeHold,
  holdSession,
  joinWaitlist,
  releaseHold,
} from "../lib/bookings.js";
import { BookScreen } from "../screens/book-screen.jsx";
import { FrontDeskScreen } from "../screens/front-desk-screen.jsx";

/**
 * /book — Quick Book + Front desk (Phase 6 · unit 6.3). A thin wiring layer:
 * it opens the availability / waiver-status / roster reads and threads the
 * booking mutations into two presentational screens, then lets the operator
 * toggle between booking a seat and running a session's desk. A booking result
 * can jump straight to that session's check-in.
 *
 * The default slot window is the next 4 hours (plan-ux §3C), anchored once at
 * mount so the query key is stable across re-renders.
 */

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

type View = "book" | "front-desk";

export function BookRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const [view, setView] = useState<View>("book");
  const [deskSessionId, setDeskSessionId] = useState<string | null>(null);

  // Anchor the picker window once (stable query key).
  const window = useMemo(() => {
    const from = new Date();
    const to = new Date(from.getTime() + FOUR_HOURS_MS);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const availabilityQuery = useQuery({
    queryKey: ["bookings", "availability", window.from, window.to],
    enabled: accessToken !== undefined,
    queryFn: () => fetchAvailability(accessToken as string, window.from, window.to),
    retry: 1,
    // Availability is time-sensitive; refetch on focus so a held/booked seat by
    // another operator shows up rather than a stale open seat.
    refetchOnWindowFocus: true,
  });

  const token = accessToken as string;

  return (
    <div className="space-y-6">
      <div className="flex gap-2" role="tablist" aria-label="Booking views">
        <button
          type="button"
          role="tab"
          aria-selected={view === "book"}
          data-testid="view-book"
          onClick={() => setView("book")}
          className={`rounded-2 border px-3 py-2 text-body font-medium ${view === "book" ? "border-brand-600 bg-selected-bg text-ink" : "border-hairline text-ink-secondary"}`}
        >
          Quick Book
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "front-desk"}
          data-testid="view-front-desk"
          onClick={() => setView("front-desk")}
          className={`rounded-2 border px-3 py-2 text-body font-medium ${view === "front-desk" ? "border-brand-600 bg-selected-bg text-ink" : "border-hairline text-ink-secondary"}`}
        >
          Front desk
        </button>
      </div>

      {view === "book" ? (
        <BookScreen
          availabilityQuery={availabilityQuery}
          statusQueryFor={(personId) =>
            useWaiverStatusQuery(accessToken, personId)
          }
          onHold={(input) => holdSession(token, input)}
          onFreeze={(holdId) => freezeHold(token, holdId)}
          onRelease={(holdId) => releaseHold(token, holdId)}
          onBook={(input, key) => bookSession(token, input, key)}
          onJoinWaitlist={(input, key) => joinWaitlist(token, input, key)}
          onCheckIn={(sessionId) => {
            setDeskSessionId(sessionId);
            setView("front-desk");
          }}
        />
      ) : (
        <FrontDeskScreen
          key={deskSessionId ?? "no-session"}
          rosterQueryFor={(sessionId) => useRosterQuery(accessToken, sessionId)}
          onCheckIn={(_sessionId, bookingId, key) => checkIn(token, bookingId, key)}
          onAccept={(entryId, key) => acceptWaitlistOffer(token, entryId, key)}
          onDecline={(entryId, key) => declineWaitlistOffer(token, entryId, key)}
          initialSessionId={deskSessionId}
        />
      )}
    </div>
  );
}

/** GET /waivers/status/:personId — the person summary + booking waiver gate.
 *  Mirrors lib/waivers.useWaiverStatusQuery; inlined here so the booking route
 *  owns its reads. Called once per render by BookScreen (rules-of-hooks safe). */
function useWaiverStatusQuery(accessToken: string | undefined, personId: string | null) {
  return useQuery({
    queryKey: ["waivers", "status", personId],
    enabled: accessToken !== undefined && personId !== null,
    queryFn: () =>
      fetchEnvelope(`/waivers/status/${encodeURIComponent(personId as string)}`, accessToken as string),
    retry: false,
  });
}

/** GET /sessions/:id/roster — called once per render by FrontDeskScreen. */
function useRosterQuery(accessToken: string | undefined, sessionId: string | null) {
  return useQuery({
    queryKey: ["bookings", "roster", sessionId],
    enabled: accessToken !== undefined && sessionId !== null,
    queryFn: () => fetchRoster(accessToken as string, sessionId as string),
    retry: 1,
  });
}
