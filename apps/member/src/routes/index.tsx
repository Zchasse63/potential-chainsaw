import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createMemberApiClient } from "@kelo/member-core";
import { SchedulePage, type ScheduleLoadResult } from "../components/schedule-page.jsx";

/**
 * `/` — the PUBLIC session list (plan-member-app §8: the landing IS the SSR
 * schedule, anonymous, indexable). Read-only by design this unit: the
 * Identify → Waiver → Review & pay → Confirmed booking flow lands in W8-2/3.
 *
 * Thin-server rule (plan §2): the server function below does exactly two
 * things — read public env and fetch from the Hono API. No business logic,
 * no privileged secrets, no DB access, no Supabase client. process.env is
 * reachable INSIDE the server fn only; only the JSON-safe ScheduleLoadResult
 * is serialized to the client.
 */

/** Public read window: now → now + 14 days (within the API's 45-day bound). */
const WINDOW_DAYS = 14;

const getSchedule = createServerFn({ method: "GET" }).handler(
  async (): Promise<ScheduleLoadResult> => {
    // SERVER-ONLY env (plan §5): KELO_API_ORIGIN and KELO_TENANT_ID are PUBLIC
    // values (no Supabase material exists on this site), but even they never
    // cross into the client bundle — only the typed result below does.
    const origin = process.env.KELO_API_ORIGIN;
    const tenant = process.env.KELO_TENANT_ID;
    if (origin === undefined || tenant === undefined) {
      return {
        ok: false,
        error: {
          kind: "config",
          message: "The studio's booking API isn't configured on this deployment yet.",
        },
      };
    }

    const now = new Date();
    const result = await createMemberApiClient().fetchSchedule({
      origin,
      tenant,
      from: now.toISOString(),
      to: new Date(now.getTime() + WINDOW_DAYS * 86_400_000).toISOString(),
    });

    if (!result.ok) {
      return {
        ok: false,
        // Plain JSON — Error instances don't survive loader serialization.
        error: {
          kind: result.error.kind,
          message: result.error.message,
          ...(result.error.status !== undefined ? { status: result.error.status } : {}),
        },
      };
    }

    return {
      ok: true,
      envelope: { data: result.sessions, meta: result.meta },
      // Display tz for the studio (KELO_TENANT_TIMEZONE, e.g. Europe/Dublin).
      // Formatted with an EXPLICIT zone so SSR and hydration render identical
      // strings; UTC is the honest fallback when unset, not a guess.
      timeZone: process.env.KELO_TENANT_TIMEZONE ?? "UTC",
    };
  },
);

export const Route = createFileRoute("/")({
  loader: () => getSchedule(),
  component: ScheduleRoute,
});

function ScheduleRoute() {
  const result = Route.useLoaderData();
  const router = useRouter();
  return <SchedulePage result={result} onRefresh={() => void router.invalidate()} />;
}
