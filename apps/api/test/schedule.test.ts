import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { TENANT_A, USER_ID, fakeUserClient } from "./fakes.js";

describe("GET /api/v1/schedule/heatmap", () => {
  it("returns fixed aggregate fields with the underlying session disclosure", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const fake = fakeUserClient(
      { tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: "owner" }] }) },
      {
        ask_fill_rate_by_daypart: () => ({
          data: [{ dow: 1, daypart: "morning", sessions: 2, booked: 9, capacity: 12, fill: 0.75 }],
        }),
        ask_schedule_sessions: () => ({
          data: [{ dow: 1, daypart: "morning", session_id: sessionId, name: "Contrast", time_start: "2026-07-13T13:00:00.000Z", booked: 5, capacity: 6 }],
        }),
      },
    );
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });
    const response = await app.request("/api/v1/schedule/heatmap?from=2026-06-19&to=2026-07-18", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        metric: "30-day fill",
        cells: [{ dow: 1, daypart: "morning", sessions: 2, booked: 9, capacity: 12, fill: 0.75, underlying_sessions: [{ session_id: sessionId }] }],
      },
      meta: { definition_version: "fill_rate:v1" },
    });
    for (const call of fake.calls.filter((entry) => entry.method === "rpc")) {
      expect(call.args[0]).toMatchObject({ p_tenant: TENANT_A });
    }
  });
});
