// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BoundaryQuery } from "../src/components/data-boundary.jsx";
import { PaymentsScreen, type PaymentsScreenProps } from "../src/screens/payments-screen.jsx";

afterEach(cleanup);

const META = {
  as_of: "2026-07-19T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "payments:v1",
  correlation_id: "corr-payments",
};
function success(data: unknown): BoundaryQuery {
  return { status: "success", data: { data, meta: META }, isRefetching: false, refetch: vi.fn() };
}

const SUCCEEDED_PAYMENT = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  customer_id: "cccccccc-1111-4111-8111-cccccccccccc",
  amount_cents: 20000,
  currency: "usd",
  status: "succeeded" as const,
  stripe_payment_intent_id: null,
  command_id: null,
  tender: "cash" as const,
  created_at: "2026-07-19T00:00:00.000Z",
  updated_at: "2026-07-19T00:00:00.000Z",
};

const DUNNING_ROW = {
  subscription_id: "dddddddd-1111-4111-8111-dddddddddddd",
  customer_id: "cccccccc-2222-4222-8222-cccccccccccc",
  person_id: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee",
  person_name: "Dana Pastdue",
  plan_id: "ffffffff-1111-4111-8111-ffffffffffff",
  status: "past_due",
  stage: "grace_started" as const,
  grace_expires_at: "2026-07-25T00:00:00.000Z",
  current_period_end: "2026-07-20T00:00:00.000Z",
  occurred_at: "2026-07-19T00:00:00.000Z",
};

function renderPayments(overrides: Partial<PaymentsScreenProps> = {}) {
  const onRefund = vi
    .fn()
    .mockResolvedValue({ command_id: "cmd-1", payment_id: SUCCEEDED_PAYMENT.id, amount_cents: 0, status: "pending" });
  const onVerifyStepUp = vi
    .fn()
    .mockResolvedValue({ grantToken: "signed-grant", expiresAt: "2026-07-19T12:05:00.000Z" });
  const props: PaymentsScreenProps = {
    paymentsQuery: success({ payments: [SUCCEEDED_PAYMENT], refund_step_up_cents: 10000 }),
    dunningQuery: success({ dunning: [DUNNING_ROW] }),
    refundThresholdCents: 10000,
    onRefund,
    onVerifyStepUp,
    ...overrides,
  };
  render(<PaymentsScreen {...props} />);
  return { onRefund, onVerifyStepUp };
}

function selectPayment() {
  fireEvent.click(screen.getByText("$200.00"));
}

describe("PaymentsScreen", () => {
  it("renders the cash tender badge and webhook-confirmed provenance as TEXT (never color alone)", () => {
    renderPayments();
    // Tender is a labelled badge, not just a colored dot.
    const tender = screen.getAllByTestId("tender-cash")[0] as HTMLElement;
    expect(tender.textContent).toContain("Cash");
    // The status chip carries both the state label and its confirmation
    // authority in text; the color is redundant, not load-bearing.
    const chip = screen.getAllByTestId("payment-status-succeeded")[0] as HTMLElement;
    expect(chip.textContent).toContain("Succeeded");
    expect(chip.textContent).toContain("Webhook-confirmed");
    expect(chip.getAttribute("data-confirmed")).toBe("true");
  });

  it("demands a manager step-up grant for a refund above the threshold and rides it on the POST", async () => {
    const { onRefund, onVerifyStepUp } = renderPayments();
    selectPayment();
    fireEvent.change(document.querySelector("#refund-amount") as HTMLInputElement, {
      target: { value: "150" },
    });
    // The gate is announced before the refund is attempted.
    expect(screen.getByTestId("step-up-required-note")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm & refund" }));

    // No refund is posted until the PIN ceremony grants.
    expect(onRefund).not.toHaveBeenCalled();
    const pin = screen.getByLabelText("Personal PIN") as HTMLInputElement;
    fireEvent.change(pin, { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify PIN" }));

    await waitFor(() => expect(onVerifyStepUp).toHaveBeenCalledWith("1234", "refund_over_threshold"));
    await waitFor(() =>
      expect(onRefund).toHaveBeenCalledWith(SUCCEEDED_PAYMENT.id, {
        amountCents: 15000,
        reason: null,
        grantToken: "signed-grant",
      }),
    );
  });

  it("refunds under the threshold WITHOUT a step-up grant or prompt", async () => {
    const { onRefund, onVerifyStepUp } = renderPayments();
    selectPayment();
    fireEvent.change(document.querySelector("#refund-amount") as HTMLInputElement, {
      target: { value: "50" },
    });
    expect(screen.queryByTestId("step-up-required-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Issue refund" }));

    await waitFor(() =>
      expect(onRefund).toHaveBeenCalledWith(SUCCEEDED_PAYMENT.id, {
        amountCents: 5000,
        reason: null,
        grantToken: undefined,
      }),
    );
    expect(onVerifyStepUp).not.toHaveBeenCalled();
    // The PIN dialog never appeared.
    expect(screen.queryByLabelText("Personal PIN")).toBeNull();
  });

  it("shows NO optimistic refund status — the payment stays webhook-confirmed after a refund request", async () => {
    renderPayments();
    selectPayment();
    fireEvent.change(document.querySelector("#refund-amount") as HTMLInputElement, {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Issue refund" }));

    // The server-returned acceptance is shown…
    expect(await screen.findByTestId("refund-requested")).toBeDefined();
    // …but the payment's own status never optimistically flips to refunded.
    expect(screen.queryByTestId("payment-status-refunded")).toBeNull();
    expect(screen.getAllByTestId("payment-status-succeeded").length).toBeGreaterThan(0);
  });

  it("rejects a refund amount above the payment total client-side (the server also re-verifies)", () => {
    const { onRefund } = renderPayments();
    selectPayment();
    fireEvent.change(document.querySelector("#refund-amount") as HTMLInputElement, {
      target: { value: "250" },
    });
    const button = screen.getByRole("button", { name: /refund/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRefund).not.toHaveBeenCalled();
  });

  it("renders dunning rows with their stage and grace expiry, link disabled as a placeholder", () => {
    renderPayments();
    fireEvent.click(screen.getByRole("tab", { name: "Dunning queue" }));
    expect(screen.getByText("Dana Pastdue")).toBeDefined();
    const stage = screen.getByTestId(`dunning-stage-${DUNNING_ROW.subscription_id}`);
    expect(stage.textContent).toContain("Grace started");
    expect(stage.textContent?.toLowerCase()).toContain("grace ends");
    const copy = screen.getByRole("button", { name: "Copy payment-update link" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
  });
});
