import type { MemberResult, Waiver, WaiverSignature } from "@kelo/member-core";
import type { SignWaiverOutcome, WaiverLoad } from "../components/waiver-step.jsx";

/**
 * Pure adapters: member-core waiver results → the WaiverStep's outcome types.
 * Extracted from the route so the status/code → behavior mapping is unit-
 * testable without React (mirrors booking-outcome.ts). No DOM, no network.
 *
 * The sign mapping branches on the API's structured error CODE (data-waivers.ts):
 *   409 waiver_version_changed / 404 waiver_version_not_found → version_changed
 *       (the active version moved under us — reload the text, don't resubmit)
 *   422 waiver_sign_invalid → invalid (bad typed name — let the member fix it)
 *   everything else (403 forbidden, network, shape) → retry
 */

export function toWaiverLoad(res: MemberResult<Waiver>): WaiverLoad {
  if (!res.ok) return { ok: false };
  return {
    ok: true,
    needsSignature: res.value.needsSignature,
    title: res.value.version?.title ?? null,
    body: res.value.version?.body ?? null,
  };
}

export function toSignWaiverOutcome(res: MemberResult<WaiverSignature>): SignWaiverOutcome {
  if (res.ok) return { ok: true };
  const e = res.error;
  if (e.kind === "http_error") {
    if (e.code === "waiver_version_changed" || e.code === "waiver_version_not_found") {
      return { ok: false, reason: "version_changed" };
    }
    if (e.code === "waiver_sign_invalid") {
      return { ok: false, reason: "invalid" };
    }
  }
  return { ok: false, reason: "retry" };
}
