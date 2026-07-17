import { describe, expect, it } from "vitest";
import { errorResponseSchema } from "@kelo/contracts";
import { createApp } from "../src/app.js";
import { fakeUserClient, TENANT_A, USER_ID } from "./fakes.js";

// app.onError: any thrown error becomes a structured ErrorResponse with the
// correlation id and a NON-200 status — never 200-with-failure.
describe("error handler", () => {
  it("maps an unexpected throw to 500 + generic message (detail stays server-side)", async () => {
    const app = createApp();
    app.get("/__boom", () => {
      throw new Error("boom: secret internal detail");
    });

    const res = await app.request("/api/v1/__boom", {
      headers: { "x-correlation-id": "corr-boom" },
    });
    expect(res.status).toBe(500);

    const body = (await res.json()) as ReturnType<typeof errorResponseSchema.parse>;
    expect(() => errorResponseSchema.parse(body)).not.toThrow();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("internal server error");
    expect(body.error.message).not.toContain("secret internal detail");
    expect(body.error.correlation_id).toBe("corr-boom");
    expect(res.headers.get("x-correlation-id")).toBe("corr-boom");
  });

  it("maps a Zod request-validation failure to 422 with issues in details", async () => {
    const fake = fakeUserClient({
      tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role: "owner" }] }),
    });
    const app = createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    });

    const res = await app.request("/api/v1/tenant/invitations", {
      method: "POST",
      headers: {
        authorization: "Bearer good-token",
        "content-type": "application/json",
        "idempotency-key": "key-1",
      },
      body: JSON.stringify({ email: "not-an-email", role: "wizard" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ReturnType<typeof errorResponseSchema.parse>;
    expect(() => errorResponseSchema.parse(body)).not.toThrow();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toBeDefined();
  });

  it("unknown routes get a structured 404", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ReturnType<typeof errorResponseSchema.parse>;
    expect(() => errorResponseSchema.parse(body)).not.toThrow();
    expect(body.error.code).toBe("not_found");
  });
});
