import { useEffect, useState } from "react";
import { WaiverStep, type SignWaiverOutcome, type WaiverLoad } from "./waiver-step.jsx";

/**
 * The Book → Confirmed core (plan-member-app §3H) for a signed-in member. It
 * PRE-GATES on the two facts the account gives us — waiver signature and credit
 * balance — and on the session's live availability, so the member only ever
 * taps "Book" when it can actually succeed. A book that still loses the
 * capacity race (the API answers 422 for full/closed/again) falls through to
 * the honest waitlist, never a dead end.
 *
 * Presentational only: the route injects the member-core-wired callbacks and a
 * key factory. The panel holds NO tenant/secret material and never sends a
 * person id — scope is the session cookie the API set at verify (invariant:
 * person comes from the session, never the request).
 */

export interface BookingSession {
  session_id: string;
  offering_name: string;
  starts_at: string;
  ends_at: string;
  /** Live seats left from the public schedule (0 ⇒ full ⇒ waitlist). */
  available: number;
  /** Fixed v1 cost — always 1 credit (migration 0040). */
  credit_cost: number;
}

/** Live account facts the gate needs (from GET /member/account). */
export type AccountLoad =
  | { ok: true; creditBalance: number; waiverNeedsSignature: boolean; bookedSessionIds: string[] }
  | { ok: false; unauthenticated: boolean };

/**
 * Why a book failed — the route derives this from the API's structured error
 * CODE (not a bare status), so each failure lands the member somewhere useful:
 *   race        the seat filled between load and book (409 session_at_capacity)
 *               → offer the honest waitlist
 *   no_credits  balance dropped below cost by book time (422 insufficient_credits)
 *   waiver      an unsigned waiver blocks booking (403 booking_waiver_required)
 *   unavailable the session is no longer open — started/unpublished/gone
 *               (422 booking_invalid, 404 booking_target_not_found) → terminal
 *   retry       transient/unknown — a same-key retry is safe (idempotent)
 */
export type BookFailureReason = "race" | "no_credits" | "waiver" | "unavailable" | "retry";
export type BookOutcome = { ok: true } | { ok: false; reason: BookFailureReason };
export type WaitlistOutcome = { ok: true; position: number } | { ok: false };

export interface BookingPanelProps {
  session: BookingSession;
  /** Pretty a session-time range for display (injected — tz lives in the route). */
  formatWhen: (startsAt: string, endsAt: string) => string;
  loadAccount: () => Promise<AccountLoad>;
  /** Book with one credit. The key is per-intent, stable across retries. */
  onBook: (idempotencyKey: string) => Promise<BookOutcome>;
  onJoinWaitlist: (idempotencyKey: string) => Promise<WaitlistOutcome>;
  /** Called when the account load says we're not signed in (route navigates). */
  onRequireSignIn: () => void;
  /** Per-intent idempotency key (route injects crypto.randomUUID). */
  makeIdempotencyKey: () => string;
  /** Waiver stage (unit 8.3i): load the active waiver text + sign in-flow. */
  loadWaiver: () => Promise<WaiverLoad>;
  onSignWaiver: (typedName: string) => Promise<SignWaiverOutcome>;
}

type Phase =
  | { kind: "loading" }
  | { kind: "account_error" }
  | { kind: "ready" }
  | { kind: "already_booked" }
  | { kind: "waiver" }
  | { kind: "out_of_credits" }
  | { kind: "booking" }
  | { kind: "confirmed" }
  | { kind: "unavailable" }
  | { kind: "offer_waitlist"; reason: "full" | "race" }
  | { kind: "joining"; reason: "full" | "race" }
  | { kind: "waitlisted"; position: number }
  | { kind: "book_error" }
  | { kind: "waitlist_error"; reason: "full" | "race" };

export function BookingPanel(props: BookingPanelProps) {
  const { session, formatWhen } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [credits, setCredits] = useState(0);
  // Bumped by the account-error retry so the load effect re-runs (its dep list
  // is otherwise stable for a given session).
  const [reloadKey, setReloadKey] = useState(0);
  // Per-intent keys, minted once at first commit and reused on retry so a
  // network retry can never double-debit (book) or double-enqueue (waitlist).
  const [bookKey, setBookKey] = useState<string | null>(null);
  const [waitKey, setWaitKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const acct = await props.loadAccount();
      if (!live) return;
      if (!acct.ok) {
        if (acct.unauthenticated) {
          props.onRequireSignIn();
          return; // stay on "loading" copy while the route navigates away
        }
        setPhase({ kind: "account_error" });
        return;
      }
      setCredits(acct.creditBalance);
      if (acct.bookedSessionIds.includes(session.session_id)) {
        setPhase({ kind: "already_booked" });
      } else if (acct.waiverNeedsSignature) {
        setPhase({ kind: "waiver" });
      } else if (session.available <= 0) {
        setPhase({ kind: "offer_waitlist", reason: "full" });
      } else if (acct.creditBalance < session.credit_cost) {
        setPhase({ kind: "out_of_credits" });
      } else {
        setPhase({ kind: "ready" });
      }
    })();
    return () => {
      live = false;
    };
    // Re-run when the target session changes or a retry bumps reloadKey.
  }, [session.session_id, reloadKey]);

  function retryAccountLoad() {
    setPhase({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }

  async function book() {
    const key = bookKey ?? props.makeIdempotencyKey();
    if (bookKey === null) setBookKey(key);
    setPhase({ kind: "booking" });
    const res = await props.onBook(key);
    if (res.ok) {
      setPhase({ kind: "confirmed" });
      return;
    }
    switch (res.reason) {
      case "race":
        // The seat filled between load and book — offer the honest waitlist.
        setPhase({ kind: "offer_waitlist", reason: "race" });
        break;
      case "no_credits":
        setPhase({ kind: "out_of_credits" });
        break;
      case "waiver":
        setPhase({ kind: "waiver" });
        break;
      case "unavailable":
        setPhase({ kind: "unavailable" });
        break;
      case "retry":
        setPhase({ kind: "book_error" });
        break;
    }
  }

  async function joinWaitlist(reason: "full" | "race") {
    const key = waitKey ?? props.makeIdempotencyKey();
    if (waitKey === null) setWaitKey(key);
    setPhase({ kind: "joining", reason });
    const res = await props.onJoinWaitlist(key);
    if (res.ok) {
      setPhase({ kind: "waitlisted", position: res.position });
    } else {
      setPhase({ kind: "waitlist_error", reason });
    }
  }

  const when = formatWhen(session.starts_at, session.ends_at);

  return (
    <section aria-label="Book this session" className="mx-auto flex max-w-sm flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-title font-bold text-ink">{session.offering_name}</h1>
        <p className="text-body text-ink-muted">{when}</p>
      </header>

      {phase.kind === "loading" && (
        <p className="text-body text-ink-muted" role="status">
          Checking your account…
        </p>
      )}

      {phase.kind === "account_error" && (
        <Panel tone="danger" role="alert">
          <p className="text-body text-danger-on-tint">
            We couldn't load your account, so nothing was booked. Check your connection and try again.
          </p>
          <PrimaryButton onClick={retryAccountLoad}>Try again</PrimaryButton>
        </Panel>
      )}

      {phase.kind === "ready" && (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink">
            {session.available} {session.available === 1 ? "spot" : "spots"} left. Booking uses{" "}
            <strong>1 credit</strong> — you have {credits}.
          </p>
          <PrimaryButton onClick={book}>Book with 1 credit</PrimaryButton>
        </div>
      )}

      {phase.kind === "already_booked" && (
        <Panel tone="ok" role="status">
          <p className="text-body text-ink">You're already booked into this session. See you there.</p>
        </Panel>
      )}

      {phase.kind === "waiver" && (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink-muted">One thing first — please sign the studio's waiver.</p>
          <WaiverStep
            loadWaiver={props.loadWaiver}
            onSign={props.onSignWaiver}
            onSigned={retryAccountLoad}
          />
        </div>
      )}

      {phase.kind === "out_of_credits" && (
        <Panel tone="warn" role="status">
          <p className="text-body text-ink">
            You're out of credits. Buying a pack from your phone is coming soon — for now, grab credits at
            the studio and this session will be here.
          </p>
        </Panel>
      )}

      {phase.kind === "booking" && (
        <p className="text-body text-ink-muted" role="status">
          Booking your seat…
        </p>
      )}

      {phase.kind === "confirmed" && (
        <Panel tone="ok" role="status">
          <p className="text-body font-medium text-ink">You're booked. One credit used — {credits - session.credit_cost} left.</p>
          <p className="text-chrome text-ink-muted">
            Need to change plans? You can cancel up to 12 hours before for a refund.
          </p>
          <a href="/account" className="text-chrome font-medium text-link">
            View your bookings →
          </a>
        </Panel>
      )}

      {(phase.kind === "offer_waitlist" || phase.kind === "waitlist_error") && (
        <Panel tone="warn" role={phase.kind === "waitlist_error" ? "alert" : "status"}>
          <p className="text-body text-ink">
            {phase.reason === "race"
              ? "That seat just filled — nothing was booked or charged."
              : "This session is full."}{" "}
            Join the waitlist and we'll text you if a spot opens.
          </p>
          {phase.kind === "waitlist_error" && (
            <p className="text-body text-danger-on-tint">
              We couldn't add you just now. Please try again.
            </p>
          )}
          <PrimaryButton onClick={() => joinWaitlist(phase.reason)}>Join the waitlist</PrimaryButton>
        </Panel>
      )}

      {phase.kind === "joining" && (
        <p className="text-body text-ink-muted" role="status">
          Adding you to the waitlist…
        </p>
      )}

      {phase.kind === "waitlisted" && (
        <Panel tone="ok" role="status">
          <p className="text-body font-medium text-ink">
            You're on the waitlist — position {phase.position}. We'll text you if a spot opens.
          </p>
        </Panel>
      )}

      {phase.kind === "book_error" && (
        <Panel tone="danger" role="alert">
          <p className="text-body text-danger-on-tint">
            Something went wrong and you were not booked or charged. Please try again.
          </p>
          <PrimaryButton onClick={book}>Try again</PrimaryButton>
        </Panel>
      )}

      {phase.kind === "unavailable" && (
        <Panel tone="warn" role="alert">
          <p className="text-body text-ink">
            This session isn't open for booking anymore — it may have started or been changed. Nothing
            was booked or charged. Head back to the schedule to pick another.
          </p>
          <a href="/" className="text-chrome font-medium text-link">
            ← Back to the schedule
          </a>
        </Panel>
      )}
    </section>
  );
}

function Panel({
  tone,
  role,
  children,
}: {
  tone: "ok" | "warn" | "danger";
  role: "status" | "alert";
  children: React.ReactNode;
}) {
  const ring =
    tone === "danger"
      ? "border-danger-border bg-danger-tint"
      : tone === "warn"
        ? "border-hairline bg-surface-app"
        : "border-hairline bg-surface-app";
  return (
    <div role={role} className={`flex flex-col gap-3 rounded-2 border ${ring} p-4`}>
      {children}
    </div>
  );
}

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand"
    >
      {children}
    </button>
  );
}
