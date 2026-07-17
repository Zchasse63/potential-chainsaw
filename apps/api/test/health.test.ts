import { describe, expect, it } from "vitest";
import { envelope, errorResponseSchema } from "@kelo/contracts";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID } from "./fakes.js";

const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ALERT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function buildApp() {
  const now = Date.now();
  const fake = fakeUserClient({
    tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: "owner" }] }),
    sync_state: () => ({
      data: [
        {
          entity: "members",
          health_state: "healthy",
          last_run_at: new Date(now - 30_000).toISOString(),
          last_success_at: new Date(now - 30_000).toISOString(),
          committed_watermark: new Date(now - 30_000).toISOString(),
          consecutive_empty: 0,
        },
        {
          entity: "bookings",
          health_state: "stale",
          last_run_at: new Date(now - 300 * 60_000).toISOString(),
          last_success_at: new Date(now - 300 * 60_000).toISOString(),
          committed_watermark: null,
          consecutive_empty: 2,
        },
      ],
    }),
    sync_runs: () => ({
      data: [
        {
          id: RUN_ID,
          entity: "members",
          status: "success",
          started_at: new Date(now - 60_000).toISOString(),
          finished_at: new Date(now - 30_000).toISOString(),
          rows_fetched: 10,
          rows_upserted: 10,
          rows_quarantined: 0,
          window_start: null,
          window_end: null,
          error: null,
        },
      ],
    }),
    alerts: () => ({
      data: [
        {
          id: ALERT_ID,
          kind: "import_failed",
          severity: "critical",
          title: "members import failed",
          body: null,
          status: "open",
          created_at: new Date(now - 5_000).toISOString(),
        },
      ],
    }),
  });
  const app = createApp({
    verifyAccessToken: async () => ({ userId: USER_ID }),
    createUserClient: () => fake.client,
  });
  return { app, fake };
}

const authed = { headers: { authorization: "Bearer good-token" } };

describe("GET /api/v1/health", () => {
  it("rejects an unauthenticated request with a structured 401 — never 200", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(401);
    const body = (await res.json()) as unknown;
    expect(() => errorResponseSchema.parse(body)).not.toThrow();
    const parsed = errorResponseSchema.parse(body);
    expect(parsed.error.code).toBe("unauthorized");
    expect(parsed.error.correlation_id).toBe(res.headers.get("x-correlation-id"));
  });

  it("returns freshness buckets, runs, open alerts and the authority matrix, enveloped", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/v1/health", authed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        freshness: Array<{ entity: string; bucket: string; minutes_stale: number | null }>;
        sync_runs: unknown[];
        alerts: unknown[];
        authority: Array<{ capability: string; state: string }>;
      };
      meta: unknown;
    };

    // Envelope validates against the contracts schema (invariant #3).
    expect(() => envelope(z.unknown()).parse(body)).not.toThrow();

    const buckets = Object.fromEntries(body.data.freshness.map((f) => [f.entity, f.bucket]));
    expect(buckets["members"]).toBe("live"); // ~30s old
    expect(buckets["bookings"]).toBe("critical"); // ~300m old (≥ 240m)

    // Any critical entity marks the whole envelope stale.
    expect((body.meta as { stale: boolean }).stale).toBe(true);

    expect(body.data.sync_runs).toHaveLength(1);
    expect(body.data.alerts).toHaveLength(1);

    // Constant authority matrix until authority_states ships (phase 4/7).
    expect(body.data.authority.map((a) => a.capability)).toEqual([
      "people",
      "marketing",
      "scheduling",
      "booking",
      "payments",
    ]);
    for (const entry of body.data.authority) {
      expect(entry.state).toBe("glofox_authoritative");
    }
  });
});
