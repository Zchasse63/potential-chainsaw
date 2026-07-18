import { useAuth } from "../auth/auth-context.jsx";
import { useBriefingArchiveQuery } from "../lib/intelligence.js";
import { BriefingArchiveScreen } from "../screens/briefing-archive-screen.jsx";

export function BriefingArchiveRoute() {
  const auth = useAuth();
  return <BriefingArchiveScreen query={useBriefingArchiveQuery(auth.accessToken ?? undefined)} />;
}
