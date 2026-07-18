import type { Hono } from "hono";
import { z } from "zod";
import { fetchScheduleHeatmap } from "../data-ask.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseQuery } from "../validate.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const heatmapQuerySchema = z.object({ from: date, to: date }).superRefine((value, ctx) => {
  if (value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
  }
  const start = new Date(`${value.from}T12:00:00.000Z`);
  const end = new Date(`${value.to}T12:00:00.000Z`);
  if ((end.valueOf() - start.valueOf()) / 86_400_000 > 30) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "heatmap window may not exceed 31 inclusive days" });
  }
});

export function registerScheduleRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.get("/schedule/heatmap", requireAuth(deps), resolveTenant, async (c) => {
    const { from, to } = parseQuery(c, heatmapQuerySchema);
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const cells = await fetchScheduleHeatmap(userClient, tenantId, from, to);
    return c.json(
      c.var.ok(
        {
          metric: "30-day fill",
          approximation: "Imported session capacity; turnover and readiness modeling are deferred to phase 4.",
          from,
          to,
          cells,
        },
        { source: "glofox", definitionVersion: "fill_rate:v1" },
      ),
      200,
    );
  });
}
