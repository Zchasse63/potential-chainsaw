import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createGlofoxClient } from "../src/index.js";
import { jsonResponse, loadSample, noSleep, stubFetch, testConfig } from "./helpers.js";

/**
 * Every wrapper parses its PINNED SAMPLE (docs/glofox/samples/) replayed
 * verbatim through a stubbed fetch — NO network, ever.
 */
describe("endpoint wrappers parse the pinned samples", () => {
  it("members.list ← members.get.limit2.json (Style A)", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse(loadSample("members.get.limit2.json")),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const res = await client.members.list({ activeFilter: "any", limit: 2 });
    expect(res.object).toBe("list");
    expect(res.total_count).toBe(1366);
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.created).toBeInstanceOf(Date);
    expect(res.data[0]!.membership.type).toBe("payg");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/prod/2.0/members");
    expect(url.searchParams.get("active")).toBe("any");
    expect(url.searchParams.get("limit")).toBe("2");
  });

  it("members.list sends the incremental-sync watermarks as unix seconds", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse(loadSample("members.get.limit2.json")),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    await client.members.list({
      utcModifiedStartDate: new Date("2026-07-01T00:00:00Z"),
      utcModifiedEndDate: new Date("2026-07-17T00:00:00Z"),
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("utc_modified_start_date")).toBe(
      String(Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000)),
    );
    expect(url.searchParams.get("utc_modified_end_date")).toBe(
      String(Math.floor(Date.parse("2026-07-17T00:00:00Z") / 1000)),
    );
  });

  it("members.get ← the list sample's first row (bare member object)", async () => {
    const list = loadSample("members.get.limit2.json") as { data: Record<string, unknown>[] };
    const row = list.data[0]!;
    const userId = String(row._id);
    const { calls, fetchImpl } = stubFetch(() => jsonResponse(row));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const member = await client.members.get(userId);
    expect(member._id).toBe(userId);
    expect(member.created).toBeInstanceOf(Date);
    expect(new URL(calls[0]!.url).pathname).toBe(`/prod/2.0/members/${userId}`);
  });

  it("memberships.list ← memberships.get.json", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(loadSample("memberships.get.json")));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const res = await client.memberships.list();
    expect(res.object).toBe("list");
    expect(res.data).toHaveLength(6);
    expect(res.data[0]!.plans[0]!.code).toBeTypeOf("number");
  });

  it("credits.forUser ← credits.get.nonempty.json", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse(loadSample("credits.get.nonempty.json")),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const res = await client.credits.forUser("user-1");
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.available).toBe(1);
    // Absent end_date survives as undefined — callers treat it as no_expiry.
    expect(res.data[0]!.end_date).toBeUndefined();
    expect(res.data[0]!.start_date).toBeInstanceOf(Date);
    expect(new URL(calls[0]!.url).searchParams.get("user_id")).toBe("user-1");
  });

  it("credits.forUser ← credits.get.json (the empty pack list is a valid page)", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(loadSample("credits.get.json")));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const res = await client.credits.forUser("user-1");
    expect(res.data).toHaveLength(0);
    expect(res.total_count).toBe(0);
    expect(res.has_more).toBe(false);
  });

  it("bookings.list ← bookings.get.limit3.json (Style B)", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse(loadSample("bookings.get.limit3.json")),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const res = await client.bookings.list({ status: "BOOKED", eventType: "events", limit: 3 });
    expect(res.success).toBe(true);
    expect(res.meta.totalCount).toBe(6);
    expect(res.data).toHaveLength(3);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/prod/2.2/branches/${testConfig.branchId}/bookings`);
    expect(url.searchParams.get("status")).toBe("BOOKED");
    expect(url.searchParams.get("event_type")).toBe("events");
  });

  it("events.list ← events.get.limit2.json", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse(loadSample("events.get.limit2.json")),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const res = await client.events.list({ limit: 2 });
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.size).toBe(12);
    expect(res.data[0]!.booked).toBe(1);
    expect(res.data[0]!.time_start).toBeInstanceOf(Date);
    expect(new URL(calls[0]!.url).pathname).toBe(
      `/prod/2.0/branches/${testConfig.branchId}/events`,
    );
  });

  it("branch.get ← branch.get.json", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(loadSample("branch.get.json")));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const branch = await client.branch.get();
    expect(branch.address.timezone_id).toBe("America/New_York");
    expect(branch.address.currency).toBe("USD");
  });

  it("transactionsReport ← analytics.report.30d.json (Style C, 56 rows)", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(loadSample("analytics.report.30d.json")));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const report = await client.transactionsReport({
      start: new Date("2026-06-17T00:00:00Z"),
      end: new Date("2026-07-17T00:00:00Z"),
    });
    expect(report.TransactionsList.details).toHaveLength(56);
  });

  it("transactionsReport: an EMPTY details array is a legitimate Style C response", async () => {
    // Style C has no success field, so trap-1 detection does not apply; the
    // zero-row tripwire lives in the sync layer (phase 1.4), not the client.
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ TransactionsList: { header: "…", details: [] } }),
    );
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const report = await client.transactionsReport({
      start: new Date("2026-06-17T00:00:00Z"),
      end: new Date("2026-07-17T00:00:00Z"),
    });
    expect(report.TransactionsList.details).toHaveLength(0);
  });

  it("unknown/malformed payload → the ZodError propagates (never silently stripped)", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ totally: "unexpected" }));
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    await expect(client.members.list()).rejects.toBeInstanceOf(ZodError);
  });
});

describe("pagination (README §2 — page-based, 1-indexed)", () => {
  it("Style A: listAllPages follows has_more across 3 pages", async () => {
    const page1 = loadSample("members.get.limit2.json") as Record<string, unknown>;
    expect(page1.has_more).toBe(true); // the sample IS a valid page-1 template
    const pages: Record<string, unknown>[] = [
      page1,
      { ...page1, page: 2, has_more: true },
      { ...page1, page: 3, has_more: false },
    ];
    const { calls, fetchImpl } = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return jsonResponse(pages[page - 1]);
    });
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const seenPages: number[] = [];
    let rows = 0;
    for await (const page of client.members.listAllPages({ limit: 2 })) {
      seenPages.push(page.page);
      rows += page.data.length;
    }
    expect(seenPages).toEqual([1, 2, 3]);
    expect(rows).toBe(6);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("Style B: listAllPages pages via meta.totalCount math (no has_more)", async () => {
    const page1 = loadSample("bookings.get.limit3.json") as Record<string, unknown>;
    const pages: Record<string, unknown>[] = [
      page1,
      { ...page1, meta: { totalCount: 6, page: 2, limit: 3 } },
    ];
    const { calls, fetchImpl } = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return jsonResponse(pages[page - 1]);
    });
    const client = createGlofoxClient(testConfig, { fetchImpl, sleep: noSleep });
    const seenPages: number[] = [];
    let rows = 0;
    for await (const page of client.bookings.listAllPages({ limit: 3 })) {
      seenPages.push(page.meta.page);
      rows += page.data.length;
    }
    expect(seenPages).toEqual([1, 2]); // totalCount 6 ÷ limit 3 → exactly 2 pages
    expect(rows).toBe(6);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });
});
