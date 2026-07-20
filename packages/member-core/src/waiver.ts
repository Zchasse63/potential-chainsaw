import { memberWaiverSignResponse, memberWaiverView } from "@kelo/contracts";
import type { FetchImpl } from "./client.js";
import type { MemberResult } from "./booking.js";
import { MemberApiError } from "./errors.js";
import { memberRequest } from "./http.js";

/**
 * The member self-serve waiver client (unit 8.3i) — the SAME code web and
 * mobile call. Session-scoped (the cookie / mobile Bearer carries the session);
 * signing carries NO version id (the API resolves the active version
 * server-side) and NO idempotency key (the RPC is idempotent per active
 * version, and it is not a money mutation). Pure TS over the injected fetch —
 * no zod import, no DOM, no Supabase material.
 */

interface SessionCall {
  origin: string;
  /** Mobile session token; omit on web (the cookie carries it). */
  token?: string;
  fetchImpl?: FetchImpl;
}

export interface WaiverVersionView {
  id: string;
  version: number;
  title: string | null;
  body: string;
}
export interface Waiver {
  needsSignature: boolean;
  /** null when the studio has published no active waiver. */
  version: WaiverVersionView | null;
}
export interface WaiverSignature {
  signatureId: string;
  waiverVersionId: string;
}

/** GET /member/waiver — the active waiver text + whether this member must sign. */
export async function fetchWaiver(
  params: SessionCall,
  clientFetch?: FetchImpl,
): Promise<MemberResult<Waiver>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/waiver",
      method: "GET",
      token: params.token,
      fetchImpl: params.fetchImpl,
      label: "waiver",
    },
    clientFetch,
  );
  if (!out.ok) return out;
  const parsed = memberWaiverView.safeParse(out.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "shape_invalid",
        `waiver response failed the contract: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }
  return {
    ok: true,
    value: { needsSignature: parsed.data.needs_signature, version: parsed.data.version },
    meta: out.meta,
  };
}

/** POST /member/waiver/sign — typed name + acknowledgement (active version
 * resolved server-side). No idempotency key (not a money mutation). */
export async function signWaiver(
  params: SessionCall & { typedName: string },
  clientFetch?: FetchImpl,
): Promise<MemberResult<WaiverSignature>> {
  const out = await memberRequest(
    {
      origin: params.origin,
      path: "/api/v1/member/waiver/sign",
      method: "POST",
      body: { typed_name: params.typedName, acknowledged: true },
      token: params.token,
      fetchImpl: params.fetchImpl,
      label: "waiver-sign",
    },
    clientFetch,
  );
  if (!out.ok) return out;
  const parsed = memberWaiverSignResponse.safeParse(out.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "shape_invalid",
        `waiver-sign response failed the contract: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }
  return {
    ok: true,
    value: { signatureId: parsed.data.signature_id, waiverVersionId: parsed.data.waiver_version_id },
    meta: out.meta,
  };
}
