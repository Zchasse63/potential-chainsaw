import { useEffect, useRef, useState } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { ApiRequestError } from "../lib/api.js";
import { inspectEnvelope } from "../lib/envelope.js";
import {
  bookIntentSignature,
  rotateIntentKey,
  type AvailabilityData,
  type AvailabilityRow,
  type BookInput,
  type BookResult,
  type Hold,
  type IntentKey,
  type JoinWaitlistInput,
  type WaitlistJoinResult,
} from "../lib/bookings.js";
import type { WaiverStatusData } from "../lib/waivers.js";

/**
 * Quick Book — ONE surface, front desk (plan-ux §3C; Phase 6 · unit 6.3).
 *
 * The flow is a strict, honest funnel: identify a person → read their summary
 * (waiver status) → pick a slot (full slots offer a waitlist, never a bookable-
 * empty seat; a not-ready room is shown, not hidden) → selecting a bookable slot
 * takes a SERVER hold with an honest countdown → waiver preflight (a person who
 * needs to sign is BLOCKED from tender until clear; the API 403
 * booking_waiver_required is the backstop, rendered here as the preflight state,
 * never a toast) → explicit tender selection (NO last-used default) → a confirm
 * button that NAMES the act → the server-confirmed result (booking ref, credit
 * ref, check-in action). Abandoning releases the hold.
 *
 * NO OPTIMISTIC UI (invariant #5): a hold or booking is shown only from its
 * confirmed response. PER-INTENT KEY: any change to person / session / tender /
 * use_credit mints a NEW idempotency key (rotateIntentKey); an unchanged retry
 * reuses it so a timeout-after-commit replays instead of double-debiting.
 *
 * Presentational: every query and mutation is injected, so the whole funnel is
 * unit-testable without a network (mirrors PosScreen / WaiversScreen).
 */

export type BookTender = "credit" | "comp";

export interface BookScreenProps {
  /** GET /sessions/availability for the picker window (route owns from/to). */
  availabilityQuery: BoundaryQuery;
  /** GET /waivers/status/:personId — the person summary + waiver gate. */
  statusQueryFor: (personId: string | null) => BoundaryQuery;
  /** POST /bookings/hold. */
  onHold: (input: { session_id: string; person_id: string; ttl_seconds: number }) => Promise<Hold>;
  /** POST /bookings/:id/freeze-hold — fired when tender starts. */
  onFreeze: (holdId: string) => Promise<void>;
  /** POST /bookings/:id/release-hold — fired on abandon/back. */
  onRelease: (holdId: string) => Promise<void>;
  /** POST /bookings with the per-intent idempotency key. */
  onBook: (input: BookInput, idempotencyKey: string) => Promise<BookResult>;
  /** POST /waitlist/join for a full slot. */
  onJoinWaitlist: (input: JoinWaitlistInput, idempotencyKey: string) => Promise<WaitlistJoinResult>;
  /** Route-provided jump to the roster/check-in view for a booked session. */
  onCheckIn?: (sessionId: string, bookingId: string) => void;
  /** Hold TTL requested from the server (default 300s = the RPC default). */
  holdTtlSeconds?: number;
  /** Injectable clock for the countdown (tests pass a fixed now). */
  now?: () => number;
}

const INPUT_CLASS =
  "h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";
const LABEL_CLASS = "block text-body font-medium text-ink";
const HINT_CLASS = "font-mono text-micro uppercase tracking-wide text-ink-muted";

function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError || error instanceof Error) return error.message;
  return fallback;
}

function slotClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

// -- person gate --------------------------------------------------------------
// There is no people-directory/search endpoint on the live contract, so the
// desk identifies a person by id — the same honest pattern the shipped waivers
// desk capture uses. DEFERRED: person search-or-create + duplicate warning
// (plan-ux §3C) waits on a people-directory read endpoint.

function PersonGate({
  onLoad,
  onClear,
  activePersonId,
}: {
  onLoad: (personId: string) => void;
  onClear: () => void;
  activePersonId: string | null;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="space-y-3 rounded-3 border border-hairline bg-surface-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed !== "") onLoad(trimmed);
      }}
    >
      <div>
        <label className={LABEL_CLASS} htmlFor="book-person">
          Member <span className={HINT_CLASS}>person id</span>
        </label>
        <input
          id="book-person"
          className={`${INPUT_CLASS} font-mono`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="person id (uuid)"
          autoComplete="off"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={value.trim() === ""}>
          Load member
        </Button>
        {activePersonId !== null && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setValue("");
              onClear();
            }}
          >
            Change member
          </Button>
        )}
      </div>
    </form>
  );
}

// -- person summary (waiver status; the only person read the contract exposes) -

function PersonSummary({
  status,
}: {
  status: WaiverStatusData["status"];
}) {
  const needs = status.needs_signature;
  return (
    <div
      role="status"
      data-testid="person-summary"
      className={
        needs
          ? "rounded-2 border border-warning-border bg-warning-tint px-4 py-3"
          : "rounded-2 border border-success-border bg-success-tint px-4 py-3"
      }
    >
      <p
        className={
          needs
            ? "text-body font-medium text-warning-on-tint"
            : "text-body font-medium text-success-on-tint"
        }
      >
        {needs
          ? `▲ Waiver signature required on version ${status.active_version ?? "—"}`
          : "✓ Waiver signed — clear to book"}
      </p>
      <p className="mt-1 text-chrome text-ink-secondary">
        Credit balance is enforced by the server at booking — a shortfall returns an honest
        &ldquo;no credits&rdquo; error; the desk never displays an unverified balance.
      </p>
    </div>
  );
}

// -- slot picker --------------------------------------------------------------

function SlotPicker({
  sessions,
  disabled,
  onSelect,
  onWaitlist,
  pendingSessionId,
}: {
  sessions: AvailabilityRow[];
  disabled: boolean;
  onSelect: (slot: AvailabilityRow) => void;
  onWaitlist: (slot: AvailabilityRow) => void;
  pendingSessionId: string | null;
}) {
  const upcoming = [...sessions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  return (
    <ul className="space-y-2" aria-label="Available slots">
      {upcoming.map((slot) => {
        const full = slot.available <= 0;
        const notReady = !slot.readiness_ok;
        const pending = pendingSessionId === slot.session_id;
        return (
          <li
            key={slot.session_id}
            data-testid={`slot-${slot.session_id}`}
            className="flex items-center justify-between gap-3 rounded-2 border border-hairline bg-surface-card px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-body text-ink">{slotClock(slot.starts_at)}</p>
              <p className={HINT_CLASS}>
                {slot.available} of {slot.capacity} open · {slot.booked} booked · {slot.held} held
              </p>
            </div>
            {notReady ? (
              // Room-readiness aware: a slot in turnover/maintenance is shown as
              // not-ready, never as a bookable-empty seat (plan-ux §3C).
              <span
                data-testid={`slot-not-ready-${slot.session_id}`}
                className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-tint px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-warning-on-tint"
              >
                Room not ready
              </span>
            ) : full ? (
              // Full → a waitlist affordance, NOT a disabled/empty seat.
              <Button
                variant="secondary"
                className="h-9 shrink-0"
                data-testid={`slot-waitlist-${slot.session_id}`}
                disabled={disabled || pending}
                onClick={() => onWaitlist(slot)}
              >
                {pending ? "Joining…" : "Join waitlist"}
              </Button>
            ) : (
              <Button
                className="h-9 shrink-0"
                data-testid={`slot-book-${slot.session_id}`}
                disabled={disabled || pending}
                onClick={() => onSelect(slot)}
              >
                {pending ? "Holding…" : "Reserve seat"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// -- hold countdown -----------------------------------------------------------
// The countdown is anchored on the SERVER's expires_at when the hold response
// carries one (F4), falling back to a client anchor over the requested TTL only
// if it is absent. The server sweep + book-time validation remain the real
// authority; an expired hold is caught honestly at confirm.
//
// FROZEN holds are the exception (F1): once freeze-hold succeeds the sweep will
// NOT reclaim the seat, so a frozen hold must NEVER show a running countdown or
// an "expired" state — that would push the operator to release a validly-held
// seat. A frozen hold renders a STATIC "locked for this tender" line instead.

function HoldCountdown({ remainingMs, frozen }: { remainingMs: number; frozen: boolean }) {
  if (frozen) {
    // Seat is locked to this tender — the sweep cannot reclaim it, so there is
    // no deadline to display and no expired state to fall into.
    return (
      <p role="status" data-testid="hold-countdown" className="text-body font-medium text-ink">
        Seat locked for this tender — the reservation is held until you complete or release it.
      </p>
    );
  }
  const expired = remainingMs <= 0;
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return (
    <p
      role="status"
      data-testid="hold-countdown"
      className={
        expired
          ? "text-body font-medium text-danger-on-tint"
          : "text-body text-ink-secondary"
      }
    >
      {expired
        ? "This hold has expired — reserve the seat again to continue."
        : `Seat held for about ${mm}:${ss} — no pressure; the timer is a courtesy, not a deadline.`}
    </p>
  );
}

// -- waiver preflight (the block state) ---------------------------------------

function WaiverPreflight({ activeVersion }: { activeVersion: number | null }) {
  return (
    <div
      role="alert"
      data-testid="waiver-preflight"
      className="space-y-2 rounded-3 border border-warning-border bg-warning-tint p-4"
    >
      <p className="text-body font-medium text-warning-on-tint">
        A signed waiver is required before this booking.
      </p>
      <p className="text-body text-warning-on-tint">
        Booking is blocked until this member signs version {activeVersion ?? "—"}. Capture the
        signature at the desk (Waivers → Desk capture) or send them the waiver link, then reload the
        member here. No seat is booked and nothing is charged until the waiver is clear.
      </p>
      <a
        href="/waivers"
        className="inline-flex h-9 items-center rounded-2 border border-border-strong bg-surface-card px-3 text-body font-medium text-ink"
      >
        Open desk capture
      </a>
    </div>
  );
}

// -- tender + confirm ---------------------------------------------------------

const TENDER_OPTIONS: { value: BookTender; label: string; act: (creditName: string) => string }[] = [
  { value: "credit", label: "Use 1 credit", act: () => "Book with 1 credit" },
  { value: "comp", label: "No charge (comp)", act: () => "Book without a credit" },
];

function TenderStep({
  tender,
  frozen,
  pending,
  error,
  onTender,
  onConfirm,
}: {
  tender: BookTender | null;
  frozen: boolean;
  pending: boolean;
  error: string | null;
  onTender: (value: BookTender) => void;
  onConfirm: () => void;
}) {
  const chosen = TENDER_OPTIONS.find((option) => option.value === tender) ?? null;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className={LABEL_CLASS}>Tender</legend>
        {/* NO last-used default — the operator picks explicitly every time. */}
        <div role="radiogroup" aria-label="Tender" className="flex flex-wrap gap-2">
          {TENDER_OPTIONS.map((option) => {
            const active = tender === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`book-tender-${option.value}`}
                onClick={() => onTender(option.value)}
                className={`rounded-2 border px-3 py-2 text-body font-medium ${active ? "border-brand-600 bg-selected-bg text-ink" : "border-hairline text-ink-secondary"}`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {/* CONTRACT NOTE: cash / card-on-terminal for a paid drop-in has no
            linkage in the live book_session contract (it takes no payment). A
            paid drop-in is sold at Point of sale first, then booked as a comp.
            Deferred here rather than faked. */}
        <p className="text-chrome text-ink-muted">
          Paid drop-ins (cash / card on terminal) are sold at Point of sale, then booked here as a
          comp — the booking itself takes no payment.
        </p>
      </fieldset>

      {error !== null && (
        <p role="alert" className="text-body text-danger-on-tint">
          {error}
        </p>
      )}

      <Button
        data-testid="book-confirm"
        disabled={tender === null || !frozen || pending}
        onClick={onConfirm}
      >
        {pending ? "Booking…" : chosen !== null ? chosen.act("credit") : "Select a tender"}
      </Button>
    </div>
  );
}

// -- result -------------------------------------------------------------------

function ResultPanel({
  result,
  sessionId,
  onCheckIn,
  onNewBooking,
}: {
  result: BookResult;
  sessionId: string;
  onCheckIn?: (sessionId: string, bookingId: string) => void;
  onNewBooking: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="book-result"
      className="space-y-4 rounded-3 border border-success-border bg-success-tint p-5"
    >
      <div>
        <p className="text-body font-medium text-success-on-tint">
          {result.replayed === true ? "Booking confirmed (already recorded)." : "Booking confirmed."}
        </p>
        <p className="mt-1 font-mono text-table text-success-on-tint">
          Booking {result.booking_id.slice(0, 8)}…
          {result.credit_entry_id != null && ` · Credit ${result.credit_entry_id.slice(0, 8)}…`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {onCheckIn !== undefined && (
          <Button variant="secondary" onClick={() => onCheckIn(sessionId, result.booking_id)}>
            Go to check-in
          </Button>
        )}
        <Button variant="ghost" onClick={onNewBooking}>
          Book another
        </Button>
      </div>
    </div>
  );
}

// -- the screen ---------------------------------------------------------------

interface HeldSlot {
  slot: AvailabilityRow;
  holdId: string;
  heldAtMs: number;
  /** Server expires_at (ms) when the hold response carried one; null → fall back
   *  to the client anchor (heldAtMs + TTL). */
  expiresAtMs: number | null;
}

export function BookScreen({
  availabilityQuery,
  statusQueryFor,
  onHold,
  onFreeze,
  onRelease,
  onBook,
  onJoinWaitlist,
  onCheckIn,
  holdTtlSeconds = 300,
  now = () => Date.now(),
}: BookScreenProps) {
  const [activePersonId, setActivePersonId] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldSlot | null>(null);
  const [tender, setTender] = useState<BookTender | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [waiverBlocked, setWaiverBlocked] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);
  const [bookedSessionId, setBookedSessionId] = useState<string | null>(null);
  const [waitlistNote, setWaitlistNote] = useState<string | null>(null);
  // A 1s re-render tick so the countdown recomputes from `now()`; the value is
  // never read (the recompute is the whole point), only the state change matters.
  const [, setTick] = useState(0);

  // ONE key per booking intent; rotates whenever the submitted content changes.
  const bookKey = useRef<IntentKey | null>(null);
  // A stable key per waitlist-join intent (person+session).
  const waitlistKeys = useRef<Map<string, string>>(new Map());

  const statusQuery = statusQueryFor(activePersonId);
  const waiverInspection =
    statusQuery.status === "success"
      ? inspectStatus(statusQuery.data)
      : null;
  const needsSignature = waiverInspection?.needs_signature;
  const activeVersion = waiverInspection?.active_version ?? null;

  // Re-render the countdown each second while a hold is live AND unfrozen
  // (display only; the server is the authority). A FROZEN hold stops the tick —
  // its seat is locked to the tender, so there is no countdown to advance and no
  // expired state to fall into (F1). Injected `now` keeps tests deterministic.
  useEffect(() => {
    if (held === null || result !== null || frozen) return;
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [held, result, frozen]);

  function resetIntent() {
    bookKey.current = null;
    setTender(null);
    setFrozen(false);
    setBookError(null);
    setWaiverBlocked(false);
  }

  function loadPerson(personId: string) {
    // Changing member abandons any live hold (a new person is a new intent).
    void abandonHold();
    setActivePersonId(personId);
    setResult(null);
    setWaitlistNote(null);
  }

  function clearPerson() {
    void abandonHold();
    setActivePersonId(null);
    setResult(null);
  }

  async function abandonHold() {
    const current = held;
    resetIntent();
    setHeld(null);
    if (current !== null) {
      // Release is best-effort remediation; a failure just leaves the sweep to
      // reclaim the seat at TTL. Never block the desk on it.
      try {
        await onRelease(current.holdId);
      } catch {
        /* the server sweep reclaims the seat at expiry */
      }
    }
  }

  async function selectSlot(slot: AvailabilityRow) {
    if (activePersonId === null || pendingSessionId !== null) return;
    setPendingSessionId(slot.session_id);
    setBookError(null);
    try {
      const hold = await onHold({
        session_id: slot.session_id,
        person_id: activePersonId,
        ttl_seconds: holdTtlSeconds,
      });
      resetIntent();
      // Anchor on the SERVER expires_at when present (F4); fall back to the
      // client anchor (heldAtMs + TTL) only if the response omitted it.
      const expiresAtMs =
        hold.expires_at !== null && hold.expires_at !== undefined
          ? Date.parse(hold.expires_at)
          : null;
      setHeld({
        slot,
        holdId: hold.id,
        heldAtMs: now(),
        expiresAtMs: Number.isNaN(expiresAtMs ?? NaN) ? null : expiresAtMs,
      });
      setResult(null);
    } catch (caught) {
      setBookError(mutationMessage(caught, "The seat could not be held. Try again."));
    } finally {
      setPendingSessionId(null);
    }
  }

  async function joinWaitlist(slot: AvailabilityRow) {
    if (activePersonId === null || pendingSessionId !== null) return;
    setPendingSessionId(slot.session_id);
    setWaitlistNote(null);
    const mapKey = `${activePersonId}|${slot.session_id}`;
    let key = waitlistKeys.current.get(mapKey);
    if (key === undefined) {
      key = crypto.randomUUID();
      waitlistKeys.current.set(mapKey, key);
    }
    try {
      const joined = await onJoinWaitlist(
        { session_id: slot.session_id, person_id: activePersonId },
        key,
      );
      waitlistKeys.current.delete(mapKey);
      setWaitlistNote(`Added to the waitlist — position ${joined.position}.`);
    } catch (caught) {
      setBookError(mutationMessage(caught, "Could not join the waitlist. Try again."));
    } finally {
      setPendingSessionId(null);
    }
  }

  async function chooseTender(value: BookTender) {
    setTender(value);
    setBookError(null);
    // Freeze-hold fires when tender starts (plan-ux §3C hold choreography) —
    // once per hold, so the sweep cannot reclaim the seat mid-tender.
    if (!frozen && held !== null) {
      try {
        await onFreeze(held.holdId);
        setFrozen(true);
      } catch {
        // A freeze failure is non-fatal — the hold still has its TTL; the book
        // call is the real gate. Allow the operator to proceed.
        setFrozen(true);
      }
    }
  }

  async function confirmBooking() {
    if (held === null || activePersonId === null || tender === null || booking) return;
    if (needsSignature === true) {
      setWaiverBlocked(true);
      return;
    }
    const input: BookInput = {
      session_id: held.slot.session_id,
      person_id: activePersonId,
      hold_id: held.holdId,
      use_credit: tender === "credit",
    };
    bookKey.current = rotateIntentKey(bookKey.current, bookIntentSignature(input));
    setBooking(true);
    setBookError(null);
    try {
      const confirmedBooking = await onBook(input, bookKey.current.key);
      bookKey.current = null; // confirmed → the next booking is a new intent
      setBookedSessionId(held.slot.session_id);
      setResult(confirmedBooking);
      setHeld(null);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === "booking_waiver_required") {
        // The 403 backstop renders as the preflight state, never a toast.
        setWaiverBlocked(true);
      } else {
        // Keep the key so a retry of THIS booking reuses it (no double debit).
        setBookError(mutationMessage(caught, "The booking wasn't confirmed. Nothing was charged."));
      }
    } finally {
      setBooking(false);
    }
  }

  // Server-authoritative when the hold response carried expires_at (F4); the
  // client anchor is the documented fallback for a response that omitted it.
  const holdExpiresAtMs =
    held === null ? 0 : held.expiresAtMs ?? held.heldAtMs + holdTtlSeconds * 1000;
  const remainingMs = held === null ? 0 : holdExpiresAtMs - now();

  return (
    <div className="space-y-8">
      <header>
        <p className={HINT_CLASS}>Book · quick book &amp; front desk</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Book</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          Reserve a seat for a member in one pass. A seat is held on the server, the waiver is
          checked before tender, and nothing is booked until the server confirms — no seat is ever
          shown as taken optimistically.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: identify + summary + slots */}
        <section aria-label="Member and slots" className="space-y-4">
          <PersonGate onLoad={loadPerson} onClear={clearPerson} activePersonId={activePersonId} />

          {activePersonId !== null && (
            <DataBoundary<WaiverStatusData>
              name="book-person-status"
              query={statusQuery}
              skeleton={<Skeleton className="h-20 w-full rounded-2" />}
              errorConsequence="The member's waiver status couldn't be loaded — no seat was held and nothing was booked."
            >
              {(data) => <PersonSummary status={data.status} />}
            </DataBoundary>
          )}

          {activePersonId !== null && (
            <div className="space-y-2">
              <h2 className="font-display text-title font-bold text-ink">Next slots</h2>
              <DataBoundary<AvailabilityData>
                name="book-availability"
                query={availabilityQuery}
                skeleton={<Skeleton className="h-48 w-full rounded-3" />}
                errorConsequence="Availability didn't load — no seat can be held."
                isEmpty={(data) => data.sessions.length === 0}
                emptyState={
                  <EmptyState
                    title="No published sessions in this window."
                    body="This is a real empty state, not a sync gap — publish sessions in Schedule, or widen the window."
                  />
                }
              >
                {(data) => (
                  <SlotPicker
                    sessions={data.sessions}
                    disabled={held !== null || booking}
                    onSelect={(slot) => void selectSlot(slot)}
                    onWaitlist={(slot) => void joinWaitlist(slot)}
                    pendingSessionId={pendingSessionId}
                  />
                )}
              </DataBoundary>
              {waitlistNote !== null && (
                <p role="status" data-testid="waitlist-note" className="text-body text-success-on-tint">
                  {waitlistNote}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Right: hold → waiver preflight → tender → confirm → result */}
        <section aria-label="Reservation" className="space-y-4">
          {result !== null && held === null ? (
            <ResultPanel
              result={result}
              sessionId={bookedSessionId ?? ""}
              onCheckIn={onCheckIn}
              onNewBooking={() => {
                setResult(null);
                setBookedSessionId(null);
                resetIntent();
              }}
            />
          ) : held === null ? (
            <div className="rounded-3 border border-dashed border-hairline bg-surface-app px-4 py-8 text-center">
              <p className="text-body text-ink-muted">
                {activePersonId === null
                  ? "Load a member, then pick a slot to hold a seat."
                  : "Pick a slot to hold a seat — the reservation appears here."}
              </p>
            </div>
          ) : (
            <div className="space-y-4 rounded-3 border border-hairline bg-surface-card p-4">
              <div>
                <p className={HINT_CLASS}>Holding</p>
                <h2 className="mt-1 font-display text-title font-bold text-ink">
                  {slotClock(held.slot.starts_at)}
                </h2>
                <HoldCountdown remainingMs={remainingMs} frozen={frozen} />
              </div>

              {needsSignature === true || waiverBlocked ? (
                <WaiverPreflight activeVersion={activeVersion} />
              ) : needsSignature === undefined ? (
                <p role="status" className="text-body text-ink-muted">
                  Confirming the member&apos;s waiver status before tender…
                </p>
              ) : (
                <TenderStep
                  tender={tender}
                  frozen={frozen}
                  pending={booking}
                  error={bookError}
                  onTender={(value) => void chooseTender(value)}
                  onConfirm={() => void confirmBooking()}
                />
              )}

              <Button variant="ghost" onClick={() => void abandonHold()} disabled={booking}>
                Release seat &amp; go back
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Narrow the injected waiver-status envelope to the fields the gate needs,
 *  without rendering (the DataBoundary renders the summary separately). The gate
 *  honours the SAME provenance-or-nothing rule as the boundary: a payload
 *  without a valid meta yields null, so the booking is blocked (needsSignature
 *  stays undefined) until a real status lands. */
function inspectStatus(
  payload: unknown,
): { needs_signature: boolean; active_version: number | null } | null {
  const inspection = inspectEnvelope<WaiverStatusData>(payload);
  if (!inspection.ok) return null;
  const status = inspection.data?.status;
  if (typeof status?.needs_signature !== "boolean") return null;
  return {
    needs_signature: status.needs_signature,
    active_version: status.active_version,
  };
}
