import * as Sentry from "@sentry/react";

/**
 * Telemetry wrapper (plan-final §1 observability). Init is a NO-OP without a
 * DSN (BLOCKERS P0-1) — the app runs fine, violations still hit the console.
 * reportError is the single funnel for monitored violations like a
 * provenance-less API payload (UX plan §4: "a monitored error, not a
 * guideline").
 */
let initialized = false;

export function initTelemetry(dsn: string | undefined): void {
  if (dsn === undefined || dsn === "") {
    return;
  }
  Sentry.init({
    dsn,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 1.0,
  });
  initialized = true;
}

export function reportError(error: unknown, context?: Record<string, unknown>): void {
  // Loud in every environment so a provenance violation can never pass
  // silently; captured by Sentry only once a DSN configured the SDK.
  console.error("[kelo] monitored violation", error, context ?? {});
  if (!initialized) {
    return;
  }
  Sentry.captureException(error, context === undefined ? undefined : { extra: context });
}
