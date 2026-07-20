import { describe, expect, it } from "vitest";
import { fetchWaiver, signWaiver } from "../src/index.js";

/**
 * member-core waiver client (unit 8.3i) — fake fetch ONLY, zero network.
 * signWaiver carries NO version id (the API resolves the active version) and NO
 * Idempotency-Key (not a money mutation) — both asserted below, since every
 * other member mutation DOES carry a key.
 */

const ORIGIN = "https://member.example";
const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNATURE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const META = {
  as_of: "2026-07-20T12:00:00.000Z",
  source: "native",
  stale: false,
  definition_version: "member-waiver:v1",
  correlation_id: "corr-1",
};

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function capturingFetch(data: unknown): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body != null ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: META }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("fetchWaiver", () => {
  it("GETs /member/waiver and maps the active version + needs_signature", async () => {
    const { fetchImpl, seen } = capturingFetch({
      needs_signature: true,
      version: { id: VERSION, version: 1, title: "Liability", body: "You assume all risk." },
    });
    const res = await fetchWaiver({ origin: ORIGIN, fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.needsSignature).toBe(true);
      expect(res.value.version?.id).toBe(VERSION);
      expect(res.value.version?.body).toContain("assume all risk");
    }
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/v1/member/waiver`);
    expect(seen[0]?.method).toBe("GET");
  });

  it("maps a null version (no active waiver published)", async () => {
    const { fetchImpl } = capturingFetch({ needs_signature: false, version: null });
    const res = await fetchWaiver({ origin: ORIGIN, fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.version).toBeNull();
      expect(res.value.needsSignature).toBe(false);
    }
  });
});

describe("signWaiver", () => {
  it("POSTs typed_name + acknowledged, with NO version id and NO Idempotency-Key", async () => {
    const { fetchImpl, seen } = capturingFetch({ signature_id: SIGNATURE, waiver_version_id: VERSION });
    const res = await signWaiver({ origin: ORIGIN, typedName: "Jane Member", fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.signatureId).toBe(SIGNATURE);
      expect(res.value.waiverVersionId).toBe(VERSION);
    }
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/v1/member/waiver/sign`);
    expect(seen[0]?.method).toBe("POST");
    // The active version is resolved server-side — the client sends only these.
    expect(seen[0]?.body).toEqual({ typed_name: "Jane Member", acknowledged: true });
    expect(seen[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("mobile: attaches the session token as Authorization: Bearer", async () => {
    const { fetchImpl, seen } = capturingFetch({ signature_id: SIGNATURE, waiver_version_id: VERSION });
    await signWaiver({ origin: ORIGIN, typedName: "Jane", token: "kmb_mobiletoken", fetchImpl });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer kmb_mobiletoken");
  });

  it("rejects a 2xx WITHOUT the freshness envelope (provenance-or-nothing)", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ signature_id: SIGNATURE, waiver_version_id: VERSION }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    const res = await signWaiver({ origin: ORIGIN, typedName: "Jane", fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("envelope_invalid");
  });
});
