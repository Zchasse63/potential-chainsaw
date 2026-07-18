import type { Hono } from "hono";
import { z } from "zod";
import {
  narrateAskRows,
  selectAskCatalog,
  type AskAiOptions,
} from "../ask/narrate.js";
import {
  executeAskCatalog,
  fetchAskCatalog,
  fetchAskMetricDefinitions,
  insertAskMiss,
  resolveAskPersonNames,
  type AskCatalogRow,
} from "../data-ask.js";
import { fetchStudioTimezone, studioBusinessDate } from "../data-briefing.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIdempotencyKey } from "../middleware/mutation.js";
import { resolveTenant } from "../middleware/tenant.js";
import { authOf, tenantOf, type AppEnv, type ResolvedDeps } from "../types.js";
import { parseBody } from "../validate.js";

const questionSchema = z.object({ question: z.string().trim().min(1).max(2000) }).strict();
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "expected a valid calendar date");

export const ASK_MISS_MESSAGE =
  "I can't answer that yet — here's what I can answer from the approved catalog.";

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function defaultValue(value: unknown, today: string): unknown {
  if (value === "$today") return today;
  // Inclusive start: today plus the preceding 29 studio-local days.
  if (value === "$30_days_ago") return shiftDate(today, -29);
  return value;
}

/** Build the validator from registry data; model output is never trusted. */
export function catalogParamsSchema(entry: AskCatalogRow, today: string): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, definition] of Object.entries(entry.params_schema)) {
    let field: z.ZodTypeAny =
      definition.type === "date"
        ? calendarDateSchema
        : definition.type === "int"
          ? z.number().int().min(1).max(100)
          : z.string().trim().min(1).max(200);
    if (definition.default !== undefined) field = field.default(defaultValue(definition.default, today));
    else if (definition.required !== true) field = field.optional();
    shape[name] = field;
  }
  return z.object(shape).strict().superRefine((params, ctx) => {
    const from = params["from"];
    const to = params["to"];
    if (typeof from === "string" && typeof to === "string" && from > to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
    }
  });
}

function publicCatalog(catalog: readonly AskCatalogRow[]) {
  return catalog.map(({ key, version, title, description, params_schema, metric_keys }) => ({
    key,
    version,
    title,
    description,
    params_schema,
    metric_keys,
  }));
}

export function registerAskRoutes(
  app: Hono<AppEnv>,
  deps: ResolvedDeps,
  aiOptions: AskAiOptions = {},
): void {
  app.get("/ask/catalog", requireAuth(deps), resolveTenant, async (c) => {
    const { userClient } = authOf(c);
    const catalog = await fetchAskCatalog(userClient);
    return c.json(c.var.ok({ catalog: publicCatalog(catalog) }, { source: "native", definitionVersion: "1" }), 200);
  });

  app.post(
    "/ask",
    requireAuth(deps),
    resolveTenant,
    requireIdempotencyKey,
    async (c) => {
      const { question } = await parseBody(c, questionSchema);
      const { userClient, userId } = authOf(c);
      const { tenantId } = tenantOf(c);
      const catalog = await fetchAskCatalog(userClient);
      const selection = await selectAskCatalog(question, publicCatalog(catalog), aiOptions);
      const selected = selection.miss ? undefined : catalog.find((entry) => entry.key === selection.key);

      // Unknown model keys are misses, never executable fall-throughs.
      if (selection.miss || selected === undefined) {
        await insertAskMiss(userClient, { tenant_id: tenantId, question, asked_by: userId });
        return c.json(
          c.var.ok(
            {
              miss: true,
              answer: { narration: ASK_MISS_MESSAGE, rows: [], citation: null },
              catalog: publicCatalog(catalog),
            },
            { source: "native", definitionVersion: "1" },
          ),
          200,
        );
      }

      const timezone = await fetchStudioTimezone(userClient, tenantId);
      const params = catalogParamsSchema(selected, studioBusinessDate(timezone)).parse(selection.params);
      const rawRows = await executeAskCatalog(userClient, tenantId, selected.key, params);
      const [rows, definitions] = await Promise.all([
        resolveAskPersonNames(userClient, tenantId, rawRows),
        fetchAskMetricDefinitions(userClient, selected.metric_keys),
      ]);
      const narration = await narrateAskRows(rows, definitions, aiOptions);
      return c.json(
        c.var.ok(
          {
            miss: false,
            answer: {
              narration: narration.narration,
              ...(narration.note === undefined ? {} : { note: narration.note }),
              rows,
              citation: {
                catalog_key: selected.key,
                version: selected.version,
                metric_keys: selected.metric_keys,
              },
            },
          },
          { source: "mixed", definitionVersion: String(selected.version) },
        ),
        200,
      );
    },
  );
}
