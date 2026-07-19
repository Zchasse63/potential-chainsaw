import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { useAuth } from "./auth/auth-context.jsx";
import { SignInScreen } from "./auth/sign-in-screen.jsx";
import { AppShell } from "./components/app-shell.jsx";
import { Skeleton } from "./components/skeleton.jsx";
import { HealthRoute } from "./routes/health.jsx";
import { AskRoute } from "./routes/ask.jsx";
import { BriefingArchiveRoute } from "./routes/briefing-archive.jsx";
import { ImportRoute } from "./routes/import.jsx";
import { TodayRoute } from "./routes/today.jsx";
import { ScheduleRoute } from "./routes/schedule.jsx";
import { MarketingRoute } from "./routes/marketing.jsx";
import { PaymentsRoute } from "./routes/payments.jsx";
import { PosRoute } from "./routes/pos.jsx";
import { RetailRoute } from "./routes/retail.jsx";
import { StaffRoute } from "./routes/staff.jsx";
import { WaiversRoute } from "./routes/waivers.jsx";

/**
 * Route tree (TanStack Router, code-based). A screen's route lands with its
 * build phase (UX ruling 9 applies to routes as much as nav items): Today is
 * the landing route; Import review and Health are the other shipped units.
 */

function RootComponent() {
  const auth = useAuth();
  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-app">
        <div role="status" aria-label="Loading" className="space-y-3">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
    );
  }
  if (auth.status !== "signed_in") {
    return <SignInScreen />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const rootRoute = createRootRoute({ component: RootComponent });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TodayRoute,
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthRoute,
});

const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import",
  component: ImportRoute,
});

const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ask",
  component: AskRoute,
});

const scheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedule",
  component: ScheduleRoute,
});

const marketingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/marketing",
  component: MarketingRoute,
});

const briefingArchiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/briefing/archive",
  component: BriefingArchiveRoute,
});

const retailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retail",
  component: RetailRoute,
});

const posRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pos",
  component: PosRoute,
});

const paymentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/payments",
  component: PaymentsRoute,
});

const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/staff",
  component: StaffRoute,
});

const waiversRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/waivers",
  component: WaiversRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  askRoute,
  scheduleRoute,
  marketingRoute,
  briefingArchiveRoute,
  healthRoute,
  importRoute,
  retailRoute,
  posRoute,
  paymentsRoute,
  staffRoute,
  waiversRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
