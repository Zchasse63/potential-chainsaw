import { useAuth } from "../auth/auth-context.jsx";
import { StaffScreen } from "../screens/staff-screen.jsx";

export function StaffRoute() {
  const auth = useAuth();
  return <StaffScreen accessToken={auth.accessToken ?? undefined} />;
}
