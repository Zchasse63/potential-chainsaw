import { z } from "zod";
import { envelope } from "@kelo/contracts";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, OkHelper } from "../types.js";

const anyEnvelope = envelope(z.unknown());

/**
 * Middleware #3 — installs `c.var.ok`, the ONLY way handlers build a success
 * body (invariant #3: every API response carries the freshness envelope).
 * `as_of` is stamped at response time; combined reports must pass the OLDEST
 * input's freshness via `opts.stale` instead.
 */
export const envelopeMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ok: OkHelper = (data, opts) => {
    const body = {
      data,
      meta: {
        as_of: new Date().toISOString(),
        source: opts?.source ?? ("native" as const),
        stale: opts?.stale ?? false,
        definition_version: opts?.definitionVersion ?? null,
        correlation_id: c.var.correlationId,
      },
    };
    // Dev-only: prove the envelope still matches the contracts schema. A
    // mismatch here is a SERVER defect → plain Error (→ 500 + Sentry), never
    // the request-validation 422.
    if (process.env.NODE_ENV !== "production") {
      const check = anyEnvelope.safeParse(body);
      if (!check.success) {
        throw new Error(`envelope failed @kelo/contracts validation: ${check.error.message}`);
      }
    }
    return body;
  };
  c.set("ok", ok);
  await next();
};
