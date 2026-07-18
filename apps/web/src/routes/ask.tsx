import { useAuth } from "../auth/auth-context.jsx";
import { useAskCatalogQuery, useAskMutation } from "../lib/intelligence.js";
import { AskScreen } from "../screens/ask-screen.jsx";

export function AskRoute() {
  const auth = useAuth();
  const token = auth.accessToken ?? undefined;
  return <AskScreen catalogQuery={useAskCatalogQuery(token)} ask={useAskMutation(token)} />;
}
