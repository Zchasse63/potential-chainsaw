import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.jsx";
import { verifyStepUp } from "../lib/payments.js";
import {
  acknowledgeGate,
  fetchAuthority,
  fetchReadiness,
  flipAuthority,
} from "../lib/setup.js";
import { useActorRole } from "../lib/waivers.js";
import { SetupScreen } from "../screens/setup-screen.jsx";

/**
 * /setup — launch readiness + the authority matrix (Phase 7 · unit 7.1c;
 * UX §G). A thin wiring layer, mirroring /payments: the reads open as
 * envelope queries (DataBoundary owns provenance-or-nothing) and the
 * mutations are threaded into the presentational screen.
 *
 * Both mutations re-read their region after a server-confirmed response —
 * there is NO optimistic state for an acknowledgement or an authority flip.
 */
export function SetupRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const role = useActorRole(accessToken);
  const queryClient = useQueryClient();

  const readinessQuery = useQuery({
    queryKey: ["readiness"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchReadiness(accessToken as string),
    retry: 1,
  });
  const authorityQuery = useQuery({
    queryKey: ["authority"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchAuthority(accessToken as string),
    retry: 1,
  });

  return (
    <SetupScreen
      role={role}
      readinessQuery={readinessQuery}
      authorityQuery={authorityQuery}
      onAcknowledge={async (gateKey, note, idempotencyKey) => {
        const ack = await acknowledgeGate(accessToken as string, gateKey, note, idempotencyKey);
        // Re-read so the acknowledged note attaches to the (still-warn) gate.
        await queryClient.invalidateQueries({ queryKey: ["readiness"] });
        return ack;
      }}
      onFlip={async (input, grantToken, idempotencyKey) => {
        const flip = await flipAuthority(accessToken as string, input, grantToken, idempotencyKey);
        // NO optimistic flip — the matrix re-reads from the server and only
        // the confirmed authority renders.
        await queryClient.invalidateQueries({ queryKey: ["authority"] });
        return flip;
      }}
      onVerifyStepUp={(pin, context) => verifyStepUp(accessToken as string, pin, context)}
    />
  );
}
