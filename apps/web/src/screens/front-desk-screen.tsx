import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { ApiRequestError } from "../lib/api.js";
import type { BookResult, CheckInResult, RosterBooking, RosterData, RosterWaitlistEntry } from "../lib/bookings.js";
import {
  enqueueCheckIn,
  readQueue,
  replayQueue,
  type QueuedCheckIn,
  type QueueStorage,
} from "../lib/checkin-queue.js";

/**
 * Front desk — session roster, one-tap check-in, and staff waitlist actions
 * (plan-ux §3C; Phase 6 · unit 6.3).
 *
 * CHECK-IN is the one booking action that survives degraded conditions because
 * it moves no money:
 *  - One-tap check-in has a 10s UNDO window. We COMMIT AFTER the window rather
 *    than posting-then-undoing: a tap starts a countdown, and only when it
 *    elapses does the check-in actually go to the server (or the queue). This is
 *    acceptable BECAUSE check-in is not money — an accidental tap is cancelled
 *    with no server write at all, and a real check-in lands a few seconds later.
 *  - DEGRADED MODE: if the commit fails or the device is offline, the intent is
 *    queued in localStorage ("Queued on this device (N)"), replays idempotently
 *    on reconnect (each carries a stable per-booking key; a re-check-in no-ops),
 *    and the queue SURVIVES reload. Failures are surfaced, never dropped.
 *
 * Roster and waitlist reads flow through DataBoundary. Accept/decline are
 * server-confirmed (accept books through book_session; the roster re-reads).
 * Presentational: queries, mutations, storage, and clock are all injected.
 */

export interface FrontDeskScreenProps {
  /** GET /sessions/:id/roster for the entered session. */
  rosterQueryFor: (sessionId: string | null) => BoundaryQuery;
  /** POST /bookings/:id/check-in — stable per-booking key for safe replay. */
  onCheckIn: (sessionId: string, bookingId: string, idempotencyKey: string) => Promise<CheckInResult>;
  /** POST /waitlist/:id/accept — books the offer. */
  onAccept: (entryId: string, idempotencyKey: string) => Promise<BookResult>;
  /** POST /waitlist/:id/decline — releases the offer to the next waiter. */
  onDecline: (entryId: string, idempotencyKey: string) => Promise<void>;
  /** Route may pre-load a session (e.g. jumped from a booking result). */
  initialSessionId?: string | null;
  undoWindowMs?: number;
  /** Injected for tests; defaults to window.localStorage inside the queue lib. */
  storage?: QueueStorage | null;
  isOnline?: () => boolean;
}

const INPUT_CLASS =
  "h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 font-mono text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";
const HINT_CLASS = "font-mono text-micro uppercase tracking-wide text-ink-muted";

function personLabel(name: string | null, personId: string | null): string {
  if (name !== null && name.trim() !== "") return name;
  return personId !== null ? `Member ${personId.slice(0, 8)}…` : "Member";
}

function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError || error instanceof Error) return error.message;
  return fallback;
}

// -- check-in row -------------------------------------------------------------

type RowState =
  | { kind: "idle" }
  | { kind: "undo"; secondsLeft: number }
  | { kind: "queued" }
  | { kind: "error"; message: string };

function CheckInRow({
  booking,
  state,
  onCheckIn,
  onUndo,
}: {
  booking: RosterBooking;
  state: RowState;
  onCheckIn: () => void;
  onUndo: () => void;
}) {
  const checkedIn = booking.checked_in_at !== null;
  const label = personLabel(booking.people?.first_name ?? null, booking.person_id);
  return (
    <li
      data-testid={`roster-booking-${booking.id}`}
      className="flex items-center justify-between gap-3 rounded-2 border border-hairline bg-surface-card px-3 py-3"
    >
      <div className="min-w-0">
        <p className="text-body text-ink">{label}</p>
        <p className={HINT_CLASS}>{booking.status}</p>
      </div>
      {checkedIn ? (
        <span
          data-testid={`checked-in-${booking.id}`}
          className="inline-flex items-center gap-1 rounded-full border border-success-border bg-success-tint px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-success-on-tint"
        >
          <span aria-hidden="true">✓</span> Checked in
        </span>
      ) : state.kind === "undo" ? (
        <div className="flex items-center gap-2">
          <span data-testid={`undo-window-${booking.id}`} className="text-chrome text-ink-secondary">
            Checking in… {state.secondsLeft}s
          </span>
          <Button variant="ghost" className="h-9" onClick={onUndo}>
            Undo
          </Button>
        </div>
      ) : state.kind === "queued" ? (
        <span
          data-testid={`queued-${booking.id}`}
          className="inline-flex items-center gap-1 rounded-full border border-info-border bg-info-tint px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-info-on-tint"
        >
          Queued on this device
        </span>
      ) : (
        <div className="flex items-center gap-2">
          {state.kind === "error" && (
            <span className="text-chrome text-danger-on-tint">{state.message}</span>
          )}
          <Button
            className="h-9 shrink-0"
            data-testid={`check-in-${booking.id}`}
            onClick={onCheckIn}
          >
            Check in
          </Button>
        </div>
      )}
    </li>
  );
}

// -- waitlist row -------------------------------------------------------------

function WaitlistRow({
  entry,
  pending,
  onAccept,
  onDecline,
}: {
  entry: RosterWaitlistEntry;
  pending: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const offered = entry.status === "offered";
  const label = personLabel(entry.people?.first_name ?? null, entry.person_id);
  return (
    <li
      data-testid={`waitlist-entry-${entry.id}`}
      className="flex items-center justify-between gap-3 rounded-2 border border-hairline bg-surface-card px-3 py-3"
    >
      <div className="min-w-0">
        <p className="text-body text-ink">
          <span className="font-mono text-ink-secondary">#{entry.position}</span> {label}
        </p>
        <p className={HINT_CLASS}>
          {offered
            ? `Offered${entry.offer_expires_at !== null ? " · expiring" : ""}`
            : entry.status}
        </p>
      </div>
      {offered ? (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="h-9"
            data-testid={`waitlist-accept-${entry.id}`}
            disabled={pending}
            onClick={onAccept}
          >
            Accept
          </Button>
          <Button
            variant="ghost"
            className="h-9"
            data-testid={`waitlist-decline-${entry.id}`}
            disabled={pending}
            onClick={onDecline}
          >
            Decline
          </Button>
        </div>
      ) : (
        <span className={`${HINT_CLASS} shrink-0`}>Waiting</span>
      )}
    </li>
  );
}

// -- the screen ---------------------------------------------------------------

export function FrontDeskScreen({
  rosterQueryFor,
  onCheckIn,
  onAccept,
  onDecline,
  initialSessionId = null,
  undoWindowMs = 10_000,
  storage = undefined,
  isOnline = () => navigator.onLine,
}: FrontDeskScreenProps) {
  const [sessionInput, setSessionInput] = useState(initialSessionId ?? "");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [queue, setQueue] = useState<QueuedCheckIn[]>(() => readQueue(storage ?? undefined));
  const [syncError, setSyncError] = useState<string | null>(null);
  const [waitlistPending, setWaitlistPending] = useState<string | null>(null);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);

  const rosterQuery = rosterQueryFor(activeSessionId);
  // Stable per-booking check-in keys (reused across retries and queue replay).
  const checkInKeys = useRef<Map<string, string>>(new Map());
  const undoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const intervalTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const acceptKeys = useRef<Map<string, string>>(new Map());
  const declineKeys = useRef<Map<string, string>>(new Map());
  // Guards against overlapping replays (idempotent anyway, but no wasted calls).
  const replaying = useRef(false);

  function keyFor(map: Map<string, string>, id: string): string {
    let key = map.get(id);
    if (key === undefined) {
      key = crypto.randomUUID();
      map.set(id, key);
    }
    return key;
  }

  function setRow(bookingId: string, state: RowState) {
    setRowStates((current) => ({ ...current, [bookingId]: state }));
  }

  /** Perform the actual check-in — online → POST, offline/failed → enqueue. The
   *  same stable key is used for the POST and the queued entry so a later replay
   *  is a safe no-op if the POST actually landed. */
  const commitCheckIn = useCallback(
    async (booking: RosterBooking) => {
      if (activeSessionId === null) return;
      const key = keyFor(checkInKeys.current, booking.id);
      const queueEntry: QueuedCheckIn = {
        bookingId: booking.id,
        sessionId: activeSessionId,
        personLabel: booking.people?.first_name ?? null,
        idempotencyKey: key,
        queuedAt: new Date().toISOString(),
      };
      if (!isOnline()) {
        setQueue(enqueueCheckIn(queueEntry, storage ?? undefined));
        setRow(booking.id, { kind: "queued" });
        return;
      }
      try {
        await onCheckIn(activeSessionId, booking.id, key);
        setRow(booking.id, { kind: "idle" });
        checkInKeys.current.delete(booking.id);
        void rosterQuery.refetch();
      } catch (caught) {
        // A failed commit is queued, never dropped (degraded mode).
        setQueue(enqueueCheckIn(queueEntry, storage ?? undefined));
        setRow(booking.id, { kind: "queued" });
        setSyncError(mutationMessage(caught, "Check-in couldn't reach the server — queued on this device."));
      }
    },
    [activeSessionId, isOnline, onCheckIn, rosterQuery, storage],
  );

  /** Tap check-in → start the 10s undo window; commit only when it elapses. */
  function startCheckIn(booking: RosterBooking) {
    if (undoTimers.current.has(booking.id)) return;
    setRow(booking.id, { kind: "undo", secondsLeft: Math.ceil(undoWindowMs / 1000) });
    const started = Date.now();
    const interval = setInterval(() => {
      const left = Math.ceil((undoWindowMs - (Date.now() - started)) / 1000);
      setRow(booking.id, { kind: "undo", secondsLeft: Math.max(0, left) });
    }, 1000);
    const timer = setTimeout(() => {
      clearInterval(interval);
      undoTimers.current.delete(booking.id);
      void commitCheckIn(booking);
    }, undoWindowMs);
    // Store both handles so undo clears the countdown and the commit.
    undoTimers.current.set(booking.id, timer);
    intervalTimers.current.set(booking.id, interval);
  }

  function undoCheckIn(bookingId: string) {
    const timer = undoTimers.current.get(bookingId);
    if (timer !== undefined) {
      clearTimeout(timer);
      undoTimers.current.delete(bookingId);
    }
    const interval = intervalTimers.current.get(bookingId);
    if (interval !== undefined) {
      clearInterval(interval);
      intervalTimers.current.delete(bookingId);
    }
    setRow(bookingId, { kind: "idle" });
  }

  const runReplay = useCallback(async () => {
    if (replaying.current || !isOnline()) return;
    if (readQueue(storage ?? undefined).length === 0) return;
    replaying.current = true;
    setSyncError(null);
    try {
      const outcome = await replayQueue(
        (entry) => onCheckIn(entry.sessionId, entry.bookingId, entry.idempotencyKey),
        storage ?? undefined,
      );
      setQueue(outcome.remaining);
      for (const bookingId of outcome.synced) {
        setRow(bookingId, { kind: "idle" });
        checkInKeys.current.delete(bookingId);
      }
      if (outcome.failed.length > 0) {
        setSyncError(
          `${outcome.failed.length} check-in${outcome.failed.length === 1 ? "" : "s"} still queued — will retry on reconnect.`,
        );
      } else {
        void rosterQuery.refetch();
      }
    } finally {
      replaying.current = false;
    }
  }, [isOnline, onCheckIn, rosterQuery, storage]);

  // Replay on reconnect and on mount (a queue can survive a reload). The latest
  // runReplay is held in a ref so the listener registers ONCE — not on every
  // render (rosterQueryFor returns a fresh query object each render).
  const runReplayRef = useRef(runReplay);
  runReplayRef.current = runReplay;
  useEffect(() => {
    void runReplayRef.current();
    const onOnline = () => void runReplayRef.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  // Clear any pending undo timers on unmount.
  useEffect(() => {
    const timers = undoTimers.current;
    const intervals = intervalTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      for (const interval of intervals.values()) clearInterval(interval);
    };
  }, []);

  async function acceptOffer(entry: RosterWaitlistEntry) {
    setWaitlistPending(entry.id);
    setWaitlistError(null);
    try {
      await onAccept(entry.id, keyFor(acceptKeys.current, entry.id));
      acceptKeys.current.delete(entry.id);
      void rosterQuery.refetch();
    } catch (caught) {
      setWaitlistError(mutationMessage(caught, "The offer couldn't be accepted. Nothing was booked."));
    } finally {
      setWaitlistPending(null);
    }
  }

  async function declineOffer(entry: RosterWaitlistEntry) {
    setWaitlistPending(entry.id);
    setWaitlistError(null);
    try {
      await onDecline(entry.id, keyFor(declineKeys.current, entry.id));
      declineKeys.current.delete(entry.id);
      void rosterQuery.refetch();
    } catch (caught) {
      setWaitlistError(mutationMessage(caught, "The offer couldn't be declined."));
    } finally {
      setWaitlistPending(null);
    }
  }

  function loadSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = sessionInput.trim();
    if (trimmed === "") return;
    setActiveSessionId(trimmed);
    setRowStates({});
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-title font-bold text-ink">Front desk · roster &amp; check-in</h2>
        <p className="mt-1 text-body text-ink-secondary">
          Load a session to check members in and manage its waitlist. Check-ins work offline — they
          queue on this device and sync when the connection returns.
        </p>
      </div>

      <form onSubmit={loadSession} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="roster-session" className="block text-body font-medium text-ink">
            Session id
          </label>
          <input
            id="roster-session"
            className={INPUT_CLASS}
            value={sessionInput}
            onChange={(event) => setSessionInput(event.target.value)}
            placeholder="session id (uuid)"
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={sessionInput.trim() === ""}>
          Load roster
        </Button>
      </form>

      {queue.length > 0 && (
        <div
          role="status"
          data-testid="queue-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2 border border-info-border bg-info-tint px-4 py-2"
        >
          <p className="text-body text-info-on-tint">
            Queued on this device ({queue.length}) — check-ins waiting to sync.
          </p>
          <Button variant="secondary" className="h-9" onClick={() => void runReplay()}>
            Retry sync
          </Button>
        </div>
      )}
      {syncError !== null && (
        <p role="alert" className="text-body text-danger-on-tint">
          {syncError}
        </p>
      )}

      {activeSessionId !== null && (
        <DataBoundary<RosterData>
          name="front-desk-roster"
          query={rosterQuery}
          skeleton={<Skeleton className="h-64 w-full rounded-3" />}
          errorConsequence="The roster didn't load — no one can be checked in from here."
        >
          {(data) => (
            <div className="grid gap-6 lg:grid-cols-2">
              <section aria-label="Booked" className="space-y-3">
                <h3 className={HINT_CLASS}>Booked ({data.roster.bookings.length})</h3>
                {data.roster.bookings.length === 0 ? (
                  <EmptyState
                    title="No active bookings."
                    body="This is a real empty state — no one is booked into this session yet."
                  />
                ) : (
                  <ul className="space-y-2">
                    {data.roster.bookings.map((booking) => {
                      // A queued check-in overrides the row's transient state.
                      const queued = queue.some((item) => item.bookingId === booking.id);
                      const state: RowState = queued
                        ? { kind: "queued" }
                        : rowStates[booking.id] ?? { kind: "idle" };
                      return (
                        <CheckInRow
                          key={booking.id}
                          booking={booking}
                          state={state}
                          onCheckIn={() => startCheckIn(booking)}
                          onUndo={() => undoCheckIn(booking.id)}
                        />
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-label="Waitlist" className="space-y-3">
                <h3 className={HINT_CLASS}>Waitlist ({data.roster.waitlist.length})</h3>
                {waitlistError !== null && (
                  <p role="alert" className="text-body text-danger-on-tint">
                    {waitlistError}
                  </p>
                )}
                {data.roster.waitlist.length === 0 ? (
                  <EmptyState
                    title="No one waiting."
                    body="This is a real empty state — the waitlist for this session is empty."
                  />
                ) : (
                  <ul className="space-y-2">
                    {data.roster.waitlist.map((entry) => (
                      <WaitlistRow
                        key={entry.id}
                        entry={entry}
                        pending={waitlistPending === entry.id}
                        onAccept={() => void acceptOffer(entry)}
                        onDecline={() => void declineOffer(entry)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </DataBoundary>
      )}
    </div>
  );
}
