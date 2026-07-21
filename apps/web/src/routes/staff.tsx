import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.jsx";
import { StaffScreen } from "../screens/staff-screen.jsx";
import type { StepUpGrantResult } from "../components/step-up-prompt.jsx";
import { fetchEnvelope, postEnvelope } from "../lib/api.js";

export function StaffRoute() {
  const auth = useAuth();
  const accessToken = auth.accessToken ?? undefined;
  const queryClient = useQueryClient();

  const staffQuery = useQuery({
    queryKey: ["staff"],
    enabled: accessToken !== undefined,
    queryFn: () => fetchEnvelope("/staff", accessToken as string),
    retry: false,
  });

  return (
    <StaffScreen
      staffQuery={staffQuery}
      onSetPin={async (userId, pin) => {
        // The raw PIN is the POST body; only the (opaque) user id is in the path.
        await postEnvelope(`/staff/${encodeURIComponent(userId)}/pin`, accessToken as string, {
          pin,
        });
        await queryClient.invalidateQueries({ queryKey: ["staff"] });
      }}
      onVerifyPin={async (pin, context): Promise<StepUpGrantResult> => {
        const response = (await postEnvelope("/staff/step-up/verify", accessToken as string, {
          pin,
          context,
        })) as { data?: { grant_token?: string; grant?: { expires_at?: string } } };
        const token = response.data?.grant_token;
        const expiresAt = response.data?.grant?.expires_at;
        if (token === undefined || expiresAt === undefined) {
          throw new Error("step-up response was missing its signed grant");
        }
        return { grantToken: token, expiresAt };
      }}
    />
  );
}
