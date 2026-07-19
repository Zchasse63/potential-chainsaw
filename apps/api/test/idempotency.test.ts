import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { KeloSupabaseClient } from "@kelo/db";
import { ApiError } from "../src/errors.js";
import { IDEMPOTENT_REPLAY_HEADER, persistIdempotency } from "../src/middleware/mutation.js";
import type { AppEnv } from "../src/types.js";
import { parseBody } from "../src/validate.js";
import { TENANT_A } from "./fakes.js";

// -- A stateful in-memory fake of the idempotency_keys PostgREST surface ------
// It mirrors the exact builder chains data-billing.ts uses and enforces the
// (tenant_id, key) unique index (a duplicate insert returns code 23505), so the
// middleware's reserve/replay/conflict/release paths run against real state.

interface IdemRow {
  tenant_id: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface FakeBuilder {
  select(columns?: string): FakeBuilder;
  insert(values: Record<string, unknown>): FakeBuilder;
  update(values: Record<string, unknown>): FakeBuilder;
  delete(): FakeBuilder;
  eq(column: string, value: unknown): FakeBuilder;
  is(column: string, value: unknown): FakeBuilder;
  limit(count?: number): FakeBuilder;
  then(resolve: (result: FakeResult) => void): void;
}

function makeIdempotencyClient(): {
  client: KeloSupabaseClient;
  store: Map<string, IdemRow>;
  seed: (row: IdemRow) => void;
} {
  const store = new Map<string, IdemRow>();
  const idOf = (tenant: string, key: string): string => `${tenant}|${key}`;

  function builder(): FakeBuilder {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let values: Record<string, unknown> = {};
    const filters: { col: string; val: unknown }[] = [];

    const matches = (row: IdemRow): boolean =>
      filters.every((f) => (row as unknown as Record<string, unknown>)[f.col] === f.val);

    function execute(): FakeResult {
      if (op === "insert") {
        const tenant = String(values.tenant_id);
        const key = String(values.key);
        const id = idOf(tenant, key);
        if (store.has(id)) return { data: null, error: { message: "duplicate key", code: "23505" } };
        const row: IdemRow = {
          tenant_id: tenant,
          key,
          request_hash: String(values.request_hash),
          response_status: (values.response_status as number | null | undefined) ?? null,
          response_body: "response_body" in values ? values.response_body : null,
        };
        store.set(id, row);
        return {
          data: [
            {
              request_hash: row.request_hash,
              response_status: row.response_status,
              response_body: row.response_body,
            },
          ],
          error: null,
        };
      }
      if (op === "update") {
        for (const row of store.values()) {
          if (!matches(row)) continue;
          if ("response_status" in values) row.response_status = values.response_status as number | null;
          if ("response_body" in values) row.response_body = values.response_body;
        }
        return { data: null, error: null };
      }
      if (op === "delete") {
        for (const [id, row] of [...store.entries()]) if (matches(row)) store.delete(id);
        return { data: null, error: null };
      }
      const rows = [...store.values()].filter(matches).map((r) => ({
        request_hash: r.request_hash,
        response_status: r.response_status,
        response_body: r.response_body,
      }));
      return { data: rows, error: null };
    }

    const api: FakeBuilder = {
      select() {
        if (op !== "insert") op = "select";
        return api;
      },
      insert(v) {
        op = "insert";
        values = v;
        return api;
      },
      update(v) {
        op = "update";
        values = v;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      eq(col, val) {
        filters.push({ col, val });
        return api;
      },
      is(col, val) {
        filters.push({ col, val });
        return api;
      },
      limit() {
        return api;
      },
      then(resolve) {
        resolve(execute());
      },
    };
    return api;
  }

  const client = { from: () => builder() } as unknown as KeloSupabaseClient;
  return { client, store, seed: (row) => store.set(idOf(row.tenant_id, row.key), row) };
}

// A minimal app that mounts persistIdempotency after a tenant is resolved and
// counts how many times the protected handler actually runs.
function makeApp(client: KeloSupabaseClient): { app: Hono<AppEnv>; runs: () => number } {
  let runs = 0;
  const app = new Hono<AppEnv>();
  app.onError((err, c) =>
    c.json({ error: (err as Error).message }, err instanceof ApiError ? err.status : 500),
  );
  app.use("*", async (c, next) => {
    c.set("tenantId", TENANT_A);
    c.set("role", "owner");
    await next();
  });
  app.post("/pay", persistIdempotency(() => client), async (c) => {
    runs += 1;
    return c.json({ ok: true, runs }, 201);
  });
  app.post("/boom", persistIdempotency(() => client), () => {
    runs += 1;
    throw new ApiError(400, "boom", "handler exploded");
  });
  // Proves the middleware's request-body hash (a raw clone) does NOT consume the
  // body: the handler still reads it through the ordinary parseBody path the
  // money routes use.
  app.post("/echo", persistIdempotency(() => client), async (c) => {
    const body = await parseBody(c, z.object({ amount: z.number() }));
    runs += 1;
    return c.json({ echoed: body.amount, runs }, 201);
  });
  return { app, runs: () => runs };
}

const hash = (path: string, body: string): string =>
  createHash("sha256").update(`POST\n${path}\n${body}`).digest("hex");

describe("persistIdempotency - request-level idempotency middleware", () => {
  it("422s when the Idempotency-Key header is absent (no reservation written)", async () => {
    const { client, store } = makeIdempotencyClient();
    const { app, runs } = makeApp(client);
    const res = await app.request("/pay", {
      method: "POST",
      body: JSON.stringify({ amount: 1000 }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("Idempotency-Key");
    expect(runs()).toBe(0);
    expect(store.size).toBe(0);
  });

  it("first call executes once and STORES the response under the key", async () => {
    const { client, store } = makeIdempotencyClient();
    const { app, runs } = makeApp(client);
    const res = await app.request("/pay", {
      method: "POST",
      headers: { "idempotency-key": "k-store" },
      body: JSON.stringify({ amount: 1000 }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(await res.json()).toEqual({ ok: true, runs: 1 });
    expect(runs()).toBe(1);

    const row = [...store.values()][0];
    expect(row?.response_status).toBe(201);
    expect(row?.response_body).toEqual({ ok: true, runs: 1 });
    expect(row?.request_hash).toBe(hash("/pay", JSON.stringify({ amount: 1000 })));
  });

  it("REPLAYS the stored response for the same key + same body without re-executing", async () => {
    const { client } = makeIdempotencyClient();
    const { app, runs } = makeApp(client);
    const send = () =>
      app.request("/pay", {
        method: "POST",
        headers: { "idempotency-key": "k-replay" },
        body: JSON.stringify({ amount: 2500 }),
      });

    const first = await send();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, runs: 1 });

    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe("true");
    // Byte-for-byte the first response, and the handler did NOT run a second time.
    expect(await replay.json()).toEqual({ ok: true, runs: 1 });
    expect(runs()).toBe(1);
  });

  it("409s on the same key with a DIFFERENT body (idempotency_key_conflict)", async () => {
    const { client } = makeIdempotencyClient();
    const { app, runs } = makeApp(client);
    const first = await app.request("/pay", {
      method: "POST",
      headers: { "idempotency-key": "k-conflict" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(first.status).toBe(201);

    const conflict = await app.request("/pay", {
      method: "POST",
      headers: { "idempotency-key": "k-conflict" },
      body: JSON.stringify({ amount: 999 }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toContain("different request");
    // The second, mismatched request never executed the mutation.
    expect(runs()).toBe(1);
  });

  it("409s in_progress when a reservation exists but no response is stored yet", async () => {
    const { client, seed } = makeIdempotencyClient();
    const { app, runs } = makeApp(client);
    const body = JSON.stringify({ amount: 7 });
    // Simulate a concurrent request that reserved the key and is still running.
    seed({
      tenant_id: TENANT_A,
      key: "k-inflight",
      request_hash: hash("/pay", body),
      response_status: null,
      response_body: null,
    });

    const res = await app.request("/pay", {
      method: "POST",
      headers: { "idempotency-key": "k-inflight" },
      body,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("in progress");
    expect(runs()).toBe(0);
  });

  it("does not consume the request body: the handler still reads it via parseBody", async () => {
    const { client, store } = makeIdempotencyClient();
    const { app } = makeApp(client);
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "idempotency-key": "k-echo", "content-type": "application/json" },
      body: JSON.stringify({ amount: 4200 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echoed: 4200, runs: 1 });
    expect([...store.values()][0]?.response_body).toEqual({ echoed: 4200, runs: 1 });
  });

  it("RELEASES the reservation when the handler throws, so a retry re-executes", async () => {
    const { client, store } = makeIdempotencyClient();
    const { app, runs } = makeApp(client);
    const send = () =>
      app.request("/boom", {
        method: "POST",
        headers: { "idempotency-key": "k-boom" },
        body: JSON.stringify({ amount: 1 }),
      });

    const first = await send();
    expect(first.status).toBe(400);
    expect(runs()).toBe(1);
    // The failed request left no reservation behind.
    expect(store.size).toBe(0);

    // A legitimate retry with the same key is allowed to run again.
    const retry = await send();
    expect(retry.status).toBe(400);
    expect(runs()).toBe(2);
  });
});
