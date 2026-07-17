import { describe, expect, it } from "vitest";
import { envelope } from "@kelo/contracts";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, TENANT_B, USER_ID } from "./fakes.js";

describe("GET /api/v1/auth/me", () => {
  it("returns the caller's memberships from the user-scoped client", async () => {
    const fake = fakeUserClient({
      tenant_users: () => ({
        data: [
          { tenant_id: TENANT_A, role: "owner" },
          { tenant_id: TENANT_B, role: "front_desk" },
        ],
      }),
    });
    const app = createApp({
      verifyAccessToken: async (token) => (token === "good-token" ? { userId: USER_ID } : null),
      createUserClient: () => fake.client,
    });

    const res = await app.request("/api/v1/auth/me", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as unknown;

    // The response validates against the contracts envelope schema.
    const parsed = envelope(
      z.object({
        user_id: z.string().uuid(),
        tenants: z.array(z.object({ tenant_id: z.string().uuid(), role: z.string() })),
      }),
    ).parse(body);

    expect(parsed.data.user_id).toBe(USER_ID);
    expect(parsed.data.tenants).toEqual([
      { tenant_id: TENANT_A, role: "owner" },
      { tenant_id: TENANT_B, role: "front_desk" },
    ]);
    expect(parsed.meta.source).toBe("native");
    expect(parsed.meta.stale).toBe(false);
    expect(parsed.meta.definition_version).toBeNull();
    expect(parsed.meta.correlation_id).toBeTruthy();
  });

  it("401s an invalid token", async () => {
    const app = createApp({
      verifyAccessToken: async () => null,
      createUserClient: () => {
        throw new Error("must not be called for an unverified token");
      },
    });
    const res = await app.request("/api/v1/auth/me", {
      headers: { authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
  });
});
