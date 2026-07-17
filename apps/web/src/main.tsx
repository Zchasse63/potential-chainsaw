import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AuthProvider } from "./auth/auth-context.jsx";
import { Button } from "./components/button.jsx";
import { SENTRY_DSN } from "./lib/env.js";
import { initTelemetry } from "./lib/telemetry.js";
import { router } from "./router.jsx";
import "./styles/tokens.css";
import "./styles/globals.css";

initTelemetry(SENTRY_DSN);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A trust surface never serves silently-cached data as fresh: staleness
      // is a designed state, labeled by the envelope, not hidden by defaults.
      refetchOnWindowFocus: true,
    },
  },
});

function AppCrashed() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-app px-6">
      <div
        role="alert"
        className="max-w-md rounded-3 border border-danger-border bg-danger-tint p-6"
      >
        <p className="text-body font-medium text-danger-on-tint">The app shell crashed</p>
        <p className="mt-1 text-body text-danger-on-tint">
          No data was changed. The failure was reported to engineering — reload to try again.
        </p>
        <Button variant="secondary" className="mt-4" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("index.html is missing the #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<AppCrashed />}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
