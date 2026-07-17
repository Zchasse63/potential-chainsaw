import { useAuth } from "../auth/auth-context.jsx";
import { useHealthQuery } from "../lib/health.js";
import { HealthScreen } from "../screens/health-screen.jsx";

/** /health — the landing route for phase 0. */
export function HealthRoute() {
  const auth = useAuth();
  const query = useHealthQuery(auth.accessToken ?? undefined);
  return <HealthScreen query={query} />;
}
