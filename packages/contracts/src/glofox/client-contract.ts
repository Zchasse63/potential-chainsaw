// sample: docs/glofox/samples/analytics.report.30d.json (the report this request produces)
import { z } from "zod";

/**
 * TYPE-LEVEL contract for the shared Glofox client — no network implementation
 * in phase 0. This file pins the two confirmed traps every later implementation
 * must honor (docs/glofox/README.md §3):
 *
 * TRAP 1 (vendor-acknowledged): older endpoints return HTTP 200 with
 * `success: false`. `glofoxFetch` MUST throw whenever a parsed body has
 * `success !== true` — callers never see a "successful failure", and Kelo never
 * represents errors as 200s (plan-final §3).
 *
 * TRAP 2 (reproduced live 2026-07-17): `POST /Analytics/report` WITHOUT
 * `namespace` returns HTTP 200 with `TransactionsList.details: []` — silently
 * empty, no error, no success flag. The request builder therefore makes
 * `namespace` REQUIRED at the type level, guarded by the @ts-expect-error
 * regression check at the bottom of this file.
 */

/** Request body for `POST /Analytics/report`. `start`/`end` are unix-second STRINGS. */
export const glofoxAnalyticsReportRequestSchema = z.object({
  branch_id: z.string().min(1),
  /** REQUIRED — non-optional at the type level (trap 2). */
  namespace: z.string().min(1),
  start: z.string().regex(/^\d+$/, "unix epoch seconds as a string"),
  end: z.string().regex(/^\d+$/, "unix epoch seconds as a string"),
  model: z.literal("TransactionsList"),
});
export type GlofoxAnalyticsReportRequest = z.infer<typeof glofoxAnalyticsReportRequestSchema>;

/**
 * The single fetch every Glofox call goes through (one shared client owns the
 * per-endpoint envelope strategy — README §2). Implementations MUST:
 * - send the three auth headers (`x-glofox-branch-id`, `x-api-key`,
 *   `x-glofox-api-token`) from env, never from code;
 * - throw on non-2xx HTTP status;
 * - throw when a parsed body carries `success !== true` (trap 1);
 * - Zod-parse at the boundary using the schemas in this package.
 */
export type GlofoxFetch = (
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
) => Promise<unknown>;

/**
 * Builds a valid Analytics report request. The input type's `namespace` is
 * non-optional (trap 2), so a correct request is unrepresentable-invalid.
 */
export type GlofoxAnalyticsReportRequestBuilder = (
  input: GlofoxAnalyticsReportRequest,
) => GlofoxAnalyticsReportRequest;

// Compile-time regression guard for trap 2 (README: "permanent regression test"):
// omitting `namespace` must NOT typecheck. If a future edit makes it optional,
// this @ts-expect-error itself fails the build.
// @ts-expect-error — `namespace` is REQUIRED; omitting it silently empties the report.
const _namespaceIsRequired: GlofoxAnalyticsReportRequest = {
  branch_id: "branch",
  start: "0",
  end: "1",
  model: "TransactionsList",
};
void _namespaceIsRequired;
