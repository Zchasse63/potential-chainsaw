import { useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { ApiRequestError } from "../lib/api.js";
import { deviceTimeZone, formatTimestamp } from "../lib/time.js";
import type {
  ActivateWaiverInput,
  CreateWaiverVersionInput,
  SignWaiverInput,
  StaffRole,
  WaiverMutationHandle,
  WaiverStatusData,
  WaiverVersion,
  WaiverVersionsData,
} from "../lib/waivers.js";

/**
 * Waiver admin (Phase 4.3) — the owner/manager surface for versioned waiver
 * text and the front-desk surface for in-person signature capture. Two honest
 * rules run through the whole screen: publishing a version is an explicit,
 * confirmed act (activating one deactivates the rest, server-side, never
 * optimistically) and a signature is append-only legal evidence recorded only
 * after the server confirms — the typed name is never pre-filled.
 */

export interface WaiversScreenProps {
  /** The actor's effective role; gates the version-management affordances. */
  role: StaffRole | undefined;
  /** GET /waivers/versions — every version, newest first. */
  versionsQuery: BoundaryQuery;
  /** POST /waivers/versions — creates an INACTIVE draft. */
  createVersion: WaiverMutationHandle<CreateWaiverVersionInput>;
  /** POST /waivers/versions/:id/activate — the sole publication path. */
  activateVersion: WaiverMutationHandle<ActivateWaiverInput>;
  /** Person-status fetch for desk capture, injected hook-style so tests stub it. */
  statusQueryFor: (personId: string | null) => BoundaryQuery;
  /** POST /waivers/sign — desk capture of an in-person signature. */
  signWaiver: WaiverMutationHandle<SignWaiverInput>;
}

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError || error instanceof Error) return error.message;
  return fallback;
}

/** Active-version badge: text label + marker glyph, never colour alone. */
function ActiveBadge() {
  return (
    <span
      data-testid="waiver-active-badge"
      data-marker="✓"
      className="inline-flex items-center gap-1 rounded-full border border-success-border bg-success-tint px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-success-on-tint"
    >
      <span aria-hidden="true">✓</span>
      Active
    </span>
  );
}

function InactiveTag() {
  return (
    <span className="inline-flex items-center rounded-full border border-hairline bg-surface-app px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-ink-muted">
      Inactive
    </span>
  );
}

/** The explicit confirmation gesture before a version is published. */
function ActivateDialog({
  version,
  currentActive,
  pending,
  onCancel,
  onConfirm,
}: {
  version: WaiverVersion;
  currentActive: WaiverVersion | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-inverse px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="activate-dialog-title"
    >
      <div className="w-full max-w-sm rounded-3 border border-border-strong bg-surface-card p-6 shadow-3">
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          Publish waiver
        </p>
        <h2 id="activate-dialog-title" className="mt-1 font-display text-title font-bold text-ink">
          Activate version {version.version}?
        </h2>
        <p className="mt-2 text-body text-ink-secondary">
          Activating this version makes it the one waiver every new signer sees.{" "}
          {currentActive === null
            ? "There is no active version yet."
            : `Version ${currentActive.version} will be deactivated.`}{" "}
          Existing signatures are kept as legal evidence.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Activating…" : "Confirm activation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The owner/manager "add a draft version" form (creates INACTIVE). */
function NewVersionForm({
  createVersion,
}: {
  createVersion: WaiverMutationHandle<CreateWaiverVersionInput>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const pending = createVersion.status === "pending";
  const canSubmit = body.trim().length > 0 && !pending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    createVersion.mutate({ title: title.trim() === "" ? null : title.trim(), body: body.trim() });
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-3 border border-hairline bg-surface-card p-5 shadow-1"
    >
      <div>
        <h3 className="font-display text-title font-bold text-ink">Draft a new version</h3>
        <p className="mt-1 text-body text-ink-secondary">
          New versions are created inactive. Publishing is the separate, confirmed activate step —
          nothing your members sign changes until then.
        </p>
      </div>
      <div>
        <label htmlFor="waiver-title" className="block text-body font-medium text-ink">
          Waiver title (optional)
        </label>
        <input
          id="waiver-title"
          type="text"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-2 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </div>
      <div>
        <label htmlFor="waiver-body" className="block text-body font-medium text-ink">
          Waiver text
        </label>
        <textarea
          id="waiver-body"
          value={body}
          rows={6}
          maxLength={50_000}
          onChange={(event) => setBody(event.target.value)}
          className="mt-2 w-full rounded-2 border border-input-border bg-surface-input px-3 py-2 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </div>
      {createVersion.status === "error" && (
        <p role="alert" className="text-body text-danger-on-tint">
          {mutationErrorMessage(
            createVersion.error,
            "The draft wasn't saved. No version was created.",
          )}
        </p>
      )}
      {createVersion.status === "success" && (
        <p role="status" className="text-body text-success-on-tint">
          ✓ Draft saved as an inactive version — activate it to publish.
        </p>
      )}
      <Button type="submit" disabled={!canSubmit}>
        {pending ? "Saving…" : "New version"}
      </Button>
    </form>
  );
}

function VersionManagement({
  versions,
  activeVersion,
  activateVersion,
  createVersion,
}: {
  versions: WaiverVersion[];
  activeVersion: WaiverVersion | null;
  activateVersion: WaiverMutationHandle<ActivateWaiverInput>;
  createVersion: WaiverMutationHandle<CreateWaiverVersionInput>;
}) {
  const [confirming, setConfirming] = useState<WaiverVersion | null>(null);
  const activating = activateVersion.status === "pending";

  return (
    <section aria-labelledby="waiver-versions-heading" className="space-y-4">
      <h2 id="waiver-versions-heading" className="font-display text-title font-bold text-ink">
        Waiver versions
      </h2>

      {versions.length === 0 ? (
        <EmptyState
          title="No waiver versions yet."
          body="This is a real empty state, not a sync gap — draft the first version below, then activate it to publish."
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card shadow-1">
          {versions.map((version) => (
            <li key={version.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-table font-medium text-ink">
                    Version {version.version}
                  </span>
                  {version.active ? <ActiveBadge /> : <InactiveTag />}
                </div>
                <p className="mt-1 text-body text-ink-secondary">
                  {version.title ?? "Untitled waiver"}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-chrome text-ink-muted">
                  {version.body}
                </p>
                <p className="mt-1 text-chrome text-ink-muted">
                  Created {formatTimestamp(version.created_at)} · {deviceTimeZone()}
                </p>
              </div>
              {!version.active && (
                <Button
                  variant="secondary"
                  className="h-9 shrink-0"
                  disabled={activating}
                  onClick={() => setConfirming(version)}
                >
                  Activate version {version.version}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {activateVersion.status === "error" && (
        <p role="alert" className="text-body text-danger-on-tint">
          {mutationErrorMessage(
            activateVersion.error,
            "The version wasn't activated. The published waiver is unchanged.",
          )}
        </p>
      )}

      <NewVersionForm createVersion={createVersion} />

      {confirming !== null && (
        <ActivateDialog
          version={confirming}
          currentActive={activeVersion}
          pending={activating}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            activateVersion.mutate({ id: confirming.id });
            setConfirming(null);
          }}
        />
      )}
    </section>
  );
}

function PersonStatus({ status }: { status: WaiverStatusData["status"] }) {
  const signed =
    status.signed_version === null ? "never signed" : `last signed version ${status.signed_version}`;
  return (
    <div
      role="status"
      className={
        status.needs_signature
          ? "rounded-2 border border-warning-border bg-warning-tint px-4 py-3"
          : "rounded-2 border border-success-border bg-success-tint px-4 py-3"
      }
    >
      <p
        className={
          status.needs_signature
            ? "text-body font-medium text-warning-on-tint"
            : "text-body font-medium text-success-on-tint"
        }
      >
        {status.needs_signature
          ? `▲ Needs a signature on version ${status.active_version ?? "—"}`
          : "✓ Signed the current waiver"}
      </p>
      <p className="mt-1 text-chrome text-ink-secondary">
        Active version {status.active_version ?? "—"} · this person has {signed}.
      </p>
    </div>
  );
}

/** The read-active-text + typed-name + acknowledgement capture form. */
function CaptureForm({
  personId,
  activeVersion,
  signWaiver,
}: {
  personId: string;
  activeVersion: WaiverVersion;
  signWaiver: WaiverMutationHandle<SignWaiverInput>;
}) {
  const [typedName, setTypedName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const pending = signWaiver.status === "pending";
  const canSubmit = typedName.trim().length > 0 && acknowledged && !pending;

  function reset() {
    setTypedName("");
    setAcknowledged(false);
    signWaiver.reset();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    signWaiver.mutate({
      person_id: personId,
      waiver_version_id: activeVersion.id,
      typed_name: typedName.trim(),
      acknowledged: true,
    });
  }

  if (signWaiver.status === "success") {
    return (
      <div
        role="status"
        className="space-y-3 rounded-3 border border-success-border bg-success-tint p-5"
      >
        <p className="text-body font-medium text-success-on-tint">
          ✓ Signature recorded — server confirmed
        </p>
        <p className="text-body text-success-on-tint">
          The signature is stored as append-only evidence against version {activeVersion.version}.
        </p>
        <Button variant="secondary" onClick={reset}>
          Capture another signature
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-3 border border-hairline bg-surface-card p-5 shadow-1"
    >
      <div>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          Active waiver · version {activeVersion.version}
        </p>
        <h3 className="mt-1 font-display text-title font-bold text-ink">
          {activeVersion.title ?? "Untitled waiver"}
        </h3>
        <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-2 border border-hairline bg-surface-app p-3 text-body text-ink-secondary">
          {activeVersion.body}
        </p>
      </div>

      <div>
        <label htmlFor="waiver-typed-name" className="block text-body font-medium text-ink">
          Typed full name
        </label>
        <input
          id="waiver-typed-name"
          type="text"
          autoComplete="off"
          value={typedName}
          maxLength={200}
          onChange={(event) => setTypedName(event.target.value)}
          className="mt-2 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        <p className="mt-1 text-chrome text-ink-muted">
          The signer types their own name — it is never pre-filled from the record.
        </p>
      </div>

      <label htmlFor="waiver-ack" className="flex items-start gap-3 text-body text-ink">
        <input
          id="waiver-ack"
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-1 h-4 w-4 rounded-1 border border-input-border text-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        <span>
          I acknowledge I have read and agree to the waiver above (required to record a signature).
        </span>
      </label>

      {signWaiver.status === "error" && (
        <p role="alert" className="text-body text-danger-on-tint">
          {mutationErrorMessage(
            signWaiver.error,
            "The server didn't confirm this signature — nothing was recorded. Try again.",
          )}
        </p>
      )}

      <Button type="submit" disabled={!canSubmit}>
        {pending ? "Recording…" : "Record signature"}
      </Button>
    </form>
  );
}

function DeskCapture({
  activeVersion,
  statusQueryFor,
  signWaiver,
}: {
  activeVersion: WaiverVersion | null;
  statusQueryFor: (personId: string | null) => BoundaryQuery;
  signWaiver: WaiverMutationHandle<SignWaiverInput>;
}) {
  const [personInput, setPersonInput] = useState("");
  const [activePersonId, setActivePersonId] = useState<string | null>(null);
  const statusQuery = statusQueryFor(activePersonId);

  function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = personInput.trim();
    if (trimmed === "") return;
    signWaiver.reset();
    setActivePersonId(trimmed);
  }

  return (
    <section aria-labelledby="waiver-desk-heading" className="space-y-4">
      <div>
        <h2 id="waiver-desk-heading" className="font-display text-title font-bold text-ink">
          Desk capture
        </h2>
        <p className="mt-1 text-body text-ink-secondary">
          Record an in-person signature. Look up a person to see whether they need to sign the
          current waiver.
        </p>
      </div>

      <form onSubmit={lookUp} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="waiver-person-id" className="block text-body font-medium text-ink">
            Person ID
          </label>
          <input
            id="waiver-person-id"
            type="text"
            value={personInput}
            onChange={(event) => setPersonInput(event.target.value)}
            className="mt-2 h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 font-mono text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={personInput.trim() === ""}>
          Look up status
        </Button>
      </form>

      {activePersonId !== null && (
        <DataBoundary<WaiverStatusData>
          name="waiver-person-status"
          query={statusQuery}
          skeleton={<Skeleton className="h-24 w-full rounded-3" />}
          errorConsequence="The waiver status couldn't be loaded — no signature was recorded."
        >
          {(data) => (
            <div className="space-y-4">
              <PersonStatus status={data.status} />
              {activeVersion === null ? (
                <EmptyState
                  title="No active waiver to sign."
                  body="A manager must activate a waiver version before signatures can be captured here."
                />
              ) : (
                // Keyed by person so a new signer always gets an empty form —
                // the typed name is never carried over from the last lookup.
                <CaptureForm
                  key={activePersonId}
                  personId={activePersonId}
                  activeVersion={activeVersion}
                  signWaiver={signWaiver}
                />
              )}
            </div>
          )}
        </DataBoundary>
      )}
    </section>
  );
}

export function WaiversScreen({
  role,
  versionsQuery,
  createVersion,
  activateVersion,
  statusQueryFor,
  signWaiver,
}: WaiversScreenProps) {
  const canManage = role === "owner" || role === "manager";
  const canCapture = canManage || role === "front_desk";

  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">
          Waivers · versioned legal text + desk capture
        </p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Waivers</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          One waiver version is active at a time. Publishing is an explicit, confirmed act, and
          every signature is append-only legal evidence recorded only after the server confirms.
        </p>
      </header>

      <DataBoundary<WaiverVersionsData>
        name="waiver-versions"
        query={versionsQuery}
        skeleton={<Skeleton className="h-96 w-full rounded-3" />}
        errorConsequence="The waiver versions couldn't be loaded — no version was changed and no signature was recorded."
      >
        {(data) => {
          const activeVersion = data.versions.find((version) => version.active) ?? null;
          if (role === undefined) {
            return (
              <p role="status" className="text-body text-ink-muted">
                Checking your permissions…
              </p>
            );
          }
          if (!canManage && !canCapture) {
            return (
              <EmptyState
                title="You don't have waiver permissions."
                body="Waiver management and desk capture are limited to owners, managers, and front-desk staff."
              />
            );
          }
          return (
            <div className="space-y-8">
              {canManage && (
                <VersionManagement
                  versions={data.versions}
                  activeVersion={activeVersion}
                  activateVersion={activateVersion}
                  createVersion={createVersion}
                />
              )}
              {canCapture && (
                <DeskCapture
                  activeVersion={activeVersion}
                  statusQueryFor={statusQueryFor}
                  signWaiver={signWaiver}
                />
              )}
            </div>
          );
        }}
      </DataBoundary>
    </div>
  );
}
