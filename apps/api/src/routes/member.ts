import type { Hono } from "hono";
import { memberScheduleQuery, memberScheduleResponse } from "@kelo/contracts";
import { createServiceRoleClient, type KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "../errors.js";
import type { AppEnv } from "../types.js";
import { parseQuery } from "../validate.js";

interface QueryError {
  message: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

interface RpcClient {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<QueryResult>;
}

export interface MemberDeps {
  /**
   * Anonymous-schedule client factory. There is no member session yet (unit
   * 8.1c ships ONLY the public schedule — auth/account/bookings are later
   * units), so the read uses the service-role client exactly like the webhook
   * surface. This is safe because the client never leaves the server and the
   * boundary is doubled: public.member_schedule (migration 0043) is SECURITY
   * DEFINER with a locked 8-column allowlist return shape hard-filtered to
   * the caller-pinned tenant's PUBLISHED sessions, and the route's Zod
   * response parse strips anything beyond the allowlist regardless. Tests
   * inject a no-network fake.
   */
  createMemberClient?: () => KeloSupabaseClient;
}

/**
 * The member route group (plan-member-app §3.5) — mounted OUTSIDE the operator
 * auth chain, next to the webhook mount. ANONYMOUS: no auth or tenant
 * middleware at all; the tenant arrives as a PUBLIC uuid query param (pinned
 * client-side by KELO_TENANT_ID — the member client ships no Supabase
 * material, plan §5).
 */
export function registerMemberRoutes(app: Hono<AppEnv>, deps: MemberDeps = {}): void {
  const client = () => deps.createMemberClient?.() ?? createServiceRoleClient();

  app.get("/member/schedule", async (c) => {
    const { tenant, from, to } = parseQuery(c, memberScheduleQuery);
    const { data, error } = await (client() as unknown as RpcClient).rpc("member_schedule", {
      p_tenant: tenant,
      p_from: from,
      p_to: to,
    });
    if (error !== null) {
      // Structured 500, generic message; the DB detail goes to Sentry via the
      // app onError handler, never to an anonymous caller.
      throw new ApiError(500, "schedule_read_failed", "schedule read failed");
    }
    // Timestamps parse at the Zod boundary; unknown keys are stripped, so the
    // response can carry ONLY the public allowlist — zero attendee data.
    const sessions = memberScheduleResponse.parse(data ?? []);
    return c.json(
      c.var.ok(sessions, { source: "native", definitionVersion: "member-schedule:v1" }),
      200,
    );
  });
}
