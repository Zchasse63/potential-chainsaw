import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useAuth } from "./auth/auth-context.jsx";
import { SignInScreen } from "./auth/sign-in-screen.jsx";
import { AppShell } from "./components/app-shell.jsx";
import { Skeleton } from "./components/skeleton.jsx";
import { HealthRoute } from "./routes/health.jsx";

/**
 * Route tree (TanStack Router, code-based). Phase 0 has exactly one screen:
 * / is a redirect into /health, and every other feature's route lands with
 * its build phase (UX ruling 9 applies to routes as much as nav items).
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
  beforeLoad: () => {
    throw redirect({ to: "/health" });
  },
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, healthRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
