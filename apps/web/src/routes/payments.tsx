import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.jsx";
import { fetchEnvelope } from "../lib/api.js";
import { inspectEnvelope } from "../lib/envelope.js";
import {
  requestRefund,
  verifyStepUp,
  type PaymentsList,
} from "../lib/payments.js";
import { PaymentsScreen } from "../screens/payments-screen.jsx";

const DEFAULT_REFUND_THRESHOLD_CENTS = 10_000;

/** /payments — owner/manager money surface: charges, the refund ceremony, and
 *  the dunning queue. The refund step-up threshold rides the /payments envelope
 *  so the ceremony gate needs no extra round trip. */
export function PaymentsRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const queryClient = useQueryClient();

  const paymentsQuery = useQuery({
    queryKey: ["payments", "list"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/payments", accessToken as string),
    retry: 1,
  });
  const dunningQuery = useQuery({
    queryKey: ["payments", "dunning"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/payments/dunning", accessToken as string),
    retry: 1,
  });

  // The threshold is read from the confirmed envelope; until it lands the
  // ceremony errs safe on the server default (the server re-verifies anyway).
  const inspection =
    paymentsQuery.status === "success"
      ? inspectEnvelope<PaymentsList>(paymentsQuery.data)
      : null;
  const refundThresholdCents =
    inspection !== null && inspection.ok
      ? inspection.data.refund_step_up_cents
      : DEFAULT_REFUND_THRESHOLD_CENTS;

  return (
    <PaymentsScreen
      paymentsQuery={paymentsQuery}
      dunningQuery={dunningQuery}
      refundThresholdCents={refundThresholdCents}
      onRefund={async (paymentId, input, idempotencyKey) => {
        const accepted = await requestRefund(
          accessToken as string,
          paymentId,
          {
            amountCents: input.amountCents,
            reason: input.reason,
            grantToken: input.grantToken,
          },
          idempotencyKey,
        );
        // Re-read so the confirmed status (flipped by the webhook, never here)
        // is reflected; no optimistic mutation of the list.
        await queryClient.invalidateQueries({ queryKey: ["payments", "list"] });
        return accepted;
      }}
      onVerifyStepUp={(pin, context) => verifyStepUp(accessToken as string, pin, context)}
    />
  );
}
