import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createMemberApiClient, fetchAccount } from "@kelo/member-core";
import { EmptyState } from "@kelo/ui/react";
import { AccountScreen } from "../components/account-screen.jsx";
import { toAccountView, type SessionMeta } from "../lib/account-view.js";

/**
 * `/account` — the read-only member account area (plan-member-app §6:
 * bookings, balance, waiver status). Session-gated: the account read is
 * client-side (the host-only cookie scopes it to its own person); a 401 hands
 * off to Identify.
 *
 * The account payload carries NO session times/names (it exposes no other
 * attendee's session data by design), so the SSR loader pre-fetches the PUBLIC
 * schedule and the client joins the member's bookings against it. Thin-server
 * rule (plan §2): the loader only reads public env + calls the public endpoint.
 */

// The member schedule endpoint bounds lookups to 45 days; use the full window
// so a member's upcoming bookings resolve their session name/time (the server
// already bounds the account itself to upcoming sessions).
const WINDOW_DAYS = 45;

/** An IANA zone Intl can actually format; a bad env value falls back to UTC
 * instead of throwing a RangeError inside the client formatter. */
function safeTimeZone(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

type ScheduleLookup =
  | { ok: true; sessionMeta: Record<string, SessionMeta>; timeZone: string }
  | { ok: false; message: string };

const getScheduleLookup = createServerFn({ method: "GET" }).handler(
  async (): Promise<ScheduleLookup> => {
    const origin = process.env.KELO_API_ORIGIN;
    const tenant = process.env.KELO_TENANT_ID;
    if (origin === undefined || tenant === undefined) {
      return { ok: false, message: "The studio's booking system isn't configured yet." };
    }

    const now = new Date();
    const result = await createMemberApiClient().fetchSchedule({
      origin,
      tenant,
      from: now.toISOString(),
      to: new Date(now.getTime() + WINDOW_DAYS * 86_400_000).toISOString(),
    });
    // A schedule miss is non-fatal here — the account still renders; bookings
    // whose session is outside the window just show "time to be confirmed".
    const sessionMeta: Record<string, SessionMeta> = {};
    if (result.ok) {
      for (const s of result.sessions) {
        sessionMeta[s.session_id] = {
          offering_name: s.offering_name,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
        };
      }
    }
    return { ok: true, sessionMeta, timeZone: safeTimeZone(process.env.KELO_TENANT_TIMEZONE) };
  },
);

export const Route = createFileRoute("/account")({
  loader: () => getScheduleLookup(),
  component: AccountRoute,
});

function AccountRoute() {
  const lookup = Route.useLoaderData();
  const router = useRouter();

  if (!lookup.ok) {
    return (
      <main className="mx-auto max-w-sm p-4">
        <EmptyState title="Account unavailable" body={lookup.message} />
      </main>
    );
  }

  const { sessionMeta, timeZone } = lookup;
  return (
    <AccountScreen
      load={() =>
        fetchAccount({ origin: "" }).then((res) =>
          toAccountView(res, sessionMeta, (startsAt, endsAt) => formatWhen(startsAt, endsAt, timeZone)),
        )
      }
      onRequireSignIn={() => void router.navigate({ to: "/signin" })}
    />
  );
}

/** Compact, explicit-tz session range so SSR and hydration render identically. */
function formatWhen(startsAt: string, endsAt: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(startsAt));
  const t = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  return `${day} · ${t(startsAt)} – ${t(endsAt)}`;
}
