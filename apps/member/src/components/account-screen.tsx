import { useEffect, useState, type ReactNode } from "react";
import type { AccountView } from "../lib/account-view.js";

/**
 * The read-only member account area (plan-member-app §6): live credit balance,
 * waiver status, and the sessions you're booked into. Session-gated — a
 * 401 hands off to Identify via onRequireSignIn. Presentational: the route
 * injects `load` (member-core + schedule join) and the navigation callback, so
 * this holds no tenant/secret and sends no member id (scope is the cookie).
 */

export interface AccountScreenProps {
  load: () => Promise<AccountView>;
  onRequireSignIn: () => void;
  /** Revoke the session (the route calls member-core logout, then navigates). */
  onSignOut: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; view: Extract<AccountView, { ok: true }> };

export function AccountScreen({ load, onRequireSignIn, onSignOut }: AccountScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const view = await load();
        if (!live) return;
        if (!view.ok) {
          if (view.unauthenticated) {
            onRequireSignIn();
            return; // hold the "loading" copy while the route navigates away
          }
          setPhase({ kind: "error" });
          return;
        }
        setPhase({ kind: "ready", view });
      } catch {
        // A rejecting load() (never from fetchAccount, but possible from a
        // formatting throw) must not strand the spinner — surface retry.
        if (live) setPhase({ kind: "error" });
      }
    })();
    return () => {
      live = false;
    };
  }, [reloadKey]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 pb-12 pt-6">
      <header className="pb-6">
        <h1 className="text-title font-medium text-ink">Your account</h1>
      </header>

      {phase.kind === "loading" && (
        <p className="text-body text-ink-muted" role="status">
          Loading your account…
        </p>
      )}

      {phase.kind === "error" && (
        <div role="alert" className="flex flex-col gap-3 rounded-2 border border-danger-border bg-danger-tint p-4">
          <p className="text-body text-danger-on-tint">
            We couldn't load your account just now. Nothing is wrong with your bookings — please try again.
          </p>
          <button
            type="button"
            onClick={() => {
              setPhase({ kind: "loading" });
              setReloadKey((k) => k + 1);
            }}
            className="self-start rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand"
          >
            Try again
          </button>
        </div>
      )}

      {phase.kind === "ready" && (
        <>
          <AccountBody view={phase.view} />
          {/* Shared-device sign-out (§3H parking-lot phone): revoke the session
              so the next person can't land on this member's account. */}
          <button
            type="button"
            onClick={onSignOut}
            className="mt-8 w-full rounded-3 border border-border-strong px-4 py-3 text-body font-medium text-ink"
          >
            Sign out
          </button>
        </>
      )}
    </main>
  );
}

function Badge({ tone, children }: { tone: "success" | "warning" | "neutral"; children: ReactNode }) {
  const classes =
    tone === "success"
      ? "border-success-border bg-success-tint text-success-on-tint"
      : tone === "warning"
        ? "border-warning-border bg-warning-tint text-warning-on-tint"
        : "border-hairline bg-surface-app text-ink-secondary";
  return (
    <span className={`shrink-0 rounded-2 border px-2 py-1 text-chrome font-medium ${classes}`}>{children}</span>
  );
}

function AccountBody({ view }: { view: Extract<AccountView, { ok: true }> }) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Credits" className="rounded-3 border border-hairline bg-surface-card p-4 shadow-1">
        <p className="text-chrome uppercase tracking-wide text-ink-muted">Credit balance</p>
        <p className="mt-1 font-display text-title font-bold text-ink">{view.creditBalance}</p>
        <p className="mt-1 text-body text-ink-muted">
          {view.creditBalance === 1 ? "1 credit" : `${view.creditBalance} credits`} · each session costs 1.
        </p>
      </section>

      <section aria-label="Waiver" className="flex items-center justify-between gap-3">
        <span className="text-body text-ink">Waiver</span>
        {view.waiverNeedsSignature ? (
          <Badge tone="warning">Signature needed</Badge>
        ) : (
          <Badge tone="success">Signed</Badge>
        )}
      </section>

      <section aria-label="Your sessions" className="flex flex-col gap-3">
        <h2 className="font-mono text-micro uppercase tracking-wide text-ink-muted">Your sessions</h2>
        {view.bookings.length === 0 ? (
          <div className="rounded-2 border border-hairline bg-surface-app px-4 py-8 text-center">
            <p className="text-body font-medium text-ink-secondary">No sessions booked yet</p>
            <p className="mx-auto mt-1 max-w-md text-body text-ink-muted">
              When you book from the schedule, your sessions show up here.
            </p>
            <a
              href="/"
              className="mt-4 inline-block rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand"
            >
              Browse the schedule
            </a>
          </div>
        ) : (
          <ul className="space-y-3">
            {view.bookings.map((b) => (
              <li
                key={b.bookingId}
                className="flex items-start justify-between gap-3 rounded-3 border border-hairline bg-surface-card p-4 shadow-1"
              >
                <div>
                  <p className="text-body font-medium text-ink">{b.title}</p>
                  <p className="mt-0.5 text-body text-ink-secondary">{b.when ?? "Time to be confirmed"}</p>
                </div>
                {b.status === "checked_in" ? (
                  <Badge tone="success">Checked in</Badge>
                ) : (
                  <Badge tone="neutral">Booked</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
