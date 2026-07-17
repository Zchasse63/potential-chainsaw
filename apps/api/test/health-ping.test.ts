import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// GET /health/ping — PUBLIC dead-man heartbeat + uptime target: no auth, no
// envelope, responds to GET and HEAD.
describe("GET /api/v1/health/ping (public)", () => {
  const app = createApp();

  it("returns 200 { status: 'ok' } with no Authorization header at all", async () => {
    const res = await app.request("/api/v1/health/ping");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; time: string };
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("echoes a correlation id on the response", async () => {
    const res = await app.request("/api/v1/health/ping");
    expect(res.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("reuses a client-supplied correlation id", async () => {
    const res = await app.request("/api/v1/health/ping", {
      headers: { "x-correlation-id": "corr-test-1" },
    });
    expect(res.headers.get("x-correlation-id")).toBe("corr-test-1");
  });

  it("responds to HEAD", async () => {
    const res = await app.request("/api/v1/health/ping", { method: "HEAD" });
    expect(res.status).toBe(200);
  });
});
