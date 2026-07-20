import { describe, expect, it } from "vitest";
import { MemberApiError, type MemberResult, type Waiver, type WaiverSignature } from "@kelo/member-core";
import { toSignWaiverOutcome, toWaiverLoad } from "../src/lib/waiver-outcome.js";

/**
 * The waiver code → reason mapping is the "never sign stale" boundary: a
 * version-changed sign must RELOAD, not fall through to a blind retry. These
 * pin it against the API error contract (data-waivers.ts), so dropping or
 * renaming a code branch breaks a test rather than the legal-evidence flow.
 */

const META = {
  as_of: "2026-07-20T12:00:00.000Z",
  source: "native" as const,
  stale: false,
  definition_version: "member-waiver:v1",
  correlation_id: "corr-1",
};

function httpErr<T>(status: number, code?: string): MemberResult<T> {
  return {
    ok: false,
    error: new MemberApiError("http_error", `HTTP ${status}`, {
      status,
      ...(code !== undefined ? { code } : {}),
    }),
  };
}

describe("toWaiverLoad", () => {
  it("maps a needs-signature waiver with version text", () => {
    const res: MemberResult<Waiver> = {
      ok: true,
      value: { needsSignature: true, version: { id: "v1", version: 1, title: "Liability", body: "Assume all risk." } },
      meta: META,
    };
    expect(toWaiverLoad(res)).toEqual({ ok: true, needsSignature: true, title: "Liability", body: "Assume all risk." });
  });

  it("maps a null version (no active waiver) to null title/body", () => {
    const res: MemberResult<Waiver> = { ok: true, value: { needsSignature: false, version: null }, meta: META };
    expect(toWaiverLoad(res)).toEqual({ ok: true, needsSignature: false, title: null, body: null });
  });

  it("maps any failure to { ok: false }", () => {
    expect(toWaiverLoad(httpErr(500))).toEqual({ ok: false });
    const net: MemberResult<Waiver> = { ok: false, error: new MemberApiError("network_error", "offline") };
    expect(toWaiverLoad(net)).toEqual({ ok: false });
  });
});

describe("toSignWaiverOutcome — the code → reason contract (data-waivers.ts)", () => {
  it("ok → ok", () => {
    const res: MemberResult<WaiverSignature> = {
      ok: true,
      value: { signatureId: "s1", waiverVersionId: "v1" },
      meta: META,
    };
    expect(toSignWaiverOutcome(res)).toEqual({ ok: true });
  });

  it("409 waiver_version_changed → version_changed (reload the text, never resubmit stale)", () => {
    expect(toSignWaiverOutcome(httpErr(409, "waiver_version_changed"))).toEqual({
      ok: false,
      reason: "version_changed",
    });
  });

  it("404 waiver_version_not_found → version_changed (the active version vanished)", () => {
    expect(toSignWaiverOutcome(httpErr(404, "waiver_version_not_found"))).toEqual({
      ok: false,
      reason: "version_changed",
    });
  });

  it("422 waiver_sign_invalid → invalid (bad typed name — member fixes it)", () => {
    expect(toSignWaiverOutcome(httpErr(422, "waiver_sign_invalid"))).toEqual({ ok: false, reason: "invalid" });
  });

  it("403 waiver_sign_forbidden and unknown/absent codes → retry", () => {
    expect(toSignWaiverOutcome(httpErr(403, "waiver_sign_forbidden"))).toEqual({ ok: false, reason: "retry" });
    expect(toSignWaiverOutcome(httpErr(500))).toEqual({ ok: false, reason: "retry" });
  });

  it("non-HTTP failures (network/shape) → retry", () => {
    const net: MemberResult<WaiverSignature> = { ok: false, error: new MemberApiError("network_error", "offline") };
    expect(toSignWaiverOutcome(net)).toEqual({ ok: false, reason: "retry" });
  });
});
