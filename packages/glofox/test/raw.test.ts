import { describe, expect, it } from "vitest";
import { canonicalJson, rawPageEnvelope } from "../src/index.js";

describe("rawPageEnvelope (the glofox_raw insert shape)", () => {
  it("stable hash for identical payloads — regardless of key order", () => {
    const meta = { method: "GET", path: "/2.0/members", page: 1 } as const;
    const a = rawPageEnvelope("members.list", meta, {
      x: 1,
      y: [1, 2],
      z: { b: 2, a: 1 },
    });
    const b = rawPageEnvelope("members.list", meta, {
      z: { a: 1, b: 2 },
      y: [1, 2],
      x: 1,
    });
    expect(a.payload_hash).toBe(b.payload_hash);
    expect(a.payload_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("different payloads → different hashes", () => {
    const meta = { method: "GET", path: "/2.0/members" } as const;
    const a = rawPageEnvelope("members.list", meta, { x: 1 });
    const b = rawPageEnvelope("members.list", meta, { x: 2 });
    expect(a.payload_hash).not.toBe(b.payload_hash);
  });

  it("request_meta carries method/path/query/page PLUS namespace presence", () => {
    const report = rawPageEnvelope(
      "analytics.report",
      {
        method: "POST",
        path: "/Analytics/report",
        body: {
          branch_id: "b",
          namespace: "ns",
          start: "0",
          end: "1",
          model: "TransactionsList",
        },
      },
      { TransactionsList: { header: "…", details: [] } },
    );
    expect(report.endpoint).toBe("analytics.report");
    expect(report.request_meta.method).toBe("POST");
    expect(report.request_meta.namespace_present).toBe(true);

    const members = rawPageEnvelope(
      "members.list",
      { method: "GET", path: "/2.0/members", query: { page: 1, limit: 100 }, page: 1 },
      { data: [] },
    );
    expect(members.request_meta.namespace_present).toBe(false);
    expect(members.request_meta.query).toEqual({ page: 1, limit: 100 });
    expect(members.request_meta.page).toBe(1);
  });

  it("canonicalJson sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: 1 })).toBe('{"a":1,"b":[{"c":2,"d":1}]}');
  });
});
