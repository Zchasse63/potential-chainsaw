import { useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { useAuth } from "./auth-context.jsx";

/**
 * Sign-in scaffolding (phase 0 — NOT the final auth UX). Email + password,
 * or a magic link. Every outcome is stated plainly: failures say what
 * happened, the magic-link path confirms where the email went.
 */
export function SignInScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "magic" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [magicSentTo, setMagicSentTo] = useState<string | null>(null);

  if (auth.status === "unconfigured") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-app px-6">
        <div
          role="alert"
          className="max-w-md rounded-3 border border-warning-border bg-warning-tint p-6"
        >
          <p className="text-body font-medium text-warning-emphasis">
            Sign-in isn&apos;t configured for this deployment
          </p>
          <p className="mt-1 text-body text-warning-on-tint">
            VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set, so no one can sign in and no
            data can load. Set them in the deploy environment and reload.
          </p>
        </div>
      </main>
    );
  }

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (auth.client === null) return;
    setBusy("password");
    setError(null);
    const { error: signInError } = await auth.client.auth.signInWithPassword({ email, password });
    setBusy(null);
    if (signInError !== null) {
      setError(`Sign-in failed: ${signInError.message}`);
    }
    // Success flips AuthContext via onAuthStateChange — nothing to do here.
  };

  const sendMagicLink = async () => {
    if (auth.client === null) return;
    setBusy("magic");
    setError(null);
    setMagicSentTo(null);
    const { error: otpError } = await auth.client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(null);
    if (otpError !== null) {
      setError(`Couldn't send the sign-in link: ${otpError.message}`);
    } else {
      setMagicSentTo(email);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-app px-6">
      <div className="w-full max-w-sm rounded-3 border border-hairline bg-surface-card p-6">
        <p className="font-display text-title font-bold tracking-tight">kelo</p>
        <p className="mt-1 font-mono text-micro uppercase tracking-wide text-ink-muted">
          Studio Operations
        </p>
        <form className="mt-6 space-y-4" onSubmit={(event) => void submitPassword(event)}>
          <div>
            <label htmlFor="sign-in-email" className="mb-1 block text-body font-medium text-ink">
              Email
            </label>
            <input
              id="sign-in-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink"
            />
          </div>
          <div>
            <label htmlFor="sign-in-password" className="mb-1 block text-body font-medium text-ink">
              Password
            </label>
            <input
              id="sign-in-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink"
            />
          </div>
          {error !== null && (
            <p
              role="alert"
              className="rounded-2 border border-danger-border bg-danger-tint px-3 py-2 text-body text-danger-on-tint"
            >
              {error}
            </p>
          )}
          {magicSentTo !== null && (
            <p
              role="status"
              className="rounded-2 border border-success-border bg-success-tint px-3 py-2 text-body text-success-on-tint"
            >
              Sign-in link sent to {magicSentTo} — check your email.
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy !== null}>
            {busy === "password" ? "Signing in…" : "Sign in"}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            disabled={busy !== null || email === ""}
            onClick={() => void sendMagicLink()}
          >
            {busy === "magic" ? "Sending link…" : "Email me a sign-in link instead"}
          </Button>
        </form>
      </div>
    </main>
  );
}
