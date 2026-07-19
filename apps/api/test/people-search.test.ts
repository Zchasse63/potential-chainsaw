import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeUserClient, type RecordedCall, TENANT_A, USER_ID } from "./fakes.js";

// Obviously-synthetic directory rows (invariant: NEVER seed realistic PII into
// tests). Names/emails/phones are placeholders, not real member data.
const ROW_ONE = {
  id: "26000000-0000-4000-8000-000000000001",
  first_name: "Testa",
  last_name: "Alpha",
  email: "testa@example.test",
  phone_e164: "+15550000001",
  source: "native" as const,
};
const ROW_TWO = {
  id: "26000000-0000-4000-8000-000000000002",
  first_name: "Testb",
  last_name: "Bravo",
  email: "testb@example.test",
  phone_e164: "+15550000002",
  source: "glofox" as const,
};
const ROW_THREE = {
  id: "26000000-0000-4000-8000-000000000003",
  first_name: "Testc",
  last_name: "Charlie",
  email: "testc@example.test",
  phone_e164: "+15550000003",
  source: "glofox" as const,
};

type Role = "owner" | "manager" | "front_desk" | "trainer";

function build(role: Role = "front_desk", peopleRows: unknown[] = [ROW_ONE]) {
  const fake = fakeUserClient({
    tenant_users: () => ({ data: [{ tenant_id: TENANT_A, role }] }),
    people: () => ({ data: peopleRows }),
  });
  return {
    fake,
    app: createApp({
      verifyAccessToken: async () => ({ userId: USER_ID }),
      createUserClient: () => fake.client,
    }),
  };
}

const auth = { authorization: "Bearer token" };

/** The single `.or(...)` filter string the search built for the people table. */
function orFilter(calls: RecordedCall[]): string {
  const call = calls.find((c) => c.table === "people" && c.method === "or");
  return typeof call?.args[0] === "string" ? call.args[0] : "";
}

describe("GET /people/search (Quick Book desk search)", () => {
  it("403s a trainer and never touches the people table", async () => {
    const { app, fake } = build("trainer");
    const response = await app.request("/api/v1/people/search?q=test", { headers: auth });
    expect(response.status).toBe(403);
    expect(fake.calls.some((c) => c.table === "people")).toBe(false);
  });

  it.each(["owner", "manager", "front_desk"] as const)("allows %s", async (role) => {
    const { app } = build(role);
    const response = await app.request("/api/v1/people/search?q=test", { headers: auth });
    expect(response.status).toBe(200);
  });

  it("422s a query shorter than 2 characters after trimming (no enumeration)", async () => {
    const { app, fake } = build();
    const response = await app.request("/api/v1/people/search?q=%20a%20", { headers: auth });
    expect(response.status).toBe(422);
    expect(fake.calls.some((c) => c.table === "people")).toBe(false);
  });

  it("422s a limit above the cap of 20", async () => {
    const { app } = build();
    const response = await app.request("/api/v1/people/search?q=test&limit=21", { headers: auth });
    expect(response.status).toBe(422);
  });

  it("builds tenant-scoped name/email ilike filters over the safe columns", async () => {
    const { app, fake } = build("front_desk", [ROW_ONE]);
    const response = await app.request("/api/v1/people/search?q=Test", { headers: auth });
    expect(response.status).toBe(200);

    const filter = orFilter(fake.calls);
    expect(filter).toContain("first_name.ilike.*Test*");
    expect(filter).toContain("last_name.ilike.*Test*");
    expect(filter).toContain("email.ilike.Test*");
    // A pure name query must NOT reach for the phone column.
    expect(filter).not.toContain("phone_e164");

    const select = fake.calls.find((c) => c.table === "people" && c.method === "select");
    expect(select?.args[0]).toBe("id, first_name, last_name, email, phone_e164, source");
    expect(
      fake.calls.some(
        (c) => c.table === "people" && c.method === "eq" && c.args[0] === "tenant_id",
      ),
    ).toBe(true);
  });

  it("matches phone_e164 for a digits-only input", async () => {
    const { app, fake } = build("front_desk", [ROW_ONE]);
    const response = await app.request("/api/v1/people/search?q=5550000001", { headers: auth });
    expect(response.status).toBe(200);
    expect(orFilter(fake.calls)).toContain("phone_e164.ilike.*5550000001*");
  });

  it("strips digit separators so a formatted phone still matches phone_e164", async () => {
    const { app, fake } = build("front_desk", [ROW_ONE]);
    const response = await app.request("/api/v1/people/search?q=555-000", { headers: auth });
    expect(response.status).toBe(200);
    expect(orFilter(fake.calls)).toContain("phone_e164.ilike.*555000*");
  });

  it("refuses a bare-underscore probe without touching the people table", async () => {
    // `_` is LIKE's single-char wildcard; unsanitized, q=__ passes the 2-char
    // minimum yet ILIKE-matches every row — a blind directory enumeration.
    const { app, fake } = build("front_desk", [ROW_ONE, ROW_TWO]);
    const response = await app.request("/api/v1/people/search?q=__", { headers: auth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { people: unknown[] } };
    expect(body.data.people).toHaveLength(0);
    expect(fake.calls.some((c) => c.table === "people")).toBe(false);
  });

  it("strips embedded underscores from the ilike term (near-miss, never wildcard)", async () => {
    const { app, fake } = build("front_desk", []);
    const response = await app.request("/api/v1/people/search?q=te_st", { headers: auth });
    expect(response.status).toBe(200);
    const filter = orFilter(fake.calls);
    expect(filter).toContain("first_name.ilike.*test*");
    expect(filter).not.toContain("te_st");
  });

  it("caps results at limit and flags truncated when more matched", async () => {
    const { app } = build("front_desk", [ROW_ONE, ROW_TWO, ROW_THREE]);
    const response = await app.request("/api/v1/people/search?q=Test&limit=2", { headers: auth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { people: unknown[]; truncated: boolean } };
    expect(body.data.people).toHaveLength(2);
    expect(body.data.truncated).toBe(true);
  });

  it("returns all matches un-truncated when within limit, in a native envelope", async () => {
    const { app } = build("front_desk", [ROW_ONE, ROW_TWO]);
    const response = await app.request("/api/v1/people/search?q=Test", { headers: auth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { people: unknown[]; truncated: boolean };
      meta: { source: string; definition_version: string };
    };
    expect(body.data.people).toHaveLength(2);
    expect(body.data.truncated).toBe(false);
    expect(body.meta.source).toBe("native");
    expect(body.meta.definition_version).toBe("people-search:v1");
  });
});
