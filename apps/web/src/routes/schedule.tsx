import { useAuth } from "../auth/auth-context.jsx";
import { useScheduleHeatmapQuery } from "../lib/intelligence.js";
import { ScheduleScreen } from "../screens/schedule-screen.jsx";

export function ScheduleRoute() {
  const auth = useAuth();
  return <ScheduleScreen query={useScheduleHeatmapQuery(auth.accessToken ?? undefined)} />;
}
