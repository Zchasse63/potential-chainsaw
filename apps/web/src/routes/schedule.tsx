import { useAuth } from "../auth/auth-context.jsx";
import { useScheduleHeatmapQuery } from "../lib/intelligence.js";
import {
  useCanAuthor,
  useSchedulingActions,
  useSchedulingOverviewQuery,
} from "../lib/scheduling.js";
import { ScheduleScreen } from "../screens/schedule-screen.jsx";

export function ScheduleRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const heatmapQuery = useScheduleHeatmapQuery(accessToken);
  const { canAuthor } = useCanAuthor(accessToken);
  const overviewQuery = useSchedulingOverviewQuery(accessToken, canAuthor);
  const actions = useSchedulingActions(accessToken);
  return (
    <ScheduleScreen
      query={heatmapQuery}
      canAuthor={canAuthor}
      overviewQuery={overviewQuery}
      actions={actions}
    />
  );
}
