// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { ApiRequestError, fetchEnvelope, patchEnvelope, postEnvelope } from "../src/lib/api.js";

/**
 * The mutation transport contract (W3): postEnvelope/patchEnvelope mint a fresh
 * random Idempotency-Key ONLY when the caller passes none; when the caller
 * supplies one (money flows do, per user intent) it is used verbatim so a
 * retried attempt cannot write a second charge. No real network: fetch is faked.
 */

function fakeFetchOk() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: {}, meta: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

function keyOf(fetchMock: ReturnType<typeof fakeFetchOk>, call: number): string | undefined {
  const init = (fetchMock.mock.calls[call] as unknown[])?.[1] as RequestInit;
  return (init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("postEnvelope / patchEnvelope idempotency key", () => {
  it("uses the caller-supplied key VERBATIM across attempts (money-flow retry safety)", async () => {
    const fetchMock = fakeFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    await postEnvelope("/pos/checkout", "tok", { a: 1 }, undefined, "intent-key-1");
    await postEnvelope("/pos/checkout", "tok", { a: 1 }, undefined, "intent-key-1");

    expect(keyOf(fetchMock, 0)).toBe("intent-key-1");
    expect(keyOf(fetchMock, 1)).toBe("intent-key-1");
  });

  it("mints a DIFFERENT random key per attempt when none is supplied (low-risk flows)", async () => {
    const fetchMock = fakeFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    await postEnvelope("/anything", "tok", { a: 1 });
    await postEnvelope("/anything", "tok", { a: 1 });

    expect(keyOf(fetchMock, 0)).not.toBe(keyOf(fetchMock, 1));
  });

  it("does not let an extraHeader shadow the explicit idempotency key", async () => {
    const fetchMock = fakeFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    await postEnvelope(
      "/pos/checkout",
      "tok",
      { a: 1 },
      { [IDEMPOTENCY_KEY_HEADER]: "sneaky-override" },
      "intent-key-1",
    );

    expect(keyOf(fetchMock, 0)).toBe("intent-key-1");
  });

  it("patchEnvelope threads an explicit key too", async () => {
    const fetchMock = fakeFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    await patchEnvelope("/catalog/x", "tok", { a: 1 }, "patch-key-1");
    expect(keyOf(fetchMock, 0)).toBe("patch-key-1");
  });
});

// WS-8d — the error transport contract: every non-2xx must reach the caller as
// an ApiRequestError carrying the fields the UI shows (status + code + the
// correlation id an operator quotes to support). Untested until now.
describe("requestEnvelope error mapping", () => {
  function respondWith(body: unknown, status: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
        ),
      ),
    );
  }

  it("maps a STRUCTURED error body to ApiRequestError with status/code/message/correlation-id", async () => {
    respondWith(
      { error: { code: "insufficient_credits", message: "You have no credits.", correlation_id: "corr-err-1" } },
      422,
    );
    const err = (await postEnvelope("/pos/checkout", "tok", { a: 1 }).catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("insufficient_credits");
    expect(err.message).toBe("You have no credits.");
    expect(err.correlationId).toBe("corr-err-1");
  });

  it("falls back to http_error (no correlation id) when the error body is unstructured", async () => {
    respondWith({ oops: "not our envelope" }, 500);
    const err = (await fetchEnvelope("/staff", "tok").catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(500);
    expect(err.code).toBe("http_error");
    expect(err.correlationId).toBeUndefined();
  });

  it("maps a fetch/network failure to a status-0 network_error (never a silent hang)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("dns fail"))));
    const err = (await fetchEnvelope("/staff", "tok").catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
  });
});
