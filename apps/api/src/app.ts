import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError, errorBody, type ErrorStatus } from "./errors.js";
import { resolveDeps } from "./middleware/auth.js";
import {
  correlationId as correlationIdMiddleware,
  CORRELATION_HEADER,
} from "./middleware/correlation-id.js";
import { envelopeMiddleware } from "./middleware/envelope.js";
import { captureError, sentry } from "./middleware/sentry.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerBookingRoutes } from "./routes/bookings.js";
import { registerBriefingRoutes } from "./routes/briefing.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerImportRoutes } from "./routes/import.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerScheduleRoutes } from "./routes/schedule.js";
import { registerSchedulingAuthoringRoutes } from "./routes/scheduling-authoring.js";
import { registerStaffRoutes } from "./routes/staff.js";
import { registerMarketingRoutes } from "./routes/marketing.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerPeopleRoutes } from "./routes/people.js";
import { registerPosRoutes } from "./routes/pos.js";
import { registerPosCatalogRoutes } from "./routes/pos-catalog.js";
import { registerReadinessRoutes } from "./routes/readiness.js";
import { registerRetailRoutes } from "./routes/retail.js";
import { registerWaitlistRoutes } from "./routes/waitlist.js";
import { registerWaiverRoutes } from "./routes/waivers.js";
import { registerTenantRoutes } from "./routes/tenant.js";
import { registerWebhookRoutes, type WebhookDeps } from "./routes/webhooks.js";
import type { AppDeps, AppEnv } from "./types.js";

export interface StaffDeps {
  /** Server-only credential reader; tests inject a no-network fake. */
  createStepUpClient?: () => KeloSupabaseClient;
}

export interface BillingDeps {
  /**
   * Service-role client factory the persisted idempotency middleware uses to
   * reserve/store/release the idempotency_keys row on the money routes
   * (member-SELECT RLS; the service role writes). Tests inject a no-network fake.
   */
  createBillingClient?: () => KeloSupabaseClient;
}

/**
 * The ONE Hono API app (plan-final §1/§3), base path /api/v1.
 *
 * Middleware order: correlationId → sentry → envelope helper; then per-route
 * requireAuth → resolveTenant (SOLE source of tenant id) → requireRole →
 * requireIdempotencyKey on mutations.
 */
export function createApp(deps: AppDeps & WebhookDeps & StaffDeps & BillingDeps = {}): Hono<AppEnv> {
  const resolved = resolveDeps(deps);
  const app = new Hono<AppEnv>().basePath("/api/v1");

  app.use("*", correlationIdMiddleware);
  app.use("*", sentry);
  app.use("*", envelopeMiddleware);

  // Structured errors, NEVER 200-with-failure (contracts ErrorResponse):
  //   Zod request-validation error → 422 (issues in details)
  //   AuthError → 401 · TenantError → 403/400 · ApiError → its status
  //   anything else → 500 with a GENERIC message; full detail to Sentry only
  app.onError((err, c) => {
    const correlationId = c.var.correlationId ?? crypto.randomUUID();
    const headers = { [CORRELATION_HEADER]: correlationId };

    if (err instanceof ZodError) {
      return c.json(
        errorBody("validation_error", "request validation failed", correlationId, err.issues),
        422,
        headers,
      );
    }
    if (err instanceof ApiError) {
      if (err.status >= 500) {
        captureError(err, correlationId);
      }
      return c.json(
        errorBody(err.code, err.message, correlationId, err.details),
        err.status,
        headers,
      );
    }
    if (err instanceof HTTPException) {
      return c.json(
        errorBody("http_error", err.message, correlationId),
        err.status as ErrorStatus,
        headers,
      );
    }
    captureError(err, correlationId);
    return c.json(
      errorBody("internal_error", "internal server error", correlationId),
      500,
      headers,
    );
  });

  app.notFound((c) => {
    const correlationId = c.var.correlationId ?? crypto.randomUUID();
    return c.json(errorBody("not_found", "route not found", correlationId), 404, {
      [CORRELATION_HEADER]: correlationId,
    });
  });

  registerHealthRoutes(app, resolved);
  // Public provider callbacks are mounted outside every auth/tenant middleware
  // chain. Their verified raw-body signature is the authentication boundary.
  registerWebhookRoutes(app, deps);
  registerAuthRoutes(app, resolved);
  registerTenantRoutes(app, resolved);
  registerImportRoutes(app, resolved);
  registerReportRoutes(app, resolved);
  registerBriefingRoutes(app, resolved);
  registerAskRoutes(app, resolved, { fetchImpl: deps.anthropicFetch, env: deps.env });
  registerScheduleRoutes(app, resolved);
  registerSchedulingAuthoringRoutes(app, resolved);
  registerMarketingRoutes(app, resolved);
  registerPeopleRoutes(app, resolved);
  registerRetailRoutes(app, resolved);
  registerPosCatalogRoutes(app, resolved);
  registerWaiverRoutes(app, resolved);
  registerStaffRoutes(app, resolved, deps.env, deps.createStepUpClient);
  registerPaymentRoutes(app, resolved, deps.env, deps.createBillingClient);
  registerPosRoutes(app, resolved, deps.createBillingClient);
  registerBookingRoutes(app, resolved, deps.createBillingClient);
  registerWaitlistRoutes(app, resolved, deps.createBillingClient);
  registerReadinessRoutes(app, resolved);

  return app;
}

/** Default app (production deps from env) — used by server.ts; Netlify builds its own via createApp(). */
const app = createApp();
export default app;
