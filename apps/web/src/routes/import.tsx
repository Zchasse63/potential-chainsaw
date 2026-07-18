import { useAuth } from "../auth/auth-context.jsx";
import {
  useQuarantineDetailQuery,
  useQuarantineQuery,
  useReconciliationsQuery,
  useResolveQuarantineMutation,
} from "../lib/import.js";
import { ImportReviewScreen } from "../screens/import-screen.jsx";

/**
 * /import — the import-review queue (UX plan §3G). The API gates every
 * /import route to owner/manager; other roles get the honest 403 error
 * state from DataBoundary, never the data.
 */
export function ImportRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const quarantineQuery = useQuarantineQuery(accessToken);
  const reconciliationQuery = useReconciliationsQuery(accessToken);
  const resolver = useResolveQuarantineMutation(accessToken);
  return (
    <ImportReviewScreen
      quarantineQuery={quarantineQuery}
      reconciliationQuery={reconciliationQuery}
      resolver={resolver}
      detailQueryFor={(id) => useQuarantineDetailQuery(accessToken, id)}
    />
  );
}
