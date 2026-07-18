import { describe, expect, it } from "vitest";
import {
  buildAnalyticsReportRequest,
  createGlofoxClient,
  glofoxConfigFromEnv,
  GlofoxAuthError,
  GlofoxHttpError,
  GlofoxRateLimitError,
  GlofoxSuccessFalseError,
} from "../src/index.js";
import { jsonResponse, loadSample, noSleep, stubFetch, testConfig } from "./helpers.js";

describe("glofoxConfigFromEnv", () => {
  const fullEnv: Record<string, string> = {
    GLOFOX_BASE_URL: "https://gf-api.aws.glofox.com/prod/",
    GLOFOX_API_KEY: "fake-key",
    GLOFOX_API_TOKEN: "fake-token",
    GLOFOX_BRANCH_ID: "fake-branch",
    GLOFOX_NAMESPACE: "fake-namespace",
  };

  it("reads the five GLOFOX_* vars by name", () => {
    const config = glofoxConfigFromEnv(fullEnv);
    expect(config).toEqual({
      baseUrl: fullEnv.GLOFOX_BASE_URL,
      apiKey: "fake-key",
      apiToken: "fake-token",
      branchId: "fake-branch",
      namespace: "fake-namespace",
    });
  });

  it("throws naming every missing var — values never appear in the error", () => {
    const partial = { ...fullEnv };
    delete partial.GLOFOX_API_KEY;
    delete partial.GLOFOX_NAMESPACE;
    let err: unknown;
    try {
      glofoxConfigFromEnv(partial);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("GLOFOX_API_KEY");
    expect(message).toContain("GLOFOX_NAMESPACE");
    expect(message).not.toContain("GLOFOX_BASE_URL");
    // Values are secrets: present values must never leak into the message.
    expect(message).not.toContain("fake-token");
    expect(message).not.toContain("gf-api.aws.glofox.com");
  });
});

describe("glofoxFetch transport", () => {
  it("sends the three auth headers on every request (README §1)", async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(loadSample("branch.get.json")));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    await client.branch.get();
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.headers;
    expect(headers["x-glofox-branch-id"]).toBe(testConfig.branchId);
    expect(headers["x-api-key"]).toBe(testConfig.apiKey);
    expect(headers["x-glofox-api-token"]).toBe(testConfig.apiToken);
  });

  it("trap 1: HTTP 200 with success:false → GlofoxSuccessFalseError (no retry)", async () => {
    // Exactly the vendor trap (README §3): the STATUS says OK, the body says no.
    const body = { data: [], success: false, meta: { totalCount: 0, page: 1, limit: 3 } };
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(body, 200));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const err = await client.bookings.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlofoxSuccessFalseError);
    expect((err as GlofoxSuccessFalseError).endpoint).toContain("bookings");
    expect(calls).toHaveLength(1); // an error dressed as OK is not transient
  });

  it("429 → retries with backoff, then succeeds", async () => {
    let n = 0;
    const { calls, fetchImpl } = stubFetch(() => {
      n += 1;
      return n === 1
        ? jsonResponse({ message: "slow down" }, 429, { "retry-after": "1" })
        : jsonResponse(loadSample("branch.get.json"));
    });
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const branch = await client.branch.get();
    expect(branch.address.timezone_id).toBe("America/New_York");
    expect(calls).toHaveLength(2);
  });

  it("429 past maxRetries → GlofoxRateLimitError carrying retry-after", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse({ message: "slow down" }, 429, { "retry-after": "2" }),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep, maxRetries: 2 });
    const err = await client.branch.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlofoxRateLimitError);
    expect((err as GlofoxRateLimitError).status).toBe(429);
    expect((err as GlofoxRateLimitError).retryAfterMs).toBe(2000);
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
  });

  it("500 → retries, then succeeds", async () => {
    let n = 0;
    const { calls, fetchImpl } = stubFetch(() => {
      n += 1;
      return n === 1
        ? jsonResponse({ message: "boom" }, 500)
        : jsonResponse(loadSample("branch.get.json"));
    });
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    await client.branch.get();
    expect(calls).toHaveLength(2);
  });

  it("network error → retries with the same policy", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      return jsonResponse(loadSample("branch.get.json"));
    }) as typeof fetch;
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    await client.branch.get();
    expect(n).toBe(2);
  });

  it("400 → GlofoxHttpError immediately, NO retry", async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonResponse({ message: "bad request" }, 400));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const err = await client.branch.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlofoxHttpError);
    expect((err as GlofoxHttpError).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it.each([401, 403])(
    "%i → GlofoxAuthError (the import-pause signal), no retry",
    async (status) => {
      const { calls, fetchImpl } = stubFetch(() =>
        jsonResponse({ message: "unauthorized" }, status),
      );
      const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
      const err = await client.branch.get().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GlofoxAuthError);
      expect((err as GlofoxAuthError).status).toBe(status);
      expect(calls).toHaveLength(1);
    },
  );

  it("error bodies are truncated to a ≤200-char snippet", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ message: "x".repeat(500) }, 400));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const err = await client.branch.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlofoxHttpError);
    expect((err as GlofoxHttpError).bodySnippet.length).toBeLessThanOrEqual(200);
  });
});

describe("rate budget (README §1: 10 req/s)", () => {
  it("25 concurrent calls never exceed 10 in any 1s window", async () => {
    let t = 0;
    const { calls, fetchImpl } = stubFetch(
      () => jsonResponse(loadSample("branch.get.json")),
      () => t,
    );
    const client = createGlofoxClient(testConfig, {
      fetchImpl,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    // Concurrent on purpose: the pacer must serialize slots across callers.
    await Promise.all(Array.from({ length: 25 }, () => client.branch.get()));
    expect(calls).toHaveLength(25);
    expect(calls[24]!.atMs).toBe(2400); // 25 slots × 100ms, first at t=0
    for (const call of calls) {
      const inWindow = calls.filter((c) => c.atMs >= call.atMs && c.atMs < call.atMs + 1000);
      expect(inWindow.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("trap 2 — the Analytics namespace (README §3)", () => {
  it("the transactionsReport request body ALWAYS carries namespace", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse(loadSample("analytics.report.30d.json")),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    await client.transactionsReport({
      start: new Date("2026-06-17T00:00:00Z"),
      end: new Date("2026-07-17T00:00:00Z"),
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://gf-api.aws.glofox.com/prod/Analytics/report");
    const body = call.body as Record<string, unknown>;
    expect(body).toMatchObject({
      branch_id: testConfig.branchId,
      namespace: testConfig.namespace,
      model: "TransactionsList",
    });
    // start/end travel as unix-second STRINGS (README §4).
    expect(body.start).toMatch(/^\d+$/);
    expect(body.end).toMatch(/^\d+$/);
    // Auth headers on the POST too — every request.
    expect(call.headers["x-api-key"]).toBe(testConfig.apiKey);
    expect(call.headers["x-glofox-api-token"]).toBe(testConfig.apiToken);
  });

  it("namespace is non-optional at the type level (permanent regression)", () => {
    const request = buildAnalyticsReportRequest({
      branch_id: "b",
      namespace: "n",
      start: "0",
      end: "1",
      model: "TransactionsList",
    });
    expect(request.namespace).toBe("n");
    const omitted = () =>
      // @ts-expect-error — TRAP 2: omitting `namespace` silently empties the report (README §3).
      buildAnalyticsReportRequest({
        branch_id: "b",
        start: "0",
        end: "1",
        model: "TransactionsList",
      });
    void omitted; // compile-time check only — never invoked
  });
});
