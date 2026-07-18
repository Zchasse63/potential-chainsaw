import { useState } from "react";
import { Button } from "./button.jsx";

export type CampaignPlannedStatus =
  | "eligible"
  | "skip_no_consent"
  | "skip_suppressed"
  | "skip_quiet_hours"
  | "skip_no_address";

export interface ApprovalPerson {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

export interface ApprovalSend {
  id: string;
  person_id: string;
  planned_status: CampaignPlannedStatus;
  person: ApprovalPerson;
}

export interface ApprovalCampaign {
  id: string;
  name: string;
  channel: "email" | "sms";
  status: "draft" | "pending_approval" | "approved" | "sending" | "sent" | "cancelled";
  draft_subject: string | null;
  draft_body: string;
  draft_source: "template" | "ai";
}

export interface ApprovalDetail {
  campaign: ApprovalCampaign;
  sends: ApprovalSend[];
  breakdown: Record<CampaignPlannedStatus, number>;
  resolved_sample: { subject: string | null; body: string; person_id: string } | null;
}

const SKIPS: Array<{
  key: Exclude<CampaignPlannedStatus, "eligible">;
  title: string;
  explanation: string;
}> = [
  {
    key: "skip_no_consent",
    title: "No marketing consent",
    explanation: "These recipients have no qualifying channel consent.",
  },
  {
    key: "skip_suppressed",
    title: "Suppressed or opted out",
    explanation: "STOP, unsubscribe, bounce, complaint, or manual suppression. Staff cannot override this.",
  },
  {
    key: "skip_quiet_hours",
    title: "Studio quiet hours",
    explanation: "The preview will not treat these recipients as eligible during studio quiet hours.",
  },
  {
    key: "skip_no_address",
    title: "No channel address",
    explanation: "No usable email address or phone number is available for this channel.",
  },
];

function personName(person: ApprovalPerson): string {
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  return name || "Unnamed person";
}

export function ApprovalCeremony({
  detail,
  onApprove,
}: {
  detail: ApprovalDetail;
  onApprove: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = detail.breakdown.eligible;
  const canApprove = detail.campaign.status === "pending_approval" && eligible > 0 && !pending;

  async function approve(): Promise<void> {
    const confirmed = window.confirm(
      `Approve this ${detail.campaign.channel} campaign and enqueue ${eligible} recipients? Consent, suppression, and quiet hours will be checked again at send time.`,
    );
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await onApprove();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Approval failed before the server acknowledged it.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="approval-heading" className="space-y-5 rounded-3 border border-hairline bg-surface-card p-5 shadow-1">
      <header>
        <p className="font-mono text-micro uppercase tracking-wide text-ai-accent">
          Approval ceremony · explicit owner action
        </p>
        <h2 id="approval-heading" className="mt-1 font-display text-title font-bold text-ink">
          Review audience and exact content
        </h2>
        <p className="mt-1 text-body text-ink-secondary">
          Planning is a preview. The send worker re-checks consent, suppression, and studio quiet hours before every provider call.
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2 border border-success-border bg-success-tint p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-success-on-tint">Eligible</p>
          <p className="mt-1 font-display text-title font-bold text-success-on-tint">{eligible} recipients</p>
        </div>
        <div className="rounded-2 border border-hairline bg-surface-app p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">Skipped</p>
          <p className="mt-1 font-display text-title font-bold text-ink">
            {detail.sends.length - eligible} recipients
          </p>
        </div>
      </div>

      <div aria-label="Policy skip breakdown" className="space-y-2">
        {SKIPS.map((skip) => {
          const rows = detail.sends.filter((send) => send.planned_status === skip.key);
          return (
            <details key={skip.key} className="rounded-2 border border-hairline bg-surface-app px-4 py-3">
              <summary className="cursor-pointer text-body font-medium text-ink">
                {rows.length} {skip.title}
              </summary>
              <p className="mt-2 text-chrome text-ink-secondary">{skip.explanation}</p>
              {rows.length > 0 && (
                <ul className="mt-2 divide-y divide-hairline">
                  {rows.map((send) => (
                    <li key={send.id} className="py-2 text-body text-ink-secondary">
                      {personName(send.person)} — skipped, never overridable
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
      </div>

      <section aria-labelledby="draft-preview" className="rounded-3 border border-ai-border-tint bg-ai-surface p-5">
        <p className="font-mono text-micro uppercase tracking-wide text-ai-on-tint">
          {detail.campaign.draft_source === "ai" ? "Draft · Kelo Intelligence" : "Draft · Approved template"}
        </p>
        <h3 id="draft-preview" className="mt-2 font-display text-title font-bold text-ink">
          Resolved sample message
        </h3>
        {detail.resolved_sample === null ? (
          <p className="mt-2 text-body text-ink-secondary">No eligible recipient is available for a resolved preview.</p>
        ) : (
          <div className="mt-3 space-y-2 rounded-2 border border-ai-border-tint bg-surface-card p-4">
            {detail.resolved_sample.subject !== null && (
              <p className="text-body font-medium text-ink">{detail.resolved_sample.subject}</p>
            )}
            <p className="whitespace-pre-wrap text-body text-ink-secondary">{detail.resolved_sample.body}</p>
          </div>
        )}
      </section>

      {error !== null && (
        <p role="alert" className="rounded-2 border border-danger-border bg-danger-tint px-4 py-2 text-body text-danger-on-tint">
          {error} Nothing was marked sent in this browser.
        </p>
      )}

      <div>
        <Button disabled={!canApprove} onClick={() => void approve()}>
          {pending ? "Waiting for server acknowledgement…" : `Approve & send to ${eligible} recipients`}
        </Button>
        {detail.campaign.status !== "pending_approval" && (
          <p className="mt-2 text-chrome text-ink-muted">
            This action is unavailable while the campaign is {detail.campaign.status.replaceAll("_", " ")}.
          </p>
        )}
      </div>
    </section>
  );
}
