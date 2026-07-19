// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@kelo/contracts";
import { patchEnvelope, postEnvelope } from "../src/lib/api.js";

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
