import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createMemberApiClient } from "@kelo/member-core";
import { EmptyState } from "@kelo/ui/react";
import { SignInScreen } from "../components/sign-in-screen.jsx";

/**
 * `/signin` — the Identify stage (plan-member-app §3H). Unlike `/` (a
 * server-rendered read), the OTP exchange is CLIENT-side and interactive:
 * start → code → verify, at which point the API sets the host-only session
 * cookie and we hand back to the schedule.
 *
 * Thin-server rule (plan §2): the server fn does exactly one thing — read the
 * PUBLIC tenant id and pass it to the client (it's a body field on every auth
 * call, not a secret). The client fetches SAME-ORIGIN (`origin: ""`), so the
 * `/api/*` rewrite (netlify.toml) proxies to the Hono API and the Set-Cookie
 * on verify is stored host-only — no Supabase material ever reaches this app.
 */

type SignInConfig = { ok: true; tenant: string } | { ok: false; message: string };

const getSignInConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<SignInConfig> => {
    const tenant = process.env.KELO_TENANT_ID;
    if (tenant === undefined || tenant === "") {
      return {
        ok: false,
        message: "The studio's booking system isn't configured on this deployment yet.",
      };
    }
    return { ok: true, tenant };
  },
);

export const Route = createFileRoute("/signin")({
  loader: () => getSignInConfig(),
  component: SignInRoute,
});

function SignInRoute() {
  const config = Route.useLoaderData();
  const router = useRouter();

  if (!config.ok) {
    return (
      <main className="mx-auto max-w-sm p-4">
        <EmptyState title="Sign-in unavailable" body={config.message} />
      </main>
    );
  }

  // The client is stateless — the session lives in the cookie the API sets on
  // verify. `origin: ""` targets the same-origin `/api/*` proxy so that cookie
  // is first-party. platform "web" ⇒ cookie only (no token echoed in body).
  const client = createMemberApiClient();
  return (
    <main>
      <SignInScreen
        onStart={async (contact) => {
          const res = await client.startAuth({ origin: "", tenant: config.tenant, contact });
          return { ok: res.ok };
        }}
        onVerify={async (contact, code) => {
          const res = await client.verifyAuth({
            origin: "",
            tenant: config.tenant,
            contact,
            code,
            platform: "web",
          });
          return { ok: res.ok };
        }}
        onSignedIn={() => void router.navigate({ to: "/account" })}
      />
    </main>
  );
}
