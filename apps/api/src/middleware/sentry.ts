import * as Sentry from "@sentry/node";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

let initialized = false;

/**
 * Initialise @sentry/node ONCE, only behind SENTRY_DSN (BLOCKERS P0-1: a
 * missing DSN must NEVER crash the app — this is a deliberate no-op until the
 * owner provides one).
 */
export function initSentry(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  const dsn = process.env.SENTRY_DSN;
  if (dsn === undefined || dsn === "") {
    return;
  }
  Sentry.init({ dsn, environment: process.env.NODE_ENV ?? "development" });
}

/**
 * Capture an unhandled error with the correlation id as a tag. No-op without
 * a DSN. Tags are passed at capture time (never `setTag` on the global scope —
 * that would leak across concurrent requests in a serverless isolate).
 */
export function captureError(err: unknown, correlationId: string): void {
  const dsn = process.env.SENTRY_DSN;
  if (dsn === undefined || dsn === "") {
    return;
  }
  Sentry.captureException(err, { tags: { correlation_id: correlationId } });
}

/**
 * Middleware #2 — sentry: ensures the SDK is initialised once per cold start.
 * The capture itself happens in app.onError, the single error choke point.
 */
export const sentry: MiddlewareHandler<AppEnv> = async (_c, next) => {
  initSentry();
  await next();
};
