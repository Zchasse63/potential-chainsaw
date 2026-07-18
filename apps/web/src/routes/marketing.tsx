import { useAuth } from "../auth/auth-context.jsx";
import { MarketingScreen } from "../screens/marketing-screen.jsx";

export function MarketingRoute() {
  const auth = useAuth();
  return <MarketingScreen accessToken={auth.accessToken ?? undefined} />;
}
