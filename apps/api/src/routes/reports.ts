import type { Hono } from "hono";
import { z } from "zod";
import {
  fetchAttendance,
  fetchCollectedRevenue,
  fetchCollectedRevenueTotals,
  fetchCreditLiability,
  fetchFailedPayments,
  fetchMemberCount,
  fetchMetricDefinitions,
  fetchMrr,
  fetchReportDates,
} from "../data-reports.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseQuery } from "../validate.js";

const DEFINITION_VERSION = 1 as const;
const REPORT_META = { source: "glofox" as const, definitionVersion: "v1" };

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "expected a valid calendar date");

const revenueQuerySchema = z
  .object({ from: calendarDateSchema, to: calendarDateSchema })
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be on or after from",
      });
    }
  });

function definition(key: string) {
  return { key, version: DEFINITION_VERSION };
}

function metric<T>(value: T, key: string) {
  return { value, definition: definition(key) };
}

export function registerReportRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // All active tenant roles may read reports. The user-scoped client invokes
  // SECURITY INVOKER functions, preserving membership-based RLS end to end.
  app.get("/reports/kpis", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const dates = await fetchReportDates(userClient, tenantId);

    const [memberCount, mrr, collected7d, collected30d, failed, liability, attendance] =
      await Promise.all([
        fetchMemberCount(userClient, tenantId),
        fetchMrr(userClient, tenantId),
        fetchCollectedRevenueTotals(userClient, tenantId, dates.from_7d, dates.today),
        fetchCollectedRevenueTotals(userClient, tenantId, dates.from_30d, dates.today),
        fetchFailedPayments(userClient, tenantId, 30),
        fetchCreditLiability(userClient, tenantId),
        fetchAttendance(userClient, tenantId, dates.from_30d, dates.today),
      ]);

    return c.json(
      c.var.ok(
        {
          member_count: metric(memberCount, "member_count"),
          mrr: {
            ...metric(mrr, "mrr"),
            related_definitions: [definition("partner_invoiced_members")],
          },
          collected_7d: metric(collected7d, "collected_revenue"),
          collected_30d: metric(collected30d, "collected_revenue"),
          failed_payments: metric(failed, "failed_payments_outstanding"),
          credit_liability: metric(liability, "credit_liability"),
          attendance_30d: {
            ...metric(attendance, "attendance_rate"),
            related_definitions: [definition("no_show_rate")],
          },
        },
        REPORT_META,
      ),
      200,
    );
  });

  app.get("/reports/revenue", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const { tenantId } = tenantOf(c);
    const { from, to } = parseQuery(c, revenueQuerySchema);
    const [daily, totals] = await Promise.all([
      fetchCollectedRevenue(userClient, tenantId, from, to),
      fetchCollectedRevenueTotals(userClient, tenantId, from, to),
    ]);

    return c.json(
      c.var.ok({ daily, totals, definition: definition("collected_revenue") }, REPORT_META),
      200,
    );
  });

  app.get("/reports/definitions", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const rows = await fetchMetricDefinitions(userClient);
    return c.json(c.var.ok({ definitions: rows }, REPORT_META), 200);
  });
}
