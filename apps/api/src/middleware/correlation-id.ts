import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

export const CORRELATION_HEADER = "x-correlation-id";

const MAX_INCOMING_LENGTH = 128;

/**
 * Middleware #1 — correlation id: read `x-correlation-id` or generate one;
 * stored on the context (envelope meta + error bodies + Sentry tag) and
 * echoed on every response header.
 */
export const correlationId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header(CORRELATION_HEADER);
  const id =
    incoming !== undefined && incoming.length > 0 && incoming.length <= MAX_INCOMING_LENGTH
      ? incoming
      : crypto.randomUUID();
  c.set("correlationId", id);
  c.header(CORRELATION_HEADER, id);
  await next();
};
