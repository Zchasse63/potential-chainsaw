import { useState, type FormEvent } from "react";
import { Button } from "../components/button.jsx";
import { DataBoundary, type BoundaryQuery } from "../components/data-boundary.jsx";
import { EmptyState } from "../components/empty-state.jsx";
import { PaymentStatusChip, TenderBadge } from "../components/payment-chips.jsx";
import { Skeleton } from "../components/skeleton.jsx";
import { StepUpPrompt, type StepUpGrantResult } from "../components/step-up-prompt.jsx";
import type { DunningRow, Payment, RefundAccepted } from "../lib/payments.js";
import { REFUND_STEP_UP_CONTEXT } from "../lib/payments.js";

/**
 * Payments — the owner/manager money surface (unit 5.8). A presentational
 * screen: every query and mutation is injected so it is unit-testable without a
 * network. Two tabs: the payments list + detail (with the refund ceremony) and
 * the dunning queue.
 *
 * Money discipline (invariant #5): there is NO optimistic status. A refund
 * request shows a server-returned "requested — pending provider" note; the
 * payment's own status chip keeps reading the webhook-confirmed status until the
 * inbox flips it on the next re-read. The amount ceiling here is advisory — the
 * server re-verifies every refund against the true remaining balance.
 */

export interface RefundSubmit {
  amountCents: number;
  reason: string | null;
  grantToken?: string;
}

export interface PaymentsScreenProps {
  paymentsQuery: BoundaryQuery;
  dunningQuery: BoundaryQuery;
  /** The tenant's refund step-up threshold (cents) — above it the PIN ceremony
   *  is required. Sourced from the /payments envelope, never a client default. */
  refundThresholdCents: number;
  onRefund: (paymentId: string, input: RefundSubmit) => Promise<RefundAccepted>;
  onVerifyStepUp: (pin: string, context: string) => Promise<StepUpGrantResult>;
}

const INPUT_CLASS =
  "h-11 w-full rounded-2 border border-input-border bg-surface-input px-3 text-body text-ink focus:outline-none focus:ring-2 focus:ring-brand-600";
const LABEL_CLASS = "block text-body font-medium text-ink";
const FIELD_HINT = "font-mono text-micro uppercase tracking-wide text-ink-muted";
const REFUNDABLE: ReadonlySet<Payment["status"]> = new Set(["succeeded", "partially_refunded"]);

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

/** The refund form + the step-up ceremony gate. Above the threshold the manager
 *  PIN is collected first and its grant rides the refund POST; under it, the
 *  refund posts directly. NO optimistic status change on success. */
function RefundPanel({
  payment,
  refundThresholdCents,
  onRefund,
  onVerifyStepUp,
}: {
  payment: Payment;
  refundThresholdCents: number;
  onRefund: (paymentId: string, input: RefundSubmit) => Promise<RefundAccepted>;
  onVerifyStepUp: (pin: string, context: string) => Promise<StepUpGrantResult>;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<RefundAccepted | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);

  const cents = dollarsToCents(amount);
  const overRemaining = cents !== null && cents > payment.amount_cents;
  const valid = cents !== null && cents > 0 && !overRemaining;
  const needsStepUp = cents !== null && cents > refundThresholdCents;

  async function post(grantToken?: string) {
    if (cents === null) return;
    setPending(true);
    setError(null);
    try {
      const result = await onRefund(payment.id, {
        amountCents: cents,
        reason: reason.trim() === "" ? null : reason.trim(),
        grantToken,
      });
      setAccepted(result);
      setAmount("");
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The refund wasn't accepted.");
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending) return;
    if (needsStepUp) {
      setStepUpOpen(true);
      return;
    }
    void post();
  }

  return (
    <div className="space-y-3">
      <form
        className="grid gap-3 rounded-3 border border-hairline bg-surface-card p-4"
        onSubmit={submit}
      >
        <p className={FIELD_HINT}>Refund · webhook confirms the final status</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL_CLASS} htmlFor="refund-amount">
              Amount <span className={FIELD_HINT}>USD</span>
            </label>
            <input
              id="refund-amount"
              inputMode="decimal"
              className={INPUT_CLASS}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              aria-describedby="refund-amount-hint"
            />
            <p id="refund-amount-hint" className="mt-1 text-body text-ink-muted">
              Up to {formatCents(payment.amount_cents)}. The server re-verifies against the true
              remaining balance.
            </p>
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="refund-reason">
              Reason <span className={FIELD_HINT}>optional</span>
            </label>
            <input
              id="refund-reason"
              className={INPUT_CLASS}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
        {overRemaining && (
          <p role="alert" className="text-body text-danger-on-tint">
            That is more than this payment&apos;s {formatCents(payment.amount_cents)}.
          </p>
        )}
        {needsStepUp && valid && (
          <p className="text-body text-warning-on-tint" data-testid="step-up-required-note">
            Above {formatCents(refundThresholdCents)} a manager PIN is required to authorize this
            refund.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-body text-danger-on-tint">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={!valid || pending}>
            {pending ? "Submitting…" : needsStepUp ? "Confirm & refund" : "Issue refund"}
          </Button>
        </div>
      </form>

      {accepted !== null && (
        <div
          role="status"
          data-testid="refund-requested"
          className="rounded-3 border border-info-border bg-info-tint p-4"
        >
          <p className="text-body font-medium text-info-on-tint">
            Refund requested — {formatCents(accepted.amount_cents)} is pending provider confirmation.
          </p>
          <p className="mt-1 text-body text-info-on-tint">
            The payment stays as it is until the Stripe webhook confirms the refund; this list will
            reflect the new status once it does.
          </p>
        </div>
      )}

      <StepUpPrompt
        open={stepUpOpen}
        context={REFUND_STEP_UP_CONTEXT}
        title="Manager approval for refund"
        onVerify={onVerifyStepUp}
        onGranted={(grant) => {
          setStepUpOpen(false);
          void post(grant.grantToken);
        }}
        onClose={() => setStepUpOpen(false)}
      />
    </div>
  );
}

function PaymentDetail({
  payment,
  refundThresholdCents,
  onRefund,
  onVerifyStepUp,
}: {
  payment: Payment;
  refundThresholdCents: number;
  onRefund: (paymentId: string, input: RefundSubmit) => Promise<RefundAccepted>;
  onVerifyStepUp: (pin: string, context: string) => Promise<StepUpGrantResult>;
}) {
  return (
    <div className="space-y-4 rounded-3 border border-hairline bg-surface-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={FIELD_HINT}>Payment {payment.id.slice(0, 8)}…</p>
          <p className="mt-1 font-display text-title font-bold text-ink">
            {formatCents(payment.amount_cents)}{" "}
            <span className="font-mono text-body font-normal uppercase text-ink-muted">
              {payment.currency}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TenderBadge tender={payment.tender} />
          <PaymentStatusChip status={payment.status} />
        </div>
      </div>

      <dl className="grid gap-2 text-body sm:grid-cols-2">
        <div>
          <dt className={FIELD_HINT}>Linked command</dt>
          <dd className="font-mono text-table text-ink-secondary">
            {payment.command_id === null ? "none (cash)" : `${payment.command_id.slice(0, 8)}…`}
          </dd>
        </div>
        <div>
          <dt className={FIELD_HINT}>Stripe intent</dt>
          <dd className="font-mono text-table text-ink-secondary">
            {payment.stripe_payment_intent_id ?? "none"}
          </dd>
        </div>
      </dl>

      {REFUNDABLE.has(payment.status) ? (
        <RefundPanel
          payment={payment}
          refundThresholdCents={refundThresholdCents}
          onRefund={onRefund}
          onVerifyStepUp={onVerifyStepUp}
        />
      ) : (
        <p className="text-body text-ink-muted">
          A refund is available only once the payment is webhook-confirmed as succeeded.
        </p>
      )}
    </div>
  );
}

function PaymentsTab({
  paymentsQuery,
  refundThresholdCents,
  onRefund,
  onVerifyStepUp,
}: Pick<
  PaymentsScreenProps,
  "paymentsQuery" | "refundThresholdCents" | "onRefund" | "onVerifyStepUp"
>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <DataBoundary<{ payments: Payment[]; refund_step_up_cents: number }>
      name="payments-list"
      query={paymentsQuery}
      skeleton={<Skeleton className="h-64 w-full rounded-3" />}
      errorConsequence="The payments list didn't load; nothing was changed."
      isEmpty={(data) => data.payments.length === 0}
      emptyState={
        <EmptyState
          title="No payments yet."
          body="Sales and charges appear here as they are taken; the webhook confirms each one."
        />
      }
    >
      {(data) => {
        const selected = data.payments.find((payment) => payment.id === selectedId) ?? null;
        return (
          <div className="grid gap-6 lg:grid-cols-2">
            <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
              {data.payments.map((payment) => {
                const active = payment.id === selectedId;
                return (
                  <li key={payment.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedId(payment.id)}
                      className={`flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left ${active ? "bg-selected-bg" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-table font-medium text-ink">
                          {formatCents(payment.amount_cents)}
                        </span>
                        <TenderBadge tender={payment.tender} />
                      </div>
                      <PaymentStatusChip status={payment.status} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div>
              {selected === null ? (
                <div className="rounded-3 border border-dashed border-hairline bg-surface-card p-5">
                  <p className="text-body text-ink-muted">
                    Select a payment to see its detail and refund options.
                  </p>
                </div>
              ) : (
                <PaymentDetail
                  // Remount per payment so a half-typed refund / accepted note
                  // never bleeds from one payment onto another.
                  key={selected.id}
                  payment={selected}
                  refundThresholdCents={refundThresholdCents}
                  onRefund={onRefund}
                  onVerifyStepUp={onVerifyStepUp}
                />
              )}
            </div>
          </div>
        );
      }}
    </DataBoundary>
  );
}

function DunningTab({ dunningQuery }: { dunningQuery: BoundaryQuery }) {
  return (
    <DataBoundary<{ dunning: DunningRow[] }>
      name="dunning-queue"
      query={dunningQuery}
      skeleton={<Skeleton className="h-48 w-full rounded-3" />}
      errorConsequence="The dunning queue didn't load; nothing was changed."
      isEmpty={(data) => data.dunning.length === 0}
      emptyState={
        <EmptyState
          title="No subscriptions in dunning."
          body="Members in grace or past due appear here with their stage and grace expiry."
        />
      }
    >
      {(data) => (
        <ul className="divide-y divide-hairline rounded-3 border border-hairline bg-surface-card">
          {data.dunning.map((row) => (
            <li
              key={row.subscription_id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div>
                <p className="text-body font-medium text-ink">
                  {row.person_name ?? `Member ${row.person_id.slice(0, 8)}…`}
                </p>
                <p className={FIELD_HINT} data-testid={`dunning-stage-${row.subscription_id}`}>
                  {DUNNING_STAGE_LABEL[row.stage]}
                  {" · "}
                  {row.grace_expires_at === null
                    ? "no grace expiry"
                    : `grace ends ${formatDate(row.grace_expires_at)}`}
                </p>
              </div>
              <span title="The member payment-update link is issued from the member surface, which ships later.">
                <Button variant="ghost" className="h-9" disabled>
                  Copy payment-update link
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </DataBoundary>
  );
}

const DUNNING_STAGE_LABEL: Record<DunningRow["stage"], string> = {
  grace_started: "Grace started",
  reminder_sent: "Reminder sent",
  final_notice: "Final notice",
  past_due: "Past due",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const TAB_BASE = "rounded-2 px-3 py-2 text-body font-medium";
const TAB_ACTIVE = "bg-selected-bg text-ink";
const TAB_IDLE = "text-ink-secondary";

export function PaymentsScreen({
  paymentsQuery,
  dunningQuery,
  refundThresholdCents,
  onRefund,
  onVerifyStepUp,
}: PaymentsScreenProps) {
  const [tab, setTab] = useState<"payments" | "dunning">("payments");

  return (
    <div className="space-y-8">
      <header>
        <p className={FIELD_HINT}>Payments · charges, refunds, dunning</p>
        <h1 className="mt-1 font-display text-hero font-bold tracking-tight text-ink">Payments</h1>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          Every charge and refund with its provenance — the Stripe webhook is the confirmation
          authority, so nothing here is shown as done before the provider says so.
        </p>
      </header>

      <div role="tablist" aria-label="Payments views" className="flex gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "payments"}
          className={`${TAB_BASE} ${tab === "payments" ? TAB_ACTIVE : TAB_IDLE}`}
          onClick={() => setTab("payments")}
        >
          Payments
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "dunning"}
          className={`${TAB_BASE} ${tab === "dunning" ? TAB_ACTIVE : TAB_IDLE}`}
          onClick={() => setTab("dunning")}
        >
          Dunning queue
        </button>
      </div>

      {tab === "payments" ? (
        <PaymentsTab
          paymentsQuery={paymentsQuery}
          refundThresholdCents={refundThresholdCents}
          onRefund={onRefund}
          onVerifyStepUp={onVerifyStepUp}
        />
      ) : (
        <DunningTab dunningQuery={dunningQuery} />
      )}
    </div>
  );
}
