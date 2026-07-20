import {
  inspectEnvelope,
  memberAuthStartBody,
  memberAuthStartResponse,
  memberAuthVerifyBody,
  memberAuthViewSchema,
  type EnvelopeMeta,
  type MemberAuthView,
  type MemberPlatform,
} from "@kelo/contracts";
import type { FetchImpl } from "./client.js";
import { MemberApiError } from "./errors.js";

/**
 * The member auth/claiming client methods (plan-member-app §3.3, unit 8.2b) —
 * the SAME code the web and mobile surfaces call. Pure TS over an injected
 * fetch: no node builtins, no DOM, no Supabase material (the import-guard
 * test enforces it). Hashing, OTP generation, and cookie setting all happen
 * server-side; this module only transports what the member typed.
 *
 * Anti-enumeration note: /auth/start ALWAYS returns the same neutral 202
 * shape, so a successful call means "accepted", never "the contact exists".
 */

export interface StartAuthParams {
  /** API origin (public value, e.g. "" for same-origin proxy). Trailing slashes tolerated. */
  origin: string;
  /** The PUBLIC tenant uuid (client env KELO_TENANT_ID). */
  tenant: string;
  /** Email or US phone, exactly as typed — the API normalizes. */
  contact: string;
  /** Per-call fetch override; wins over the client-level and global fetch. */
  fetchImpl?: FetchImpl;
}

export type StartAuthResult =
  | { ok: true; sent: true; meta: EnvelopeMeta }
  | { ok: false; error: MemberApiError };

export interface VerifyAuthParams {
  origin: string;
  /** The PUBLIC tenant uuid (client env KELO_TENANT_ID). */
  tenant: string;
  /** The same contact the code was sent to. */
  contact: string;
  /** The 6-digit OTP as typed. */
  code: string;
  /** "web" rides the host-only cookie; "ios"/"android" get the token in-body once. */
  platform: MemberPlatform;
  deviceLabel?: string;
  /** Per-call fetch override; wins over the client-level and global fetch. */
  fetchImpl?: FetchImpl;
}

export type VerifyAuthResult =
  | { ok: true; view: MemberAuthView; meta: EnvelopeMeta }
  | { ok: false; error: MemberApiError };

export async function startAuth(
  params: StartAuthParams,
  clientFetch: FetchImpl | undefined,
): Promise<StartAuthResult> {
  const body = memberAuthStartBody.safeParse({ tenant: params.tenant, contact: params.contact });
  if (!body.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "invalid_params",
        `start params failed the body contract: ${body.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }

  const posted = await postMember(
    params.origin,
    "/api/v1/member/auth/start",
    body.data,
    params.fetchImpl ?? clientFetch,
    "start",
  );
  if (!posted.ok) return posted;

  const data = memberAuthStartResponse.safeParse(posted.inspection.data);
  if (!data.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "shape_invalid",
        `start data failed the response contract: ${data.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }
  return { ok: true, sent: true, meta: posted.inspection.meta };
}

export async function verifyAuth(
  params: VerifyAuthParams,
  clientFetch: FetchImpl | undefined,
): Promise<VerifyAuthResult> {
  const body = memberAuthVerifyBody.safeParse({
    tenant: params.tenant,
    contact: params.contact,
    code: params.code,
    platform: params.platform,
    ...(params.deviceLabel !== undefined ? { device_label: params.deviceLabel } : {}),
  });
  if (!body.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "invalid_params",
        `verify params failed the body contract: ${body.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }

  const posted = await postMember(
    params.origin,
    "/api/v1/member/auth/verify",
    body.data,
    params.fetchImpl ?? clientFetch,
    "verify",
  );
  if (!posted.ok) return posted;

  const view = memberAuthViewSchema.safeParse(posted.inspection.data);
  if (!view.success) {
    return {
      ok: false,
      error: new MemberApiError(
        "shape_invalid",
        `verify data failed the response contract: ${view.error.issues[0]?.message ?? "invalid"}`,
      ),
    };
  }
  return { ok: true, view: view.data, meta: posted.inspection.meta };
}

type PostOutcome =
  | { ok: true; inspection: { data: unknown; meta: EnvelopeMeta } }
  | { ok: false; error: MemberApiError };

/** Shared POST + envelope inspection for the member auth endpoints. */
async function postMember(
  origin: string,
  path: string,
  body: unknown,
  fetchImpl: FetchImpl | undefined,
  label: string,
): Promise<PostOutcome> {
  const impl = fetchImpl ?? globalThis.fetch;
  const url = `${origin.replace(/\/+$/, "")}${path}`;

  let response: Response;
  try {
    response = await impl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return {
      ok: false,
      error: new MemberApiError("network_error", `${label} request failed to reach the API`, {
        cause,
      }),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: new MemberApiError("http_error", `${label} request returned HTTP ${response.status}`, {
        status: response.status,
      }),
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    return {
      ok: false,
      error: new MemberApiError("shape_invalid", `${label} response body was not JSON`, { cause }),
    };
  }

  // Provenance-or-nothing (invariant #3): a 2xx without valid freshness meta
  // is a defect, surfaced as envelope_invalid — never rendered.
  const inspection = inspectEnvelope<unknown>(parsed);
  if (!inspection.ok) {
    return {
      ok: false,
      error: new MemberApiError(
        "envelope_invalid",
        `${label} response is missing the freshness envelope meta`,
      ),
    };
  }
  return { ok: true, inspection };
}
