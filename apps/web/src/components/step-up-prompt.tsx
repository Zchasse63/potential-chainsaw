import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError } from "../lib/api.js";
import { Button } from "./button.jsx";

export interface StepUpGrantResult {
  grantToken: string;
  expiresAt: string;
}

export interface StepUpPromptProps {
  open: boolean;
  context: string;
  title?: string;
  onVerify: (pin: string, context: string) => Promise<StepUpGrantResult>;
  onGranted: (grant: StepUpGrantResult) => void;
  onClose: () => void;
}

/** Reusable shared-device actor re-authentication ceremony. */
export function StepUpPrompt({
  open,
  context,
  title = "Confirm it’s you",
  onVerify,
  onGranted,
  onClose,
}: StepUpPromptProps) {
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (open) {
      setPin("");
      setPending(false);
      setError(null);
      setLocked(false);
    }
  }, [open]);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{4,6}$/.test(pin) || pending || locked) return;
    setPending(true);
    setError(null);
    try {
      const grant = await onVerify(pin, context);
      setPin("");
      onGranted(grant);
    } catch (caught) {
      setPin("");
      if (caught instanceof ApiRequestError && caught.status === 423) {
        setLocked(true);
        setError("PIN entry is locked after repeated attempts. Try again after the lock expires.");
      } else if (caught instanceof ApiRequestError && caught.status === 401) {
        setError("That PIN wasn’t accepted. Check it and try again.");
      } else {
        setError("PIN verification didn’t complete. No action was authorized.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-inverse px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
    >
      <form
        className="w-full max-w-sm rounded-3 border border-border-strong bg-surface-card p-6 shadow-3"
        onSubmit={(event) => void submit(event)}
      >
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          Shared-device check
        </p>
        <h2 id="step-up-title" className="mt-1 font-display text-title font-bold text-ink">
          {title}
        </h2>
        <p className="mt-2 text-body text-ink-secondary">
          Enter your personal 4–6 digit PIN. It is never sent by email or shown on screen.
        </p>
        <label className="mt-5 block text-body font-medium text-ink" htmlFor="step-up-pin">
          Personal PIN
        </label>
        <input
          id="step-up-pin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]{4,6}"
          minLength={4}
          maxLength={6}
          autoComplete="off"
          autoFocus
          disabled={pending || locked}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
          className="mt-2 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 font-mono text-title tracking-widest text-ink focus:border-selected-border focus:outline-none focus:ring-2 focus:ring-brand-600 disabled:text-ink-disabled"
          aria-describedby={error === null ? undefined : "step-up-error"}
        />
        {error !== null && (
          <p id="step-up-error" role="alert" className="mt-3 text-body text-danger-on-tint">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!/^\d{4,6}$/.test(pin) || pending || locked}>
            {pending ? "Checking…" : "Verify PIN"}
          </Button>
        </div>
      </form>
    </div>
  );
}
