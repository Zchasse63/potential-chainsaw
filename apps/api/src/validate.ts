import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors.js";
import type { AppEnv } from "./types.js";

/**
 * Parse + validate a JSON request body. Malformed JSON → 400; a Zod mismatch
 * throws ZodError, which the error handler maps to 422 with issues in details
 * (plan-final §3: Zod-validated at every boundary).
 */
export async function parseBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "request body must be valid JSON");
  }
  return schema.parse(raw);
}

/** Parse + validate route params (e.g. `:id` must be a uuid) → 422 on mismatch. */
export function parseParams<S extends z.ZodTypeAny>(c: Context<AppEnv>, schema: S): z.output<S> {
  return schema.parse(c.req.param());
}
