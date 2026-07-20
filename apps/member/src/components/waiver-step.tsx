import { useEffect, useState, type FormEvent } from "react";

/**
 * The Waiver stage (plan-member-app §7): read the active waiver, type your name,
 * check the box, sign — all in-flow, replacing the old "sign at the front desk"
 * dead-end. Self-contained (owns its load + form + sign state, like
 * sign-in-screen); the parent injects the member-core-wired callbacks.
 *
 * On a successful sign (or if the waiver turns out already-signed — a race
 * between the account gate and this mount), it calls onSigned, which re-runs the
 * booking gate and proceeds to the credit-book path. A version-changed sign
 * reloads the text rather than resubmitting a stale acceptance.
 */

export type WaiverLoad =
  | { ok: true; needsSignature: boolean; title: string | null; body: string | null }
  | { ok: false };
export type SignWaiverOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid" | "version_changed" | "retry" };

export interface WaiverStepProps {
  loadWaiver: () => Promise<WaiverLoad>;
  onSign: (typedName: string) => Promise<SignWaiverOutcome>;
  /** Called once the waiver is signed (or already satisfied) — the route re-gates. */
  onSigned: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "load_error" }
  | { kind: "form"; title: string | null; body: string }
  | { kind: "signing"; title: string | null; body: string }
  | { kind: "sign_error"; title: string | null; body: string; message: string };

export function WaiverStep({ loadWaiver, onSign, onSigned }: WaiverStepProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [typedName, setTypedName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await loadWaiver();
      if (!live) return;
      if (!res.ok) {
        setPhase({ kind: "load_error" });
        return;
      }
      // Already covered (signed elsewhere, or no active waiver to sign) — hand
      // straight back to the gate; render nothing but the loading copy meanwhile.
      if (!res.needsSignature || res.body === null) {
        onSigned();
        return;
      }
      setPhase({ kind: "form", title: res.title, body: res.body });
    })();
    return () => {
      live = false;
    };
  }, [reloadKey]);

  function reload() {
    // A version change means the member must re-affirm the NEW text — never
    // carry a v1 name + acknowledgement onto v2 (the "never sign stale"
    // guarantee this module exists to provide).
    setAcknowledged(false);
    setTypedName("");
    setPhase({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phase.kind !== "form" && phase.kind !== "sign_error") return;
    if (typedName.trim() === "" || !acknowledged) return;
    const { title, body } = phase;
    setPhase({ kind: "signing", title, body });
    const res = await onSign(typedName.trim());
    if (res.ok) {
      onSigned();
      return;
    }
    if (res.reason === "version_changed") {
      // The active waiver moved under us — reload the text; never sign stale.
      reload();
      return;
    }
    const message =
      res.reason === "invalid"
        ? "Please enter your full name exactly as you'd sign it."
        : "Something went wrong and nothing was signed. Please try again.";
    setPhase({ kind: "sign_error", title, body, message });
  }

  if (phase.kind === "loading" || phase.kind === "signing") {
    return (
      <p className="text-body text-ink-muted" role="status">
        {phase.kind === "signing" ? "Signing…" : "Loading the waiver…"}
      </p>
    );
  }

  if (phase.kind === "load_error") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-2 border border-danger-border bg-danger-tint p-4">
        <p className="text-body text-danger-on-tint">
          We couldn't load the waiver just now. Nothing was signed — please try again.
        </p>
        <button
          type="button"
          onClick={reload}
          className="self-start rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand"
        >
          Try again
        </button>
      </div>
    );
  }

  // form | sign_error
  const title = phase.title ?? "Liability waiver";
  const body = phase.body;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Sign the waiver">
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-body font-bold text-ink">{title}</h2>
        <div
          tabIndex={0}
          role="region"
          aria-label="Waiver text"
          className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-2 border border-hairline bg-surface-app p-3 text-body text-ink-secondary"
        >
          {body}
        </div>
      </div>

      <label className="flex flex-col gap-1 text-body text-ink" htmlFor="waiver-name">
        Type your full name to sign
        <input
          id="waiver-name"
          name="typed_name"
          type="text"
          autoComplete="name"
          value={typedName}
          onChange={(ev) => setTypedName(ev.target.value)}
          maxLength={200}
          className="rounded-2 border border-border-strong bg-surface-input px-3 py-3 text-body text-ink"
          placeholder="Your full name"
        />
      </label>

      <label className="flex items-start gap-2 text-body text-ink">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(ev) => setAcknowledged(ev.target.checked)}
          className="mt-1"
        />
        <span>I have read and agree to the waiver above.</span>
      </label>

      <button
        type="submit"
        disabled={typedName.trim() === "" || !acknowledged}
        className="rounded-3 bg-brand-600 px-4 py-3 text-body font-medium text-ink-on-brand disabled:bg-neutral-050 disabled:text-ink-disabled"
      >
        Sign &amp; continue
      </button>

      {phase.kind === "sign_error" && (
        <p role="alert" className="rounded-2 border border-danger-border bg-danger-tint p-3 text-body text-danger-on-tint">
          {phase.message}
        </p>
      )}
    </form>
  );
}
