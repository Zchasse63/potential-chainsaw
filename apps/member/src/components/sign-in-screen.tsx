import { useState, type FormEvent } from "react";

/**
 * The Identify stage (plan-ux §H) — a phone-first two-step OTP sign-in. Step 1
 * takes a contact and requests a code; ANTI-ENUMERATION means the UI advances
 * to the code step on ANY accepted request (never "no such member"). Step 2
 * takes the 6-digit code; on success the API has set the host-only session
 * cookie (web) and we hand off via onSignedIn.
 *
 * Presentational only: the route injects onStart/onVerify (wired to
 * @kelo/member-core) and onSignedIn (navigation), so this is unit-testable with
 * fakes and holds NO tenant/secret material itself.
 */

export interface SignInScreenProps {
  /** Request an OTP. Resolves ok on ANY accepted request (neutral 202). */
  onStart: (contact: string) => Promise<{ ok: boolean }>;
  /** Verify the code. ok === true means the session is established. */
  onVerify: (contact: string, code: string) => Promise<{ ok: boolean }>;
  /** Called once the session is established (the route navigates on). */
  onSignedIn: () => void;
}

type Step = "contact" | "code";

export function SignInScreen({ onStart, onVerify, onSignedIn }: SignInScreenProps) {
  const [step, setStep] = useState<Step>("contact");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitContact(e: FormEvent) {
    e.preventDefault();
    if (contact.trim() === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      // Neutral by construction: whether or not the contact matches a member,
      // an accepted request advances to the code step — the UI reveals nothing.
      const res = await onStart(contact.trim());
      if (res.ok) {
        setStep("code");
      } else {
        setError("We couldn't send a code right now. Please try again in a moment.");
      }
    } finally {
      setPending(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (code.trim() === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await onVerify(contact.trim(), code.trim());
      if (res.ok) {
        onSignedIn();
      } else {
        setError("That code is invalid or expired. Check it, or request a new one.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Sign in" className="mx-auto flex max-w-sm flex-col gap-4 p-4">
      <h1 className="font-display text-title font-bold text-ink">Sign in</h1>

      {step === "contact" ? (
        <form onSubmit={submitContact} className="flex flex-col gap-3" aria-label="Request a sign-in code">
          <label className="text-body text-ink" htmlFor="signin-contact">
            Your email or mobile number
          </label>
          <input
            id="signin-contact"
            name="contact"
            type="text"
            inputMode="email"
            autoComplete="email"
            value={contact}
            onChange={(ev) => setContact(ev.target.value)}
            className="rounded-2 border border-border-strong bg-surface-input px-3 py-3 text-body text-ink"
            placeholder="you@example.com"
          />
          <button
            type="submit"
            disabled={pending || contact.trim() === ""}
            className="rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand disabled:bg-neutral-050 disabled:text-ink-disabled"
          >
            {pending ? "Sending…" : "Send me a code"}
          </button>
          <p className="text-chrome text-ink-muted">
            We'll text or email a 6-digit code. New here? The same step gets you started.
          </p>
        </form>
      ) : (
        <form onSubmit={submitCode} className="flex flex-col gap-3" aria-label="Enter your code">
          <label className="text-body text-ink" htmlFor="signin-code">
            Enter the 6-digit code we sent to {contact.trim()}
          </label>
          <input
            id="signin-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ""))}
            className="rounded-2 border border-border-strong bg-surface-input px-3 py-3 text-title tracking-widest text-ink"
            placeholder="••••••"
          />
          <button
            type="submit"
            disabled={pending || code.trim().length < 6}
            className="rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand disabled:bg-neutral-050 disabled:text-ink-disabled"
          >
            {pending ? "Checking…" : "Verify & sign in"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("contact");
              setCode("");
              setError(null);
            }}
            className="text-chrome text-link"
          >
            Use a different contact
          </button>
        </form>
      )}

      {error !== null && (
        <p role="alert" className="rounded-2 border border-danger-border bg-danger-tint p-3 text-body text-danger-on-tint">
          {error}
        </p>
      )}
    </section>
  );
}
