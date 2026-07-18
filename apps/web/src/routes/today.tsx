import { useAuth } from "../auth/auth-context.jsx";
import { ApiRequestError } from "../lib/api.js";
import { useHealthQuery } from "../lib/health.js";
import {
  useBriefingFeedbackMutation,
  useBriefingQuery,
  useDefinitionsQuery,
  useFocusDismissMutation,
  useFocusQueueQuery,
  useKpiQuery,
  useYesterdayBriefingQuery,
} from "../lib/today.js";
import { TodayScreen } from "../screens/today-screen.jsx";

/** / — the owner's studio-local morning review. */
export function TodayRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const briefingQuery = useBriefingQuery(accessToken);
  const needsFallback =
    briefingQuery.status === "error" &&
    briefingQuery.error instanceof ApiRequestError &&
    briefingQuery.error.status === 404;
  const yesterdayQuery = useYesterdayBriefingQuery(accessToken, needsFallback);
  const kpiQuery = useKpiQuery(accessToken);
  const definitionsQuery = useDefinitionsQuery(accessToken);
  const focusQuery = useFocusQueueQuery(accessToken);
  const healthQuery = useHealthQuery(accessToken);
  const feedback = useBriefingFeedbackMutation(accessToken);
  const focusMutation = useFocusDismissMutation(accessToken);

  return (
    <TodayScreen
      briefingQuery={briefingQuery}
      yesterdayQuery={yesterdayQuery}
      kpiQuery={kpiQuery}
      definitionsQuery={definitionsQuery}
      focusQuery={focusQuery}
      healthQuery={healthQuery}
      feedback={feedback}
      focusMutation={focusMutation}
    />
  );
}
