import { useAuth } from "../auth/auth-context.jsx";
import {
  useActivateWaiverVersionMutation,
  useActorRole,
  useCreateWaiverVersionMutation,
  useSignWaiverMutation,
  useWaiverStatusQuery,
  useWaiverVersionsQuery,
} from "../lib/waivers.js";
import { WaiversScreen } from "../screens/waivers-screen.jsx";

/**
 * /waivers — versioned waiver text + desk signature capture (Phase 4.3). The
 * rail item is owner/manager, but the screen is role-aware: front-desk staff
 * who reach it get desk capture only. The API is the real gate on every
 * mutation; the role here only decides which affordances to offer.
 */
export function WaiversRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const role = useActorRole(accessToken);
  const versionsQuery = useWaiverVersionsQuery(accessToken);
  const createVersion = useCreateWaiverVersionMutation(accessToken);
  const activateVersion = useActivateWaiverVersionMutation(accessToken);
  const signWaiver = useSignWaiverMutation(accessToken);
  return (
    <WaiversScreen
      role={role}
      versionsQuery={versionsQuery}
      createVersion={createVersion}
      activateVersion={activateVersion}
      statusQueryFor={(personId) => useWaiverStatusQuery(accessToken, personId)}
      signWaiver={signWaiver}
    />
  );
}
